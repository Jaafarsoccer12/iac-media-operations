import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateDemoAccount, demoSessionCookieName, hasSupabaseConfig, isDemoMode, signDemoUser } from "@/lib/store";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient, hasSupabaseAdminConfig } from "@/lib/supabase/admin";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("demo_login"), username: z.string().trim().min(3).max(32), password: z.string().min(4).max(128) }),
  z.object({ action: z.literal("login"), identifier: z.string().trim().min(3).max(254), password: z.string().min(1) }),
  z.object({ action: z.literal("update_password"), password: z.string().min(4).max(128) }),
  z.object({ action: z.literal("logout") }),
]);

export async function GET() {
  return NextResponse.json({ demoAvailable: isDemoMode() && !hasSupabaseConfig(), supabaseConfigured: hasSupabaseConfig() });
}

export async function POST(request: NextRequest) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Check the sign-in details and try again." }, { status: 400 });

  if (parsed.data.action === "demo_login") {
    if (!isDemoMode() || hasSupabaseConfig()) return NextResponse.json({ error: "Local username sign-in is available only in the development workspace." }, { status: 403 });
    const account = await authenticateDemoAccount(parsed.data.username, parsed.data.password);
    if (!account) return NextResponse.json({ error: "The username or password is incorrect, or the account is disabled." }, { status: 401 });
    const response = NextResponse.json({ ok: true, mode: "demo" });
    response.cookies.set(demoSessionCookieName(), signDemoUser(account.id), {
      httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 12,
    });
    return response;
  }

  if (parsed.data.action === "login") {
    if (!hasSupabaseConfig()) return NextResponse.json({ error: "Supabase is not connected. Use a demo role in local development." }, { status: 503 });
    let email = parsed.data.identifier.trim();
    if (!email.includes("@")) {
      if (!hasSupabaseAdminConfig()) return NextResponse.json({ error: "Username sign-in needs the server-side account service. Use the sign-in email instead." }, { status: 503 });
      const admin = createSupabaseAdminClient();
      const { data: profile, error: profileError } = await admin.from("profiles").select("id,active").eq("username", email.toLowerCase()).maybeSingle();
      if (profileError || !profile) return NextResponse.json({ error: "Unable to sign in with those credentials." }, { status: 401 });
      if (!profile.active) return NextResponse.json({ error: "This account is not active. Contact an administrator." }, { status: 403 });
      const { data: account, error: accountError } = await admin.auth.admin.getUserById(profile.id);
      if (accountError || !account.user?.email) return NextResponse.json({ error: "Unable to sign in with those credentials." }, { status: 401 });
      email = account.user.email;
    }
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password: parsed.data.password });
    if (error) return NextResponse.json({ error: "Unable to sign in with those credentials." }, { status: 401 });
    const { data: { user } } = await supabase.auth.getUser();
    const { data: profile } = user ? await supabase.from("profiles").select("id, role, active").eq("id", user.id).single() : { data: null };
    if (!profile?.active) {
      await supabase.auth.signOut();
      return NextResponse.json({ error: "This account is not active. Contact an administrator." }, { status: 403 });
    }
    return NextResponse.json({ ok: true, mode: "supabase" });
  }

  if (parsed.data.action === "update_password") {
    if (!hasSupabaseConfig()) return NextResponse.json({ error: "Password setup requires a connected sign-in account." }, { status: 503 });
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return NextResponse.json({ error: "This setup link is no longer valid. Ask an administrator to send a new one." }, { status: 401 });
    const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
    if (error) return NextResponse.json({ error: "The password could not be saved. Use at least 4 characters and try again." }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  if (hasSupabaseConfig()) {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(demoSessionCookieName(), "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return response;
}
