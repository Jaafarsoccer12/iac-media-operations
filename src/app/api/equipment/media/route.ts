import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionContext } from "@/lib/auth";
import { can } from "@/lib/policy.mjs";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const equipmentPhotoTypes: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};
const assetIdSchema = z.string().uuid();
const noStore = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

function hasInventoryAccess(context: NonNullable<Awaited<ReturnType<typeof getSessionContext>>>) {
  return can(context.user.accessRoles ?? context.user.role, "manage_equipment_inventory");
}

export async function GET(request: Request) {
  const context = await getSessionContext();
  if (!context) return NextResponse.json({ error: "Sign in to view equipment photos." }, { status: 401, headers: noStore });
  if (context.mode !== "supabase" || !can(context.user.accessRoles ?? context.user.role, "view_equipment")) return NextResponse.json({ error: "Equipment photo not found." }, { status: 404, headers: noStore });

  const assetId = assetIdSchema.safeParse(new URL(request.url).searchParams.get("assetId"));
  if (!assetId.success) return NextResponse.json({ error: "Equipment photo not found." }, { status: 404, headers: noStore });
  const supabase = await createSupabaseServerClient();
  const { data: asset, error } = await supabase.from("equipment_assets").select("image_path").eq("id", assetId.data).maybeSingle();
  const path = asset?.image_path;
  if (error || typeof path !== "string" || !path || path.includes("..") || path.split("/")[1] !== "assets") return NextResponse.json({ error: "Equipment photo not found." }, { status: 404, headers: noStore });

  const { data: image, error: downloadError } = await supabase.storage.from("crew-media").download(path);
  if (downloadError || !image || !equipmentPhotoTypes[image.type]) return NextResponse.json({ error: "Equipment photo not found." }, { status: 404, headers: noStore });
  return new Response(image, { headers: { ...noStore, "Content-Type": image.type, "Content-Disposition": "inline" } });
}

export async function POST(request: Request) {
  const context = await getSessionContext();
  if (!context) return NextResponse.json({ error: "Sign in to add equipment photos." }, { status: 401 });
  if (context.mode !== "supabase") return NextResponse.json({ error: "Equipment photos require the connected workspace." }, { status: 400 });
  if (!hasInventoryAccess(context)) return NextResponse.json({ error: "Only an administrator or equipment manager can add equipment photos." }, { status: 403 });

  let form: FormData;
  try { form = await request.formData(); }
  catch { return NextResponse.json({ error: "Choose a JPG, PNG, WebP, or GIF image." }, { status: 400 }); }
  const assetId = assetIdSchema.safeParse(form.get("assetId"));
  const file = form.get("file");
  if (!assetId.success || !(file instanceof File) || file.size < 1 || !equipmentPhotoTypes[file.type]) return NextResponse.json({ error: "Choose a JPG, PNG, WebP, or GIF image." }, { status: 415 });
  if (file.size > 15 * 1024 * 1024) return NextResponse.json({ error: "Equipment photos must be 15 MB or smaller." }, { status: 413 });

  const supabase = await createSupabaseServerClient();
  const { data: asset, error: assetError } = await supabase.from("equipment_assets").select("id,image_path").eq("id", assetId.data).maybeSingle();
  if (assetError || !asset) return NextResponse.json({ error: "That equipment item could not be found." }, { status: 404 });

  const path = `${context.user.id}/assets/${assetId.data}/${crypto.randomUUID()}.${equipmentPhotoTypes[file.type]}`;
  const { error: uploadError } = await supabase.storage.from("crew-media").upload(path, file, { contentType: file.type, upsert: false });
  if (uploadError) return NextResponse.json({ error: "The equipment photo could not be uploaded. Check the connection and try again." }, { status: 503 });

  const { error: updateError } = await supabase.from("equipment_assets").update({ image_path: path }).eq("id", assetId.data);
  if (updateError) {
    await supabase.storage.from("crew-media").remove([path]);
    return NextResponse.json({ error: "The equipment photo could not be saved to this item." }, { status: 503 });
  }

  const oldPath = asset.image_path;
  if (typeof oldPath === "string" && oldPath !== path && oldPath.split("/")[1] === "assets" && !oldPath.includes("..")) await supabase.storage.from("crew-media").remove([oldPath]);
  return NextResponse.json({ ok: true }, { headers: noStore });
}

export async function DELETE(request: Request) {
  const context = await getSessionContext();
  if (!context) return NextResponse.json({ error: "Sign in to remove equipment photos." }, { status: 401 });
  if (context.mode !== "supabase") return NextResponse.json({ error: "Equipment photos require the connected workspace." }, { status: 400 });
  if (!hasInventoryAccess(context)) return NextResponse.json({ error: "Only an administrator or equipment manager can remove equipment photos." }, { status: 403 });

  const parsed = z.object({ assetId: assetIdSchema }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Select an equipment item." }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  const { data: asset, error: assetError } = await supabase.from("equipment_assets").select("id,image_path").eq("id", parsed.data.assetId).maybeSingle();
  if (assetError || !asset) return NextResponse.json({ error: "That equipment item could not be found." }, { status: 404 });
  const oldPath = asset.image_path;
  const { error: updateError } = await supabase.from("equipment_assets").update({ image_path: null }).eq("id", parsed.data.assetId);
  if (updateError) return NextResponse.json({ error: "The equipment photo could not be removed." }, { status: 503 });
  if (typeof oldPath === "string" && oldPath.split("/")[1] === "assets" && !oldPath.includes("..")) await supabase.storage.from("crew-media").remove([oldPath]);
  return NextResponse.json({ ok: true }, { headers: noStore });
}
