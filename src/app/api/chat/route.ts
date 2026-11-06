import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionContext } from "@/lib/auth";
import { readDemoStore, updateDemoStore } from "@/lib/store";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { ChatAttachment, ChatMessage } from "@/lib/types";

export const dynamic = "force-dynamic";

const conversationSchema = z.object({
  conversationType: z.enum(["all", "direct"]).default("all"),
  recipientId: z.string().trim().max(100).optional(),
}).superRefine((value, context) => {
  if (value.conversationType === "direct" && !value.recipientId) context.addIssue({ code: "custom", path: ["recipientId"], message: "Choose a team member to chat with." });
});

const attachmentSchema = z.object({
  path: z.string().trim().max(500).optional(),
  dataUrl: z.string().max(3_000_000).optional(),
  name: z.string().trim().min(1).max(180),
  type: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm", "video/quicktime", "audio/mpeg", "audio/mp4", "application/pdf"]),
  size: z.number().int().min(1).max(50 * 1024 * 1024),
}).superRefine((attachment, issue) => {
  if (Boolean(attachment.path) === Boolean(attachment.dataUrl)) issue.addIssue({ code: "custom", message: "Each attachment needs one uploaded file." });
});

const messageSchema = z.object({
  conversationType: z.enum(["all", "direct"]),
  recipientId: z.string().trim().max(100).optional(),
  body: z.string().trim().max(2000).default(""),
  replyToId: z.string().uuid().optional(),
  attachments: z.array(attachmentSchema).max(8).default([]),
}).superRefine((value, context) => {
  if (value.conversationType === "direct" && !value.recipientId) context.addIssue({ code: "custom", path: ["recipientId"], message: "Choose a team member to chat with." });
  if (!value.body && value.attachments.length === 0) context.addIssue({ code: "custom", path: ["body"], message: "Write a message or attach a file." });
});

function visibleAttachment(attachment: ChatAttachment, demo: boolean): ChatAttachment {
  return demo ? attachment : { ...attachment, dataUrl: undefined, path: attachment.path };
}

