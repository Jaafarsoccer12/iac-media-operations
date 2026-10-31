import { NextRequest, NextResponse } from "next/server";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getSessionContext } from "@/lib/auth";
import { getDemoSettingsPinSecurity, setDemoSettingsPin, verifyDemoSettingsPin, type SettingsPinFailure } from "@/lib/store";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { hasManagerAccess } from "@/lib/roles";

export const dynamic = "force-dynamic";

const requestSchema = z.object({
  action: z.enum(["set_pin", "verify_pin"]),
  pin: z.string().regex(/^\d{4,12}$/, "Use a PIN with 4 to 12 digits.").optional(),
  currentPin: z.string().regex(/^\d{4,12}$/).optional(),
  confirmPin: z.string().regex(/^\d{4,12}$/).optional(),
  device: z.string().trim().max(80).default("This browser"),
});

function jsonError(message: string, status = 400) { return NextResponse.json({ error: message }, { status }); }
function verifyPin(pin: string, salt: string, hash: string) {
  const candidate = scryptSync(pin, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
function normalizeAttempts(value: unknown): SettingsPinFailure[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => entry && typeof entry === "object" && typeof entry.createdAt === "string" ? [{ createdAt: entry.createdAt, device: typeof entry.device === "string" ? entry.device.slice(0, 80) : "This browser" }] : []).slice(-30);
}

export async function GET() {
  const context = await getSessionContext();
  if (!context) return jsonError("Sign in again to open Administration.", 401);
  if (!hasManagerAccess(context.user.accessRoles, context.user.role)) return jsonError("Administrator or Director access is required.", 403);
  try {
    if (context.mode === "demo") return NextResponse.json(await getDemoSettingsPinSecurity(context.user.id));
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.from("settings_pin_security").select("pin_salt,pin_hash,failed_attempts").eq("user_id", context.user.id).maybeSingle();
    if (error) throw error;
    return NextResponse.json({ pinConfigured: Boolean(data?.pin_salt && data?.pin_hash), failedAttempts: normalizeAttempts(data?.failed_attempts) });
  } catch (error) { return jsonError(error instanceof Error ? error.message : "Could not load settings security.", 503); }
}

export async function POST(request: NextRequest) {
  const context = await getSessionContext();
  if (!context) return jsonError("Your session has expired. Sign in again.", 401);
  if (!hasManagerAccess(context.user.accessRoles, context.user.role)) return jsonError("Administrator or Director access is required.", 403);
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.issues.map((issue) => issue.message).join(" "));
  const values = parsed.data;
  if (!values.pin) return jsonError("Enter a settings PIN.");
  try {
    if (context.mode === "demo") {
      if (values.action === "set_pin") {
        if (values.confirmPin !== values.pin) return jsonError("The PIN entries do not match.");
        const current = await getDemoSettingsPinSecurity(context.user.id);
        const currentPin = values.currentPin;
        if (current.pinConfigured && !currentPin) return jsonError("Enter your current settings PIN before changing it.", 403);
        await setDemoSettingsPin(context.user.id, values.pin, currentPin);
        return NextResponse.json({ ok: true, pinConfigured: true, failedAttempts: current.failedAttempts });
      }
      const result = await verifyDemoSettingsPin(context.user.id, values.pin, values.device);
      return result.valid ? NextResponse.json({ ok: true, failedAttempts: result.failedAttempts }) : NextResponse.json({ error: "That settings PIN did not match.", failedAttempts: result.failedAttempts }, { status: 401 });
    }

    const supabase = await createSupabaseServerClient();
    const { data: current, error: lookupError } = await supabase.from("settings_pin_security").select("pin_salt,pin_hash,failed_attempts").eq("user_id", context.user.id).maybeSingle();
    if (lookupError) throw lookupError;
    const failedAttempts = normalizeAttempts(current?.failed_attempts);
    if (values.action === "set_pin") {
      if (values.confirmPin !== values.pin) return jsonError("The PIN entries do not match.");
      if (current && (!values.currentPin || !verifyPin(values.currentPin, current.pin_salt, current.pin_hash))) return jsonError("Enter your current settings PIN before changing it.", 403);
      const salt = randomBytes(16).toString("hex");
      const pinHash = scryptSync(values.pin, salt, 64).toString("hex");
      const { error } = await supabase.from("settings_pin_security").upsert({ user_id: context.user.id, pin_salt: salt, pin_hash: pinHash, failed_attempts: failedAttempts, updated_at: new Date().toISOString() });
      if (error) throw error;
      return NextResponse.json({ ok: true, pinConfigured: true, failedAttempts });
    }
    if (!current) return jsonError("Create a settings PIN before opening Administration.", 404);
    if (verifyPin(values.pin, current.pin_salt, current.pin_hash)) return NextResponse.json({ ok: true, failedAttempts });
    const attempts = [...failedAttempts, { createdAt: new Date().toISOString(), device: values.device }].slice(-30);
    const { error } = await supabase.from("settings_pin_security").update({ failed_attempts: attempts, updated_at: new Date().toISOString() }).eq("user_id", context.user.id);
    if (error) throw error;
    return NextResponse.json({ error: "That settings PIN did not match.", failedAttempts: attempts }, { status: 401 });
  } catch (error) { return jsonError(error instanceof Error ? error.message : "Could not save settings security.", 503); }
}
