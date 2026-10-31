import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getSessionContext } from "@/lib/auth";
import { changeDemoPassword, updateDemoOwnProfile } from "@/lib/store";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const usernameSchema = z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).transform((value) => value.toLowerCase());
const avatarSchema = z.string().max(400_000).refine((value) => !value || /^https?:\/\/[^\s]+$/i.test(value) || /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value), "Choose a JPEG photo or use a secure image link.");
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("update_profile"), username: usernameSchema, avatarUrl: avatarSchema }),
  z.object({ action: z.literal("change_password"), currentPassword: z.string().min(1).max(128), newPassword: z.string().min(4).max(128), confirmPassword: z.string().min(4).max(128) }).refine((value) => value.newPassword === value.confirmPassword, { message: "The new passwords do not match.", path: ["confirmPassword"] }),
]);

export async function POST(request: NextRequest) {
  const context = await getSessionContext();
  if (!context) return NextResponse.json({ error: "Your session has expired. Sign in again." }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues.map((issue) => issue.message).join(" ") }, { status: 400 });

  try {
    if (parsed.data.action === "update_profile") {
      if (context.mode === "demo") {
        await updateDemoOwnProfile(context.user.id, { username: parsed.data.username, avatarUrl: parsed.data.avatarUrl });
        return NextResponse.json({ ok: true });
      }
      const supabase = await createSupabaseServerClient();
      const { error } = await supabase.rpc("update_own_profile", { p_username: parsed.data.username, p_avatar_url: parsed.data.avatarUrl });
      if (error?.code === "23505") return NextResponse.json({ error: "That username is already in use." }, { status: 409 });
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }

    if (context.mode === "demo") {
      await changeDemoPassword(context.user.id, parsed.data.currentPassword, parsed.data.newPassword);
      return NextResponse.json({ ok: true });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey || !context.user.email) throw new Error("Password changes are not configured for this account.");
    const verifier = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
    const { data: verified, error: verifyError } = await verifier.auth.signInWithPassword({ email: context.user.email, password: parsed.data.currentPassword });
    if (verifyError || verified.user?.id !== context.user.id) return NextResponse.json({ error: "The current password is incorrect." }, { status: 401 });
    await verifier.auth.signOut();

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.updateUser({ password: parsed.data.newPassword });
    if (error) throw new Error("The new password could not be saved. Check that it meets the account’s password rules.");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Your profile could not be updated." }, { status: 400 });
  }
}
