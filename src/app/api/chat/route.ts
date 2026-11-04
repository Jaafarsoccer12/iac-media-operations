import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionContext } from "@/lib/auth";
import { readDemoStore, updateDemoStore } from "@/lib/store";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { ChatMessage } from "@/lib/types";

export const dynamic = "force-dynamic";

const conversationSchema = z.object({
  conversationType: z.enum(["all", "direct"]).default("all"),
  recipientId: z.string().trim().max(100).optional(),
}).superRefine((value, context) => {
  if (value.conversationType === "direct" && !value.recipientId) context.addIssue({ code: "custom", path: ["recipientId"], message: "Choose a team member to chat with." });
});

const messageSchema = z.object({
  conversationType: z.enum(["all", "direct"]),
  recipientId: z.string().trim().max(100).optional(),
  body: z.string().trim().min(1).max(2000),
}).superRefine((value, context) => {
  if (value.conversationType === "direct" && !value.recipientId) context.addIssue({ code: "custom", path: ["recipientId"], message: "Choose a team member to chat with." });
});

function messageError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: Request) {
  const context = await getSessionContext();
  if (!context) return messageError("Sign in to use crew chat.", 401);

  const params = new URL(request.url).searchParams;
  if (params.get("summary") === "1") {
    const sinceParam = params.get("since");
    const since = sinceParam ? new Date(sinceParam) : null;
    if (!since || !Number.isFinite(since.getTime())) return messageError("A valid message timestamp is required.");

    if (context.mode === "demo") {
      const data = await readDemoStore();
      const count = (data.chatMessages ?? []).filter((message) => message.senderId !== context.user.id
        && (message.conversationType === "all" || (message.conversationType === "direct" && message.recipientId === context.user.id))
        && Date.parse(message.createdAt) > since.getTime()).length;
      return NextResponse.json({ count });
    }

    const supabase = await createSupabaseServerClient();
    const { count, error } = await supabase.from("crew_chat_messages").select("id", { count: "exact", head: true })
      .or(`and(conversation_type.eq.all,sender_id.neq.${context.user.id}),and(conversation_type.eq.direct,recipient_id.eq.${context.user.id})`)
      .gt("created_at", since.toISOString());
    if (error) return messageError(error.message, 503);
    return NextResponse.json({ count: count ?? 0 });
  }

  const parsed = conversationSchema.safeParse({ conversationType: params.get("conversationType") ?? "all", recipientId: params.get("recipientId") ?? undefined });
  if (!parsed.success) return messageError(parsed.error.issues.map((issue) => issue.message).join(" "));
  const { conversationType, recipientId } = parsed.data;

  if (context.mode === "demo") {
    const data = await readDemoStore();
    const members = data.profiles.filter((profile) => profile.active !== false && profile.id !== context.user.id).sort((a, b) => a.fullName.localeCompare(b.fullName)).map((profile) => ({ id: profile.id, fullName: profile.fullName, avatarUrl: profile.avatarUrl, role: profile.role, jobTitle: profile.jobTitle }));
    const visible = (data.chatMessages ?? []).filter((message) => conversationType === "all"
      ? message.conversationType === "all"
      : message.conversationType === "direct" && ((message.senderId === context.user.id && message.recipientId === recipientId) || (message.senderId === recipientId && message.recipientId === context.user.id)));
    const messages = [...visible].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200).reverse();
    return NextResponse.json({ members, messages });
  }

  if (conversationType === "direct" && !z.string().uuid().safeParse(recipientId).success) return messageError("Choose a valid team member.");
  const supabase = await createSupabaseServerClient();
  const [memberResult, messageResult] = await Promise.all([
    supabase.rpc("list_crew_chat_members"),
    (conversationType === "all"
      ? supabase.from("crew_chat_messages").select("id,conversation_type,sender_id,recipient_id,body,created_at").eq("conversation_type", "all")
      : supabase.from("crew_chat_messages").select("id,conversation_type,sender_id,recipient_id,body,created_at").eq("conversation_type", "direct").or(`and(sender_id.eq.${context.user.id},recipient_id.eq.${recipientId}),and(sender_id.eq.${recipientId},recipient_id.eq.${context.user.id})`))
      .order("created_at", { ascending: false }).limit(200),
  ]);
  if (memberResult.error) return messageError(memberResult.error.message, 503);
  if (messageResult.error) return messageError(messageResult.error.message, 503);
  const members = (memberResult.data ?? []).map((profile: { id: string; full_name: string; avatar_url: string | null; role: string; job_title: string | null }) => ({ id: profile.id, fullName: profile.full_name, avatarUrl: profile.avatar_url ?? undefined, role: profile.role, jobTitle: profile.job_title ?? undefined }));
  const messages: ChatMessage[] = (messageResult.data ?? []).map((message: { id: string; conversation_type: "all" | "direct"; sender_id: string; recipient_id: string | null; body: string; created_at: string }) => ({ id: message.id, conversationType: message.conversation_type, senderId: message.sender_id, recipientId: message.recipient_id ?? undefined, body: message.body, createdAt: message.created_at })).reverse();
  return NextResponse.json({ members, messages });
}

export async function POST(request: Request) {
  const context = await getSessionContext();
  if (!context) return messageError("Sign in to use crew chat.", 401);

  let input: unknown;
  try { input = await request.json(); }
  catch { return messageError("Enter a message to send."); }
  const parsed = messageSchema.safeParse(input);
  if (!parsed.success) return messageError(parsed.error.issues.map((issue) => issue.message).join(" "));
  const values = parsed.data;

  if (context.mode === "demo") {
    const result = await updateDemoStore(async (data) => {
      data.chatMessages ??= [];
      const recipient = values.conversationType === "direct" ? data.profiles.find((profile) => profile.id === values.recipientId && profile.active !== false) : undefined;
      if (values.conversationType === "direct" && (!recipient || recipient.id === context.user.id)) throw new Error("Choose another active team member.");
      const message: ChatMessage = { id: crypto.randomUUID(), conversationType: values.conversationType, senderId: context.user.id, recipientId: recipient?.id, body: values.body, createdAt: new Date().toISOString() };
      data.chatMessages.push(message);
      return message;
    });
    return NextResponse.json({ message: result });
  }

  const supabase = await createSupabaseServerClient();
  let recipientId: string | null = null;
  if (values.conversationType === "direct") {
    if (!z.string().uuid().safeParse(values.recipientId).success || values.recipientId === context.user.id) return messageError("Choose another active team member.");
    const { data: members, error } = await supabase.rpc("list_crew_chat_members");
    if (error) return messageError(error.message, 503);
    if (!(members ?? []).some((member: { id: string }) => member.id === values.recipientId)) return messageError("Choose an active team member.", 403);
    recipientId = values.recipientId!;
  }
  const { data: inserted, error } = await supabase.from("crew_chat_messages").insert({ conversation_type: values.conversationType, sender_id: context.user.id, recipient_id: recipientId, body: values.body }).select("id,conversation_type,sender_id,recipient_id,body,created_at").single();
  if (error) return messageError(error.message, 503);
  const message: ChatMessage = { id: inserted.id, conversationType: inserted.conversation_type, senderId: inserted.sender_id, recipientId: inserted.recipient_id ?? undefined, body: inserted.body, createdAt: inserted.created_at };
  return NextResponse.json({ message });
}
