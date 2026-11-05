import { NextResponse } from "next/server";
import { getSessionContext } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const allowedTypes = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "video/mp4", "video/webm", "video/quicktime",
  "audio/mpeg", "audio/mp4", "application/pdf",
]);
const extensionByType: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "application/pdf": "pdf",
};

export async function POST(request: Request) {
  const context = await getSessionContext();
  if (!context) return NextResponse.json({ error: "Sign in to attach chat files." }, { status: 401 });
  if (context.mode !== "supabase") return NextResponse.json({ error: "Local demo attachments are sent with the message." }, { status: 400 });

  let form: FormData;
  try { form = await request.formData(); }
  catch { return NextResponse.json({ error: "Choose a supported file to attach." }, { status: 400 }); }
  const file = form.get("file");
  if (!(file instanceof File) || file.size < 1) return NextResponse.json({ error: "Choose a supported file to attach." }, { status: 400 });
  if (file.size > 50 * 1024 * 1024) return NextResponse.json({ error: "Each chat attachment must be 50 MB or smaller." }, { status: 413 });
  if (!allowedTypes.has(file.type)) return NextResponse.json({ error: "This file format is not supported. Attach JPG, PNG, WebP, GIF, MP4, WebM, QuickTime video, MP3, M4A, or PDF." }, { status: 415 });

  const safeName = file.name.replace(/[\\/\r\n\0]/g, "_").slice(0, 180) || `attachment.${extensionByType[file.type]}`;
  const path = `${context.user.id}/chat/${crypto.randomUUID()}.${extensionByType[file.type]}`;
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.storage.from("crew-media").upload(path, file, { contentType: file.type, upsert: false });
  if (error) return NextResponse.json({ error: "The file could not be uploaded. Check your connection and try again." }, { status: 503 });
  return NextResponse.json({ attachment: { path, name: safeName, type: file.type, size: file.size } });
}

export async function GET(request: Request) {
  const context = await getSessionContext();
  if (!context) return NextResponse.json({ error: "Sign in to view this attachment." }, { status: 401 });
  if (context.mode !== "supabase") return NextResponse.json({ error: "This demo attachment is no longer available." }, { status: 404 });
  const path = new URL(request.url).searchParams.get("path") ?? "";
  if (!path || path.length > 500 || path.includes("..") || !path.split("/").every(Boolean)) return NextResponse.json({ error: "Attachment not found." }, { status: 404 });

  const supabase = await createSupabaseServerClient();
  if (!path.startsWith(`${context.user.id}/chat/`)) {
    const { data: message, error: messageError } = await supabase.from("crew_chat_messages")
      .select("id").contains("attachments", [{ path }]).limit(1).maybeSingle();
    if (messageError || !message) return NextResponse.json({ error: "You cannot view this conversation attachment." }, { status: 403 });
  }
  const { data: blob, error } = await supabase.storage.from("crew-media").download(path);
  if (error || !blob) return NextResponse.json({ error: "Attachment not found or you do not have access to it." }, { status: 404 });
  const type = allowedTypes.has(blob.type) ? blob.type : "application/octet-stream";
  return new Response(blob, {
    headers: {
      "Content-Type": type,
      "Content-Disposition": type.startsWith("image/") || type.startsWith("video/") || type.startsWith("audio/") ? "inline" : "attachment",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