function mapDbMessage(message: { id: string; conversation_type: "all" | "direct"; sender_id: string; recipient_id: string | null; body: string; created_at: string; reply_to_id?: string | null; attachments?: ChatAttachment[] | null; reply?: { id: string; body: string; sender_id: string; attachments?: ChatAttachment[] | null } | { id: string; body: string; sender_id: string; attachments?: ChatAttachment[] | null }[] | null }, receipts: ChatMessage["receipts"] = []): ChatMessage {
  const reply = Array.isArray(message.reply) ? message.reply[0] : message.reply;
  return {
    id: message.id, conversationType: message.conversation_type, senderId: message.sender_id,
    recipientId: message.recipient_id ?? undefined, body: message.body, createdAt: message.created_at,
    replyToId: message.reply_to_id ?? undefined,
    attachments: (message.attachments ?? []).map((attachment) => visibleAttachment(attachment, false)),
    reply: reply ? { id: reply.id, body: reply.body, senderId: reply.sender_id, attachments: reply.attachments ?? [] } : undefined,
    receipts,
  };
}

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
    const membersAndMessages = await updateDemoStore((data) => {
      const members = data.profiles.filter((profile) => profile.active !== false && profile.id !== context.user.id).sort((a, b) => a.fullName.localeCompare(b.fullName)).map((profile) => ({ id: profile.id, fullName: profile.fullName, avatarUrl: profile.avatarUrl, role: profile.role, jobTitle: profile.jobTitle }));
      const allMessages = data.chatMessages ?? [];
      const visible = allMessages.filter((message) => conversationType === "all"
        ? message.conversationType === "all"
        : message.conversationType === "direct" && ((message.senderId === context.user.id && message.recipientId === recipientId) || (message.senderId === recipientId && message.recipientId === context.user.id)));
      const readAt = new Date().toISOString();
      for (const message of visible) {
        if (message.senderId === context.user.id) continue;
        message.receipts ??= [];
        if (!message.receipts.some((receipt) => receipt.userId === context.user.id)) message.receipts.push({ userId: context.user.id, readAt });
      }
      const messages = [...visible].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200).reverse().map((message) => ({
        ...message,
        attachments: (message.attachments ?? []).map((attachment) => visibleAttachment(attachment, true)),
        reply: message.replyToId ? (() => {
          const parent = visible.find((item) => item.id === message.replyToId);
          return parent ? { id: parent.id, senderId: parent.senderId, body: parent.body, attachments: parent.attachments ?? [] } : undefined;
        })() : undefined,
      }));
      return { members, messages };
    });
    const { members, messages } = membersAndMessages;
    return NextResponse.json({ members, messages });
  }

  if (conversationType === "direct" && !z.string().uuid().safeParse(recipientId).success) return messageError("Choose a valid team member.");
  const supabase = await createSupabaseServerClient();
  const messageSelection = "id,conversation_type,sender_id,recipient_id,body,created_at,reply_to_id,attachments";
  const [memberResult, messageResult] = await Promise.all([
    supabase.rpc("list_crew_chat_members"),
    (conversationType === "all"
      ? supabase.from("crew_chat_messages").select(messageSelection).eq("conversation_type", "all")
      : supabase.from("crew_chat_messages").select(messageSelection).eq("conversation_type", "direct").or(`and(sender_id.eq.${context.user.id},recipient_id.eq.${recipientId}),and(sender_id.eq.${recipientId},recipient_id.eq.${context.user.id})`))
      .order("created_at", { ascending: false }).limit(200),
  ]);
  if (memberResult.error) return messageError(memberResult.error.message, 503);
  if (messageResult.error) return messageError(messageResult.error.message, 503);
  const members = (memberResult.data ?? []).map((profile: { id: string; full_name: string; avatar_url: string | null; role: string; job_title: string | null }) => ({ id: profile.id, fullName: profile.full_name, avatarUrl: profile.avatar_url ?? undefined, role: profile.role, jobTitle: profile.job_title ?? undefined }));
  const dbMessages = (messageResult.data ?? []) as unknown as Parameters<typeof mapDbMessage>[0][];
  const replyParentIds = [...new Set(dbMessages.flatMap((message) => message.reply_to_id ? [message.reply_to_id] : []))];
  const replyParentResult = replyParentIds.length
    ? await supabase.from("crew_chat_messages").select("id,body,sender_id,attachments").in("id", replyParentIds)
    : { data: [], error: null };
  if (replyParentResult.error) return messageError(replyParentResult.error.message, 503);
  const replyParents = new Map((replyParentResult.data ?? []).map((parent) => [parent.id, parent]));
  const incomingIds = dbMessages.filter((message) => message.sender_id !== context.user.id).map((message) => message.id);
  if (incomingIds.length) {
    await supabase.from("crew_chat_message_receipts").upsert(incomingIds.map((message_id) => ({ message_id, user_id: context.user.id })), { onConflict: "message_id,user_id", ignoreDuplicates: true });
  }
  const sentIds = dbMessages.filter((message) => message.sender_id === context.user.id).map((message) => message.id);
  const receiptResult = sentIds.length
    ? await supabase.from("crew_chat_message_receipts").select("message_id,user_id,read_at").in("message_id", sentIds)
    : { data: [], error: null };
  if (receiptResult.error) return messageError(receiptResult.error.message, 503);
  const receiptMap = new Map<string, NonNullable<ChatMessage["receipts"]>>();
  for (const receipt of receiptResult.data ?? []) {
    const list = receiptMap.get(receipt.message_id) ?? [];
    list.push({ userId: receipt.user_id, readAt: receipt.read_at });
    receiptMap.set(receipt.message_id, list);
  }
  const messages: ChatMessage[] = dbMessages.map((message) => mapDbMessage({
    ...message,
    reply: message.reply_to_id ? replyParents.get(message.reply_to_id) ?? null : null,
  }, receiptMap.get(message.id) ?? [])).reverse();
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
      const visibleParent = values.replyToId ? data.chatMessages.find((message) => message.id === values.replyToId && (values.conversationType === "all"
        ? message.conversationType === "all"
        : message.conversationType === "direct" && ((message.senderId === context.user.id && message.recipientId === recipient?.id) || (message.senderId === recipient?.id && message.recipientId === context.user.id)))) : undefined;
      if (values.replyToId && !visibleParent) throw new Error("You can only reply to a message from this conversation.");
      if (values.attachments.some((attachment) => !attachment.dataUrl)) throw new Error("Choose the file again to attach it in demo mode.");
      const message: ChatMessage = { id: crypto.randomUUID(), conversationType: values.conversationType, senderId: context.user.id, recipientId: recipient?.id, body: values.body, createdAt: new Date().toISOString(), replyToId: visibleParent?.id, attachments: values.attachments };
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
  let replyParent: { id: string; conversation_type: "all" | "direct"; sender_id: string; recipient_id: string | null } | null = null;
  if (values.replyToId) {
    const { data: parent, error: parentError } = await supabase.from("crew_chat_messages").select("id,conversation_type,sender_id,recipient_id").eq("id", values.replyToId).maybeSingle();
    if (parentError || !parent) return messageError("That reply target is not visible in this conversation.", 403);
    const sameConversation = values.conversationType === "all"
      ? parent.conversation_type === "all"
      : parent.conversation_type === "direct" && ((parent.sender_id === context.user.id && parent.recipient_id === recipientId) || (parent.sender_id === recipientId && parent.recipient_id === context.user.id));
    if (!sameConversation) return messageError("You can only reply to a message from this conversation.", 403);
    replyParent = parent;
  }
  if (values.attachments.some((attachment) => !attachment.path || attachment.dataUrl)) return messageError("Upload each chat attachment again before sending.");
  if (values.attachments.some((attachment) => !attachment.path!.startsWith(`${context.user.id}/chat/`))) return messageError("Chat attachments must be uploaded by your account.", 403);
  const attachments = values.attachments.map(({ path, name, type, size }) => ({ path: path!, name, type, size }));
  const { data: inserted, error } = await supabase.from("crew_chat_messages").insert({ conversation_type: values.conversationType, sender_id: context.user.id, recipient_id: recipientId, body: values.body, reply_to_id: replyParent?.id ?? null, attachments }).select("id,conversation_type,sender_id,recipient_id,body,created_at,reply_to_id,attachments").single();
  if (error) return messageError(error.message, 503);
  const message: ChatMessage = mapDbMessage(inserted as Parameters<typeof mapDbMessage>[0]);
  if (replyParent) {
    const { data: parentMessage } = await supabase.from("crew_chat_messages").select("id,body,sender_id,attachments").eq("id", replyParent.id).maybeSingle();
    if (parentMessage) message.reply = { id: parentMessage.id, body: parentMessage.body, senderId: parentMessage.sender_id, attachments: parentMessage.attachments ?? [] };
  }
  return NextResponse.json({ message });
}
