import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionContext } from "@/lib/auth";
import { readDemoStore, updateDemoStore } from "@/lib/store";
import { createSupabaseAdminClient, hasSupabaseAdminConfig } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { sendWebPush } from "@/lib/web-push";
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
const editMessageSchema = z.object({ messageId: z.string().uuid(), body: z.string().trim().min(1).max(2000) });
const deleteMessageSchema = z.object({ messageId: z.string().uuid() });

function visibleAttachment(attachment: ChatAttachment, demo: boolean): ChatAttachment {
  return demo ? attachment : { ...attachment, dataUrl: undefined, path: attachment.path };
}

function mapDbMessage(message: { id: string; conversation_type: "all" | "direct"; sender_id: string; recipient_id: string | null; body: string; created_at: string; edited_at?: string | null; mentions?: string[] | null; reply_to_id?: string | null; attachments?: ChatAttachment[] | null; reply?: { id: string; body: string; sender_id: string; attachments?: ChatAttachment[] | null } | { id: string; body: string; sender_id: string; attachments?: ChatAttachment[] | null }[] | null }, receipts: ChatMessage["receipts"] = []): ChatMessage {
  const reply = Array.isArray(message.reply) ? message.reply[0] : message.reply;
  return {
    id: message.id, conversationType: message.conversation_type, senderId: message.sender_id,
    recipientId: message.recipient_id ?? undefined, body: message.body, createdAt: message.created_at,
    editedAt: message.edited_at ?? undefined, mentions: message.mentions ?? [],
    replyToId: message.reply_to_id ?? undefined,
    attachments: (message.attachments ?? []).map((attachment) => visibleAttachment(attachment, false)),
    reply: reply ? { id: reply.id, body: reply.body, senderId: reply.sender_id, attachments: reply.attachments ?? [] } : undefined,
    receipts,
  };
}

function matchMentionedMembers(body: string, members: { id: string; fullName: string }[], allowedIds?: string[]) {
  const allowed = allowedIds ? new Set(allowedIds) : null;
  return members.filter((member) => member.id !== "" && (!allowed || allowed.has(member.id)) && body.includes(`@${member.fullName}`)).map((member) => member.id);
}

async function pushMentionToDevices(userIds: string[], title: string, detail: string) {
  if (!userIds.length || !process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !hasSupabaseAdminConfig()) return;
  try {
    const admin = createSupabaseAdminClient();
    const { data } = await admin.from("crew_chat_push_subscriptions").select("user_id,endpoint,p256dh,auth").in("user_id", userIds);
    const subscriptions = data ?? [];
    const payload = JSON.stringify({ title, body: detail, url: "/?open=chat", tag: "crew-chat-mention" });
    const results = await Promise.all(subscriptions.map(async (subscription) => ({ subscription, result: await sendWebPush(subscription, payload) })));
    const expired = results.filter(({ result }) => result.expired).map(({ subscription }) => subscription);
    for (const subscription of expired) await admin.from("crew_chat_push_subscriptions").delete().eq("user_id", subscription.user_id).eq("endpoint", subscription.endpoint);
  } catch { /* In-app mention notifications remain available if a device push cannot be delivered. */ }
}

