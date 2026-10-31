"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, KeyRound } from "lucide-react";

export default function SetPasswordPage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const invalidLink = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("error");
  const [message, setMessage] = useState(invalidLink ? "This link has expired or is invalid. Ask an administrator to send a new one." : "");
  const [error, setError] = useState(invalidLink);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const password = String(values.get("password") ?? "");
    const confirmation = String(values.get("confirmation") ?? "");
    if (password !== confirmation) { setError(true); setMessage("The passwords do not match."); return; }
    setBusy(true); setError(false); setMessage("");
    try {
      const response = await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "update_password", password }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "The password could not be saved.");
      setMessage("Your password is ready. Opening the media operations app…");
      window.setTimeout(() => router.push("/"), 700);
    } catch (cause) {
      setError(true);
      setMessage(cause instanceof Error ? cause.message : "The password could not be saved.");
    } finally { setBusy(false); }
  };

  return <main className="password-screen"><section className="password-card"><div className="password-brand"><span className="brand-mark password-logo" role="img" aria-label="Imam Ali Center logo" style={{ backgroundImage: "url('/iac-media-logo.png')", backgroundPosition: "center", backgroundSize: "cover" }} /><span><strong>Media Operations</strong><small>IMAM ALI CENTER</small></span></div><span className="password-icon"><KeyRound size={22} /></span><h1>Set your password</h1><p>Choose a password for your media team account. Use at least 4 characters.</p><form onSubmit={submit} className="password-form"><label><span>New password</span><input name="password" type="password" minLength={4} maxLength={128} autoComplete="new-password" required /></label><label><span>Confirm password</span><input name="confirmation" type="password" minLength={4} maxLength={128} autoComplete="new-password" required /></label>{message && <div role="status" className={`password-message ${error ? "is-error" : ""}`}>{message}</div>}<button className="button button-primary full-button" disabled={busy}>{busy ? "Saving…" : "Save password"}<ArrowRight size={15} /></button></form><Link className="password-back-link" href="/">Return to sign in</Link></section></main>;
}
