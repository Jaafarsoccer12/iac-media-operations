import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionContext } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const subscriptionSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(10).max(100) }),
});
const endpointSchema = z.object({ endpoint: z.string().url().max(2048) });

function responseError(error: string, status = 400) { return NextResponse.json({ error }, { status }); }

export async function GET() {
  const context = await getSessionContext();
  if (!context) return responseError("Sign in to enable phone alerts.", 401);
  if (context.mode !== "supabase") return NextResponse.json({ available: false, reason: "Phone alerts are available on the connected website." });
  const available = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  return NextResponse.json({ available, publicKey: available ? process.env.VAPID_PUBLIC_KEY : null });
}

export async function POST(request: Request) {
  const context = await getSessionContext();
  if (!context) return responseError("Sign in to enable phone alerts.", 401);
  if (context.mode !== "supabase") return responseError("Phone alerts require the connected website.", 409);
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return responseError("Phone alerts are not configured yet.", 503);
  let body: unknown;
  try { body = await request.json(); } catch { return responseError("Choose Enable phone alerts and try again."); }
  const parsed = subscriptionSchema.safeParse(body);
  if (!parsed.success) return responseError("The device subscription is incomplete.");
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("crew_chat_push_subscriptions").upsert({
    user_id: context.user.id,
    endpoint: parsed.data.endpoint,
    p256dh: parsed.data.keys.p256dh,
    auth: parsed.data.keys.auth,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id,endpoint" });
  if (error) return responseError("This device could not be registered for alerts.", 503);
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const context = await getSessionContext();
  if (!context) return responseError("Sign in to update phone alerts.", 401);
  if (context.mode !== "supabase") return NextResponse.json({ ok: true });
  let body: unknown;
  try { body = await request.json(); } catch { return responseError("The device subscription is missing."); }
  const parsed = endpointSchema.safeParse(body);
  if (!parsed.success) return responseError("The device subscription is incomplete.");
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("crew_chat_push_subscriptions").delete().eq("user_id", context.user.id).eq("endpoint", parsed.data.endpoint);
  if (error) return responseError("This device could not be removed from alerts.", 503);
  return NextResponse.json({ ok: true });
}