function messageError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: Request) {
  const context = await getSessionContext();
  if (!context) return messageError("Sign in to use crew chat.", 401);

  const params = new URL(request.url).searchParams;
  if (params.get("summary") === "1") {
    if (params.get("unread") === "1") {
      if (context.mode === "demo") {
        const data = await readDemoStore();
        const unread = (data.chatMessages ?? []).filter((message) => message.senderId !== context.user.id
          && (message.conversationType === "all" || (message.conversationType === "direct" && message.recipientId === context.user.id))
          && !(message.receipts ?? []).some((receipt) => receipt.userId === context.user.id));
        const direct: Record<string, number> = {};
        for (const message of unread) if (message.conversationType === "direct" && message.recipientId === context.user.id) direct[message.senderId] = (direct[message.senderId] ?? 0) + 1;
        return NextResponse.json({ all: unread.filter((message) => message.conversationType === "all").length, direct });
      }
      const supabase = await createSupabaseServerClient();
      const { data, error } = await supabase.rpc("get_crew_chat_unread_counts");
      if (error) return messageError("Unread chat counts could not be loaded.", 503);
      const direct: Record<string, number> = {};
      let all = 0;
      for (const item of data ?? []) {
        if (item.conversation_type === "all") all = Number(item.unread_count ?? 0);
        else if (item.other_user_id) direct[item.other_user_id] = Number(item.unread_count ?? 0);
      }
      return NextResponse.json({ all, direct });
    }
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
  const messageSelection = "id,conversation_type,sender_id,recipient_id,body,created_at,edited_at,mentions,reply_to_id,attachments";
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
    const { error: readError } = await supabase.rpc("mark_crew_chat_messages_read", { p_message_ids: incomingIds });
    if (readError) return messageError("Chat read receipts could not be saved.", 503);
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
      const availableMembers = data.profiles.filter((profile) => profile.active !== false).map((profile) => ({ id: profile.id, fullName: profile.fullName }));
      const mentionedIds = matchMentionedMembers(values.body, availableMembers, values.conversationType === "direct" ? [recipient?.id ?? ""] : undefined).filter((id) => id !== context.user.id);
      const message: ChatMessage = { id: crypto.randomUUID(), conversationType: values.conversationType, senderId: context.user.id, recipientId: recipient?.id, body: values.body, createdAt: new Date().toISOString(), replyToId: visibleParent?.id, mentions: mentionedIds, attachments: values.attachments };
      data.chatMessages.push(message);
      for (const mentionedId of mentionedIds) data.notifications.push({ id: crypto.randomUUID(), userId: mentionedId, senderId: context.user.id, title: "You were mentioned in crew chat", detail: `${context.user.fullName} mentioned you in a message.`, date: message.createdAt, read: false, href: "chat" });
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
  const { data: activeMembers, error: activeMembersError } = await supabase.rpc("list_crew_chat_members");
  if (activeMembersError) return messageError("Team mentions could not be checked.", 503);
  const normalizedMembers = (activeMembers ?? []).map((member: { id: string; full_name: string }) => ({ id: member.id, fullName: member.full_name }));
  const allowedMentionIds = values.conversationType === "direct" ? [recipientId ?? ""] : undefined;
  const mentionedIds = matchMentionedMembers(values.body, normalizedMembers, allowedMentionIds).filter((id) => id !== context.user.id);
  const { data: inserted, error } = await supabase.from("crew_chat_messages").insert({ conversation_type: values.conversationType, sender_id: context.user.id, recipient_id: recipientId, body: values.body, reply_to_id: replyParent?.id ?? null, attachments, mentions: mentionedIds }).select("id,conversation_type,sender_id,recipient_id,body,created_at,edited_at,mentions,reply_to_id,attachments").single();
  if (error) return messageError(error.message, 503);
  const message: ChatMessage = mapDbMessage(inserted as Parameters<typeof mapDbMessage>[0]);
  if (mentionedIds.length) {
    const { error: mentionError } = await supabase.from("crew_chat_mentions").insert(mentionedIds.map((user_id) => ({ message_id: message.id, user_id })));
    if (!mentionError) await pushMentionToDevices(mentionedIds, "You were mentioned in crew chat", `${context.user.fullName} mentioned you in a message.`);
    else return NextResponse.json({ message, warning: "The message was sent, but mention alerts could not be created." });
  }
  if (replyParent) {
    const { data: parentMessage } = await supabase.from("crew_chat_messages").select("id,body,sender_id,attachments").eq("id", replyParent.id).maybeSingle();
    if (parentMessage) message.reply = { id: parentMessage.id, body: parentMessage.body, senderId: parentMessage.sender_id, attachments: parentMessage.attachments ?? [] };
  }
  return NextResponse.json({ message });
}

export async function PATCH(request: Request) {
  const context = await getSessionContext();
  if (!context) return messageError("Sign in to edit chat messages.", 401);
  let input: unknown;
  try { input = await request.json(); } catch { return messageError("Enter the corrected message text."); }
  const parsed = editMessageSchema.safeParse(input);
  if (!parsed.success) return messageError(parsed.error.issues.map((issue) => issue.message).join(" "));
  if (context.mode === "demo") {
    const updated = await updateDemoStore((data) => {
      const message = (data.chatMessages ?? []).find((item) => item.id === parsed.data.messageId && item.senderId === context.user.id);
      if (!message) throw new Error("You can only edit your own messages.");
      const previousMentions = new Set(message.mentions ?? []);
      message.body = parsed.data.body;
      message.editedAt = new Date().toISOString();
      const mentionedIds = matchMentionedMembers(message.body, data.profiles.filter((profile) => profile.active !== false).map((profile) => ({ id: profile.id, fullName: profile.fullName })), message.conversationType === "direct" ? [message.recipientId ?? ""] : undefined).filter((id) => id !== context.user.id);
      message.mentions = mentionedIds;
      for (const mentionedId of mentionedIds.filter((id) => !previousMentions.has(id))) data.notifications.push({ id: crypto.randomUUID(), userId: mentionedId, senderId: context.user.id, title: "You were mentioned in crew chat", detail: `${context.user.fullName} mentioned you in a message.`, date: message.editedAt, read: false, href: "chat" });
      return message;
    });
    return NextResponse.json({ message: updated });
  }
  const supabase = await createSupabaseServerClient();
  const { data: existing, error: existingError } = await supabase.from("crew_chat_messages").select("id,conversation_type,sender_id,recipient_id,mentions").eq("id", parsed.data.messageId).eq("sender_id", context.user.id).maybeSingle();
  if (existingError) return messageError("This message could not be checked for editing.", 503);
  if (!existing) return messageError("You can only edit your own messages.", 403);
  const { data: activeMembers, error: activeMembersError } = await supabase.rpc("list_crew_chat_members");
  if (activeMembersError) return messageError("Team mentions could not be checked.", 503);
  const normalizedMembers = (activeMembers ?? []).map((member: { id: string; full_name: string }) => ({ id: member.id, fullName: member.full_name }));
  const mentionedIds = matchMentionedMembers(parsed.data.body, normalizedMembers, existing.conversation_type === "direct" ? [existing.recipient_id ?? ""] : undefined).filter((id) => id !== context.user.id);
  const { data: row, error } = await supabase.from("crew_chat_messages").update({ body: parsed.data.body, edited_at: new Date().toISOString(), mentions: mentionedIds }).eq("id", parsed.data.messageId).eq("sender_id", context.user.id).select("id,conversation_type,sender_id,recipient_id,body,created_at,edited_at,mentions,reply_to_id,attachments").maybeSingle();
  if (error) return messageError("This message could not be edited.", 503);
  if (!row) return messageError("You can only edit your own messages.", 403);
  const newMentionIds = mentionedIds.filter((id) => !(existing.mentions ?? []).includes(id));
  if (newMentionIds.length) {
    const { error: mentionError } = await supabase.from("crew_chat_mentions").insert(newMentionIds.map((user_id) => ({ message_id: row.id, user_id })));
    if (mentionError) return NextResponse.json({ message: mapDbMessage(row as Parameters<typeof mapDbMessage>[0]), warning: "The message was edited, but mention alerts could not be created." });
    await pushMentionToDevices(newMentionIds, "You were mentioned in crew chat", `${context.user.fullName} mentioned you in a message.`);
  }
  return NextResponse.json({ message: mapDbMessage(row as Parameters<typeof mapDbMessage>[0]) });
}

export async function DELETE(request: Request) {
  const context = await getSessionContext();
  if (!context) return messageError("Sign in to delete chat messages.", 401);
  let input: unknown;
  try { input = await request.json(); } catch { return messageError("Choose a message to delete."); }
  const parsed = deleteMessageSchema.safeParse(input);
  if (!parsed.success) return messageError(parsed.error.issues.map((issue) => issue.message).join(" "));

  if (context.mode === "demo") {
    try {
      await updateDemoStore((data) => {
        const message = (data.chatMessages ?? []).find((item) => item.id === parsed.data.messageId && item.senderId === context.user.id);
        if (!message) throw new Error("You can only delete your own messages.");
        const withinGracePeriod = Date.now() - Date.parse(message.createdAt) < 10_000;
        const hasBeenRead = (message.receipts ?? []).some((receipt) => receipt.userId !== context.user.id);
        if (!withinGracePeriod && hasBeenRead) throw new Error("This message can no longer be deleted because it has been read.");
        data.chatMessages = (data.chatMessages ?? []).filter((item) => item.id !== message.id);
      });
    } catch (error) {
      return messageError(error instanceof Error ? error.message : "This message could not be deleted.", 403);
    }
    return NextResponse.json({ deletedMessageId: parsed.data.messageId });
  }

  if (!hasSupabaseAdminConfig()) return messageError("Message deletion is not configured on the server.", 503);
  const admin = createSupabaseAdminClient();
  const { data: message, error: messageErrorResult } = await admin.from("crew_chat_messages")
    .select("id,sender_id,created_at,attachments")
    .eq("id", parsed.data.messageId)
    .eq("sender_id", context.user.id)
    .maybeSingle();
  if (messageErrorResult) return messageError("This message could not be checked for deletion.", 503);
  if (!message) return messageError("You can only delete your own messages.", 403);

  const { data: readers, error: receiptError } = await admin.from("crew_chat_message_receipts")
    .select("user_id")
    .eq("message_id", message.id)
    .neq("user_id", context.user.id)
    .limit(1);
  if (receiptError) return messageError("Read status could not be checked, so the message was kept.", 503);
  const withinGracePeriod = Date.now() - Date.parse(message.created_at) < 10_000;
  if (!withinGracePeriod && (readers ?? []).length > 0) {
    return messageError("This message can no longer be deleted because it has been read.", 409);
  }

  const { data: deleted, error: deleteError } = await admin.from("crew_chat_messages")
    .delete()
    .eq("id", message.id)
    .eq("sender_id", context.user.id)
    .select("id")
    .maybeSingle();
  if (deleteError) return messageError("This message could not be deleted.", 503);
  if (!deleted) return messageError("This message is no longer available.", 404);

  const attachmentPaths = ((message.attachments ?? []) as ChatAttachment[])
    .map((attachment) => attachment.path)
    .filter((path): path is string => typeof path === "string" && path.startsWith(`${context.user.id}/chat/`));
  let warning: string | undefined;
  if (attachmentPaths.length) {
    const { error: storageError } = await admin.storage.from("crew-media").remove(attachmentPaths);
    if (storageError) warning = "The message was deleted, but its attached files could not be removed.";
  }
  return NextResponse.json({ deletedMessageId: message.id, warning });
}
