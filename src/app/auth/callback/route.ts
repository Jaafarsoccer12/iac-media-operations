import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const emailOtpTypes = ["signup", "invite", "magiclink", "recovery", "email_change", "email"] as const;

function safeDestination(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  try {
    const target = new URL(value, "https://local.invalid");
    return target.origin === "https://local.invalid" ? `${target.pathname}${target.search}${target.hash}` : "/";
  } catch { return "/"; }
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const destination = safeDestination(params.get("next"));
  const supabase = await createSupabaseServerClient();
  const code = params.get("code");
  let error: Error | null = null;

  if (code) {
    const result = await supabase.auth.exchangeCodeForSession(code);
    error = result.error;
  } else {
    const tokenHash = params.get("token_hash");
    const type = params.get("type");
    if (tokenHash && type && emailOtpTypes.includes(type as (typeof emailOtpTypes)[number])) {
      const result = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: type as (typeof emailOtpTypes)[number] });
      error = result.error;
    } else {
      error = new Error("Invalid sign-in link.");
    }
  }

  if (error) {
    const invalidLink = new URL("/set-password?error=invalid-link", request.url);
    return NextResponse.redirect(invalidLink);
  }
  return NextResponse.redirect(new URL(destination, request.url));
}
