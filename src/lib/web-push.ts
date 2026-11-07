import "server-only";

const encoder = new TextEncoder();

function base64UrlBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64Url(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function joinBytes(...parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

async function hmac(keyBytes: Uint8Array, value: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", toArrayBuffer(keyBytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, toArrayBuffer(value)));
}

async function ecdh(receiverPublicKey: Uint8Array) {
  const receiver = await crypto.subtle.importKey("raw", toArrayBuffer(receiverPublicKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: receiver }, ephemeral.privateKey, 256));
  return { publicKey, sharedSecret };
}

async function encryptPayload(subscription: { p256dh: string; auth: string }, payload: string) {
  const receiverPublicKey = base64UrlBytes(subscription.p256dh);
  const authSecret = base64UrlBytes(subscription.auth);
  const { publicKey: senderPublicKey, sharedSecret } = await ecdh(receiverPublicKey);
  const authPrk = await hmac(authSecret, sharedSecret);
  const keyInfo = joinBytes(encoder.encode("WebPush: info\0"), receiverPublicKey, senderPublicKey);
  const inputKeyMaterial = await hmac(authPrk, joinBytes(keyInfo, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentPrk = await hmac(salt, inputKeyMaterial);
  const contentKey = (await hmac(contentPrk, joinBytes(encoder.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(contentPrk, joinBytes(encoder.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const aesKey = await crypto.subtle.importKey("raw", toArrayBuffer(contentKey), "AES-GCM", false, ["encrypt"]);
  const plaintext = joinBytes(encoder.encode(payload), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(nonce), tagLength: 128 }, aesKey, toArrayBuffer(plaintext)));
  const recordSize = new Uint8Array([0, 0, 16, 0]);
  return joinBytes(salt, recordSize, new Uint8Array([senderPublicKey.length]), senderPublicKey, ciphertext);
}

async function vapidAuthorization(endpoint: string, publicKey: string, privateKey: string) {
  const rawPublic = base64UrlBytes(publicKey);
  if (rawPublic.length !== 65 || rawPublic[0] !== 4) throw new Error("VAPID public key must be an uncompressed P-256 key.");
  const jwk = {
    kty: "EC", crv: "P-256", x: base64Url(rawPublic.slice(1, 33)), y: base64Url(rawPublic.slice(33, 65)),
    d: base64Url(base64UrlBytes(privateKey)), ext: true,
  };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = base64Url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const origin = new URL(endpoint).origin;
  const claims = base64Url(encoder.encode(JSON.stringify({ aud: origin, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub: "mailto:jaafar@imamalicenter.org" })));
  const content = `${header}.${claims}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, toArrayBuffer(encoder.encode(content))));
  return `vapid t=${content}.${base64Url(signature)}, k=${publicKey}`;
}

export async function sendWebPush(subscription: { endpoint: string; p256dh: string; auth: string }, payload: string) {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return { ok: false, expired: false, reason: "Push delivery is not configured." };
  try {
    const body = await encryptPayload(subscription, payload);
    const response = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidAuthorization(subscription.endpoint, publicKey, privateKey),
        "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Urgency: "high",
      },
      body,
    });
    return { ok: response.ok, expired: response.status === 404 || response.status === 410, reason: response.ok ? undefined : `Push provider returned ${response.status}.` };
  } catch {
    return { ok: false, expired: false, reason: "Push delivery failed." };
  }
}
