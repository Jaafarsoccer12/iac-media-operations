import { NextResponse } from "next/server";
import { getSessionContext } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { hasManagerAccess } from "@/lib/roles";

export const dynamic = "force-dynamic";

const imageTypes: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

export async function POST(request: Request) {
  const context = await getSessionContext();
  if (!context) return NextResponse.json({ error: "Sign in to upload SOP images." }, { status: 401 });
  if (context.mode !== "supabase") return NextResponse.json({ error: "SOP image uploads require the connected app." }, { status: 400 });
  if (!hasManagerAccess(context.user.accessRoles, context.user.role)) return NextResponse.json({ error: "Only an administrator or director can upload SOP images." }, { status: 403 });
  let form: FormData;
  try { form = await request.formData(); }
  catch { return NextResponse.json({ error: "Choose a JPG, PNG, WebP, or GIF image." }, { status: 400 }); }
  const file = form.get("file");
  const sopId = String(form.get("sopId") ?? "draft");
  if (!(file instanceof File) || file.size < 1 || !imageTypes[file.type]) return NextResponse.json({ error: "Choose a JPG, PNG, WebP, or GIF image." }, { status: 415 });
  if (file.size > 15 * 1024 * 1024) return NextResponse.json({ error: "SOP images must be 15 MB or smaller." }, { status: 413 });
  const supabase = await createSupabaseServerClient();
  if (sopId !== "draft") {
    const { data, error } = await supabase.from("sops").select("id").eq("id", sopId).maybeSingle();
    if (error || !data) return NextResponse.json({ error: "That SOP could not be found or edited." }, { status: 404 });
  }
  const path = `${context.user.id}/sops/${sopId}/${crypto.randomUUID()}.${imageTypes[file.type]}`;
  const { error } = await supabase.storage.from("crew-media").upload(path, file, { contentType: file.type, upsert: false });
  if (error) return NextResponse.json({ error: "The SOP image could not be uploaded. Try again." }, { status: 503 });
  return NextResponse.json({ path });
}

export async function GET(request: Request) {
  const context = await getSessionContext();
  if (!context) return NextResponse.json({ error: "Sign in to view this SOP image." }, { status: 401 });
  if (context.mode !== "supabase") return NextResponse.json({ error: "SOP image not found." }, { status: 404 });
  const params = new URL(request.url).searchParams;
  const path = params.get("path") ?? "";
  const sopId = params.get("sopId") ?? "";
  if (!path || !sopId || path.length > 500 || path.includes("..")) return NextResponse.json({ error: "SOP image not found." }, { status: 404 });
  const supabase = await createSupabaseServerClient();
  const { data: sop, error: sopError } = await supabase.from("sops")
    .select("id,status,photos,assigned_user_ids,available_to_all").eq("id", sopId).maybeSingle();
  if (sopError || !sop || !(sop.photos ?? []).includes(path)) return NextResponse.json({ error: "SOP image not found." }, { status: 404 });
  const manager = hasManagerAccess(context.user.accessRoles, context.user.role);
  const audienceAllows = sop.available_to_all || (sop.assigned_user_ids ?? []).includes(context.user.id);
  if (!manager && (sop.status !== "Published" || !audienceAllows)) return NextResponse.json({ error: "You cannot view this SOP image." }, { status: 403 });
  const { data: blob, error } = await supabase.storage.from("crew-media").download(path);
  if (error || !blob || !Object.keys(imageTypes).includes(blob.type)) return NextResponse.json({ error: "SOP image not found." }, { status: 404 });
  return new Response(blob, { headers: { "Content-Type": blob.type, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
