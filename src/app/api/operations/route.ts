import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionContext } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { addAudit, updateDemoStore } from "@/lib/store";
import { can, canIssueEquipment } from "@/lib/policy.mjs";
import type { AppData, AppRole, ChecklistItem, ChecklistTemplate, ChecklistTemplateTask, EquipmentLoan, EquipmentTemplate, EquipmentTemplateItem, Incident, MediaEvent } from "@/lib/types";
import { hasAccessRole, hasManagerAccess } from "@/lib/roles";
import { syncNewEquipmentToSheet } from "@/lib/google-sheets-equipment";
import { hasChecklistTemplateNameConflict } from "@/lib/checklist-templates.mjs";
import { CHECKLIST_PROGRAM_PHASES, normalizeChecklistProgramPhase, orderChecklistProgramPhases } from "@/lib/checklist-phases.mjs";

const actionSchema = z.object({ action: z.string(), payload: z.record(z.string(), z.unknown()).default({}) });
const optionalEventTimeSchema = z.string().regex(/^(?:\d{2}:\d{2})?$/).default("");
const eventSchema = z.object({
  title: z.string().trim().min(3).max(120), category: z.string().trim().min(1).max(80), date: z.iso.date(),
  startTime: optionalEventTimeSchema, endTime: optionalEventTimeSchema,
  setupTime: optionalEventTimeSchema, timeZone: z.string().min(1).max(80), venue: z.string().trim().min(2).max(120),
  leadId: z.string().default(""), description: z.string().max(2000).default(""),
  livestream: z.boolean().default(false), recording: z.boolean().default(false), photography: z.boolean().default(false),
  publicInfo: z.string().max(1200).default(""), privateNotes: z.string().max(3000).default(""),
});
const checklistItemCreateSchema = z.object({ eventId: z.string().min(1), userId: z.string().min(1), label: z.string().trim().min(2).max(240), required: z.preprocess((value) => value === true || value === "true" || value === "on", z.boolean()), programPhase: z.enum(CHECKLIST_PROGRAM_PHASES).optional() });
const checklistItemUpdateSchema = checklistItemCreateSchema.omit({ eventId: true, userId: true }).extend({ itemId: z.string().min(1) });
const eventProgramPhaseSchema = z.object({ eventId: z.string().min(1), programPhase: z.enum(CHECKLIST_PROGRAM_PHASES) });
const checklistItemDeleteSchema = z.object({ itemId: z.string().min(1) });
const checklistTemplateTaskSchema = z.object({ id: z.string().min(1).max(80).optional(), label: z.string().trim().min(2).max(240), required: z.boolean().default(true) });
const checklistTemplateSchema = z.object({ name: z.string().trim().min(2).max(120), category: z.enum(CHECKLIST_PROGRAM_PHASES).default("Pre-event"), tasks: z.array(checklistTemplateTaskSchema).min(1).max(60) });
const checklistTemplateUpdateSchema = checklistTemplateSchema.extend({ templateId: z.string().min(1) });
const checklistTemplateIdSchema = z.object({ templateId: z.string().min(1) });
const quickAssignChecklistSchema = z.object({ templateId: z.string().min(1), eventId: z.string().min(1), userId: z.string().min(1), tasks: z.array(checklistTemplateTaskSchema).min(1).max(60) });
const deleteEventSchema = z.object({ eventId: z.string().min(1) });
const assetSchema = z.object({ assetCode: z.string().trim().min(3).max(40), name: z.string().trim().min(2).max(120), category: z.string().min(1), location: z.string().max(120).default(""), model: z.string().max(100).default(""), serial: z.string().max(100).default(""), quantity: z.coerce.number().int().min(1).max(10000).default(1), condition: z.enum(["Good", "Needs service", "Damaged"]).default("Good"), notes: z.string().max(1000).default("") });
const assetUpdateSchema = z.object({ assetId: z.string().min(1) }).merge(assetSchema);
const deleteAssetSchema = z.object({ assetId: z.string().min(1) });
const equipmentHistoryDeleteSchema = z.object({ assetId: z.string().min(1), loanId: z.string().min(1).optional() });
const issueEquipmentSchema = z.object({ assetId: z.string().min(1), borrowerId: z.string().min(1), handoffDate: z.iso.date(), timeZone: z.string().min(1).max(80).default("UTC"), dueDate: z.preprocess((value) => value === "" || value == null ? undefined : value, z.iso.date().optional()), quantity: z.coerce.number().int().min(1).max(10000).default(1), checkoutNotes: z.string().trim().max(1000).default("") });
const equipmentTemplateItemSchema = z.object({ id: z.string().min(1).max(80).optional(), assetId: z.string().min(1), quantity: z.coerce.number().int().min(1).max(10000) });
const equipmentTemplateItemsSchema = z.array(equipmentTemplateItemSchema).min(1).max(100).refine((items) => new Set(items.map((item) => item.assetId)).size === items.length, "Add each equipment item only once.");
const equipmentTemplateSchema = z.object({ name: z.string().trim().min(2).max(120), items: equipmentTemplateItemsSchema });
const equipmentTemplateUpdateSchema = equipmentTemplateSchema.extend({ templateId: z.string().min(1) });
const quickAssignEquipmentSchema = z.object({ templateId: z.string().min(1), borrowerId: z.string().min(1), handoffDate: z.iso.date(), timeZone: z.string().min(1).max(80).default("UTC"), dueDate: z.preprocess((value) => value === "" || value == null ? undefined : value, z.iso.date().optional()), checkoutNotes: z.string().trim().max(1000).default(""), items: equipmentTemplateItemsSchema });
const returnEquipmentSchema = z.object({ loanId: z.string().min(1), condition: z.enum(["Good", "Needs service", "Damaged"]), notes: z.string().trim().max(1000).default("") });
const incidentPhotoSchema = z.string().startsWith("data:image/jpeg;base64,").max(500_000);
const incidentSchema = z.object({ eventId: z.preprocess((value) => value === "" ? undefined : value, z.string().optional()), assetId: z.preprocess((value) => value === "" ? undefined : value, z.string().optional()), category: z.string().min(1), severity: z.enum(["Low", "Medium", "High", "Critical"]), description: z.string().trim().min(1).max(2000), immediateAction: z.string().max(1000).default(""), photos: z.array(incidentPhotoSchema).max(5).default([]) });
const incidentEditSchema = z.object({ incidentId: z.string().min(1), eventId: z.preprocess((value) => value === "" ? undefined : value, z.string().optional()), assetId: z.preprocess((value) => value === "" ? undefined : value, z.string().optional()), category: z.string().trim().min(1).max(120), severity: z.enum(["Low", "Medium", "High", "Critical"]), description: z.string().trim().min(1).max(2000), immediateAction: z.string().max(1000).default(""), photos: z.array(incidentPhotoSchema).max(5).default([]), status: z.enum(["Open", "Acknowledged", "In progress", "Resolved", "Closed"]), resolution: z.string().trim().max(2000).default("") });
const incidentCompletionSchema = z.object({ incidentId: z.string().min(1), resolution: z.string().trim().min(1).max(2000), photos: z.array(incidentPhotoSchema).max(5).default([]) });
const incidentDeleteSchema = z.object({ incidentId: z.string().min(1) });
const categorySchema = z.object({ categoryType: z.enum(["equipment", "sops", "incidents", "checklists", "events"]), category: z.string().trim().min(2).max(80) });
const categoryOrderSchema = z.object({ categoryType: z.enum(["equipment", "sops", "incidents", "checklists", "events"]), categories: z.array(z.string().trim().min(2).max(80)).min(1).max(100) });
const serviceHistorySchema = z.object({ assignmentId: z.string().min(1) });
const resetMemberHistorySchema = z.object({ userId: z.string().min(1) });
const timeAlarmSchema = z.object({
  userId: z.string().optional(),
  scheduleMode: z.enum(["countdown", "clock"]).default("countdown"),
  date: z.preprocess((value) => value === "" || value == null ? undefined : value, z.iso.date().optional()),
  time: z.preprocess((value) => value === "" || value == null ? undefined : value, z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional()),
  minutes: z.preprocess((value) => value === "" || value == null ? undefined : value, z.coerce.number().int().min(1).max(10080).optional()),
  description: z.string().trim().min(1).max(180),
}).superRefine((values, context) => {
  if (values.scheduleMode === "clock" && !values.date) context.addIssue({ code: "custom", path: ["date"], message: "Choose a date for this clock-time alarm." });
  if (values.scheduleMode === "clock" && !values.time) context.addIssue({ code: "custom", path: ["time"], message: "Choose a clock time for this alarm." });
  if (values.scheduleMode === "countdown" && values.minutes === undefined) context.addIssue({ code: "custom", path: ["minutes"], message: "Choose how many minutes from now." });
});
const timeAlarmIdSchema = z.object({ alarmId: z.string().min(1) });
const sopAudienceSchema = z.object({ sopId: z.string().min(1), assignedUserIds: z.array(z.string().min(1)).max(100), availableToAll: z.boolean() });
const defaultCategories: NonNullable<AppData["categories"]> = { equipment: ["Camera", "Audio", "Wiring", "Video", "Lighting", "Other"], sops: ["Production", "Audio", "Video", "Livestream & recording", "Equipment", "Operations", "Safety"], incidents: ["Equipment damage", "Audio issue", "Video issue", "Stream interruption", "Recording issue", "Network", "Other"], checklists: [...CHECKLIST_PROGRAM_PHASES], events: ["Happy", "Sad", "General"] };
function checklistPhases(data: AppData) { return orderChecklistProgramPhases(data.categories?.checklists); }
function validateChecklistPhase(data: AppData, phase: string) {
  if (!checklistPhases(data).some((current) => current === phase)) throw new AppError("Choose one of the five program phases.");
}
function mayManageCategories(roles: AppRole[] | AppRole) { const values = Array.isArray(roles) ? roles : [roles]; return hasManagerAccess(values, values[0] ?? "Videographer") || values.includes("Equipment Manager"); }

class AppError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
async function syncEquipmentSheetRow(values: z.infer<typeof assetSchema>) {
  try {
    return await syncNewEquipmentToSheet({ assetCode: values.assetCode, serial: values.serial, category: values.category, model: values.model, name: values.name, quantity: values.quantity, notes: values.notes });
  } catch (error) {
    throw new AppError(error instanceof Error ? error.message : "Google Sheets could not save the equipment item.", 503);
  }
}
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const sharedTimeZone = "America/New_York";
function dateTime(date: string, time: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]));
    const observed = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    guess += target - observed;
  }
  return new Date(guess).toISOString();
}
function alarmFireAt(values: z.infer<typeof timeAlarmSchema>, baseNow = Date.now()) {
  if (values.scheduleMode === "countdown") return new Date(baseNow + (values.minutes ?? 20) * 60_000).toISOString();
  if (!values.date || !values.time) throw new AppError("Choose a date and clock time for this alarm.");
  return dateTime(values.date, values.time, sharedTimeZone);
}
function currentTimeInTimezone(timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.hour}:${values.minute}`;
}
function currentDateInTimezone(timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
const displayDateSafe = (value: string) => new Date(`${value}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const includesCapability = (roles: AppRole | AppRole[], capability: string) => can(roles, capability);
function requireCapability(roles: AppRole | AppRole[], capability: string) {
  if (!includesCapability(roles, capability)) throw new AppError("You do not have permission to complete this action.", 403);
}
function record<T>(schema: z.ZodType<T>, value: Record<string, unknown>): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError(parsed.error.issues.map((issue) => issue.message).join(" "));
  return parsed.data;
}
function validateTimezone(timeZone: string) {
  try { new Intl.DateTimeFormat("en-US", { timeZone }); }
  catch { throw new AppError("Enter a valid event timezone, such as America/New_York."); }
}
function audit(data: AppData, actorId: string, action: string, target: string, targetId: string) {
  addAudit(data, actorId, action, target, targetId);
}
function addNotification(data: AppData, userId: string, title: string, detail: string, href: string, senderId?: string) {
  data.notifications.unshift({ id: id(), userId, senderId, title, detail, date: now(), read: false, href });
}
function notifyEquipmentCrew(data: AppData, actorId: string, detail: string, excludedUserId?: string) {
  for (const profile of data.profiles) {
    if (profile.id !== actorId && profile.id !== excludedUserId && profile.active !== false && (hasManagerAccess(profile.accessRoles, profile.role) || hasAccessRole(profile.accessRoles, profile.role, "Equipment Manager"))) addNotification(data, profile.id, "Equipment updated", detail, "equipment", actorId);
  }
}
function validateEventSchedule(values: z.infer<typeof eventSchema>) {
  if (Boolean(values.startTime) !== Boolean(values.endTime)) throw new AppError("Enter both an event start time and end time, or leave both for later.");
  if (values.startTime && values.endTime && new Date(`${values.date}T${values.startTime}:00`) >= new Date(`${values.date}T${values.endTime}:00`)) throw new AppError("End time must be after start time.");
}
function validateEventLead(data: AppData, leadId: string) {
  if (leadId && !data.profiles.some((profile) => profile.id === leadId && profile.active !== false)) throw new AppError("Choose an active team member or leave the event unassigned.");
}
function publishEvent(data: AppData, event: MediaEvent, actorId: string) {
  event.status = "Published";
  const recipients = new Set(data.checklistItems.filter((row) => row.eventId === event.id).map((row) => row.userId));
  data.assignments.filter((row) => row.eventId === event.id).forEach((row) => recipients.add(row.userId));
  if (event.leadId) recipients.add(event.leadId);
  for (const userId of recipients) if (userId !== actorId) addNotification(data, userId, "Schedule published", event.title, "events", actorId);
}

function selectedCrewIds(data: AppData, payload: Record<string, unknown>, eventId?: string) {
  const activeIds = data.profiles.filter((profile) => profile.active !== false).map((profile) => profile.id);
  const existing = eventId ? data.assignments.filter((item) => item.eventId === eventId).map((item) => item.userId) : [];
  const requested = payload.assignedUserIds;
  const ids = Array.isArray(requested) ? [...new Set(requested.filter((value): value is string => typeof value === "string"))] : existing.length ? existing : activeIds;
  if (ids.some((memberId) => !activeIds.includes(memberId))) throw new AppError("Choose active team members for this event.");
  return ids;
}

function updateEventCrew(data: AppData, event: MediaEvent, memberIds: string[], actorId: string) {
  const activeMembers = new Map(data.profiles.filter((profile) => profile.active !== false).map((profile) => [profile.id, profile]));
  const existing = data.assignments.filter((assignment) => assignment.eventId === event.id);
  const existingByMember = new Map(existing.map((assignment) => [assignment.userId, assignment]));
  const selected = new Set(memberIds);
  data.assignments = data.assignments.filter((assignment) => assignment.eventId !== event.id || selected.has(assignment.userId));
  for (const memberId of memberIds) {
    const person = activeMembers.get(memberId);
    if (!person) continue;
    const assignment = existingByMember.get(memberId);
    if (assignment) {
      assignment.roleName = person.jobTitle || person.role;
      assignment.arrivalTime = event.setupTime || undefined;
      continue;
    }
    data.assignments.push({ id: id(), eventId: event.id, userId: memberId, roleName: person.jobTitle || person.role, arrivalTime: event.setupTime || undefined, instructions: "", response: "Pending" });
    if (memberId !== actorId) addNotification(data, memberId, "New event assignment", `${event.title} · ${displayDateSafe(event.date)}`, "events", actorId);
  }
  for (const assignment of existing) if (!selected.has(assignment.userId) && assignment.userId !== actorId) addNotification(data, assignment.userId, "Event assignment updated", `You are no longer assigned to ${event.title}.`, "events", actorId);
}

function normalizeTemplateTasks(tasks: Array<z.infer<typeof checklistTemplateTaskSchema>>): ChecklistTemplateTask[] {
  return tasks.map((task) => ({ id: task.id ?? id(), label: task.label, required: task.required }));
}
function normalizeEquipmentTemplateItems(items: Array<z.infer<typeof equipmentTemplateItemSchema>>): EquipmentTemplateItem[] {
  return items.map((item) => ({ id: item.id ?? id(), assetId: item.assetId, quantity: item.quantity }));
}

async function runDemo(action: string, payload: Record<string, unknown>, user: { id: string; role: AppRole; accessRoles?: AppRole[] }) {
  return updateDemoStore(async (data) => {
    const p = payload;
    const notify = (store: AppData, recipientId: string, title: string, detail: string, href: string) => addNotification(store, recipientId, title, detail, href, user.id);
    switch (action) {
      case "create_time_alarm": {
        const values = record(timeAlarmSchema, p);
        const canManage = hasManagerAccess(user.accessRoles, user.role);
        const targetUserId = canManage ? values.userId || user.id : user.id;
        if (values.userId && values.userId !== user.id && !canManage) throw new AppError("Only the administrator or director can set an alarm for another member.", 403);
        if (!data.profiles.some((profile) => profile.id === targetUserId && profile.active !== false)) throw new AppError("Choose an active team member.");
        const fireAt = alarmFireAt(values);
        if (Date.parse(fireAt) <= Date.now()) throw new AppError("Choose a future time for this alarm.");
        const alarm = { id: id(), userId: targetUserId, createdBy: user.id, fireAt, description: values.description };
        data.timeAlarms ??= [];
        data.timeAlarms.push(alarm);
        audit(data, user.id, "Scheduled time alarm", "time_alarm", alarm.id);
        return { ok: true, alarmId: alarm.id };
      }
      case "cancel_time_alarm": {
        const values = record(timeAlarmIdSchema, p);
        const alarm = (data.timeAlarms ?? []).find((item) => item.id === values.alarmId);
        if (!alarm) throw new AppError("Alarm not found.", 404);
        if (alarm.userId !== user.id && !hasManagerAccess(user.accessRoles, user.role)) throw new AppError("You can only cancel your own alarms.", 403);
        if (!alarm.triggeredAt) alarm.cancelledAt = now();
        audit(data, user.id, "Cancelled time alarm", "time_alarm", alarm.id);
        return { ok: true };
      }
      case "complete_time_alarm": {
        const values = record(timeAlarmIdSchema, p);
        const alarm = (data.timeAlarms ?? []).find((item) => item.id === values.alarmId);
        if (!alarm) throw new AppError("Alarm not found.", 404);
        if (alarm.userId !== user.id) throw new AppError("Only the person assigned this alarm can mark it complete.", 403);
        if (!alarm.triggeredAt) throw new AppError("This alarm is not due yet.");
        alarm.completedAt ??= now();
        const alarmHref = `time-alarm:${alarm.id}`;
        const alarmNotification = data.notifications.find((item) => item.userId === user.id && item.href === alarmHref);
        if (alarmNotification) { alarmNotification.read = true; alarmNotification.readAt = now(); }
        audit(data, user.id, "Completed time alarm task", "time_alarm", alarm.id);
        return { ok: true };
      }
      case "process_due_alarms": {
        const current = Date.now();
        const manager = hasManagerAccess(user.accessRoles, user.role);
        const due = (data.timeAlarms ?? []).filter((alarm) => (alarm.userId === user.id || manager) && !alarm.cancelledAt && !alarm.completedAt && !alarm.triggeredAt && Date.parse(alarm.fireAt) <= current);
        for (const alarm of due) {
          alarm.triggeredAt = now();
          addNotification(data, alarm.userId, `Alarm: ${alarm.description}`, `Your alarm is due · ${new Intl.DateTimeFormat("en-US", { timeZone: sharedTimeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(alarm.fireAt))} center time`, `time-alarm:${alarm.id}`, alarm.createdBy);
        }
        return { ok: true, triggered: due.length };
      }
      case "add_category":
      case "delete_category": {
        const values = record(categorySchema, p);
        if (!mayManageCategories(user.accessRoles ?? user.role)) throw new AppError("Only the administrator, director, or equipment manager can manage categories.", 403);
        if (values.categoryType === "checklists") throw new AppError("The five checklist phases cannot be added or removed. You can change their order.");
        data.categories ??= structuredClone(defaultCategories);
        const categories = data.categories[values.categoryType];
        if (action === "add_category") {
          if (categories.some((category) => category.toLocaleLowerCase() === values.category.toLocaleLowerCase())) throw new AppError("That category already exists.", 409);
          categories.push(values.category);
          audit(data, user.id, `Added ${values.categoryType} category`, "category", values.categoryType);
        } else {
          if (categories.length <= 1) throw new AppError("Keep at least one category in each list.");
          const index = categories.findIndex((category) => category.toLocaleLowerCase() === values.category.toLocaleLowerCase());
          if (index < 0) throw new AppError("Category not found.", 404);
          categories.splice(index, 1);
          audit(data, user.id, `Removed ${values.categoryType} category`, "category", values.categoryType);
        }
        return { ok: true };
      }
      case "reorder_categories": {
        const values = record(categoryOrderSchema, p);
        if (!mayManageCategories(user.accessRoles ?? user.role)) throw new AppError("Only the administrator, director, or equipment manager can manage categories.", 403);
        data.categories ??= structuredClone(defaultCategories);
        if (values.categoryType === "checklists" && (values.categories.length !== CHECKLIST_PROGRAM_PHASES.length || CHECKLIST_PROGRAM_PHASES.some((phase) => !values.categories.includes(phase)))) throw new AppError("Keep all five program phases when changing their order.", 409);
        const existing = data.categories[values.categoryType];
        if (values.categories.length !== existing.length || new Set(values.categories).size !== existing.length || existing.some((category) => !values.categories.includes(category))) throw new AppError("The category list changed. Reload it and try again.", 409);
        data.categories[values.categoryType] = values.categories;
        audit(data, user.id, `Reordered ${values.categoryType} categories`, "category", values.categoryType);
        return { ok: true };
      }
      case "set_event_response": {
        const assignmentId = String(p.assignmentId ?? "");
        const response = p.response;
        if (!assignmentId || !["Accepted", "Declined"].includes(String(response))) throw new AppError("Choose whether you can attend.");
        const assignment = data.assignments.find((item) => item.id === assignmentId && item.userId === user.id);
        const event = assignment && data.events.find((item) => item.id === assignment.eventId);
        if (!assignment || !event || event.status !== "Published") throw new AppError("Only your published event assignments can be updated.", 403);
        assignment.response = response as "Accepted" | "Declined";
        for (const manager of data.profiles.filter((profile) => profile.id !== user.id && hasManagerAccess(profile.accessRoles, profile.role))) notify(data, manager.id, "Event attendance response", `${data.profiles.find((profile) => profile.id === user.id)?.fullName ?? "A team member"} · ${event.title} · ${assignment.response}`, "events");
        audit(data, user.id, `Responded ${assignment.response.toLowerCase()} to event`, "event_assignment", assignment.id);
        return { ok: true };
      }
      case "set_event_program_phase": {
        requireCapability(user.accessRoles ?? user.role, "manage_events");
        const values = record(eventProgramPhaseSchema, p);
        validateChecklistPhase(data, values.programPhase);
        const event = data.events.find((row) => row.id === values.eventId);
        if (!event) throw new AppError("Event not found.", 404);
        const previousPhase = event.programPhase ?? checklistPhases(data)[0];
        event.programPhase = values.programPhase;
        if (previousPhase !== values.programPhase) {
          const crewIds = new Set(data.assignments.filter((assignment) => assignment.eventId === event.id).map((assignment) => assignment.userId));
          for (const memberId of crewIds) if (memberId !== user.id) notify(data, memberId, "Program phase updated", `${event.title} · ${values.programPhase}`, "events");
          audit(data, user.id, `Changed program phase to ${values.programPhase}`, "event", event.id);
        }
        return { ok: true };
      }
      case "create_event": {
        requireCapability(user.accessRoles ?? user.role, "manage_events");
        const values = record(eventSchema, p);
        validateTimezone(values.timeZone);
        validateEventSchedule(values);
        validateEventLead(data, values.leadId);
        const event: MediaEvent = { id: id(), ...values, status: "Planning", programPhase: checklistPhases(data)[0] };
        data.events.unshift(event);
        updateEventCrew(data, event, selectedCrewIds(data, p), user.id);
        audit(data, user.id, "Created event", "event", event.id);
        return { ok: true, id: event.id };
      }
      case "publish_event": {
        requireCapability(user.accessRoles ?? user.role, "manage_events");
        const event = data.events.find((row) => row.id === p.eventId);
        if (!event) throw new AppError("Event not found.", 404);
        if (!event.startTime || !event.endTime || !event.setupTime || event.venue === "To be confirmed") throw new AppError("Add the event times and venue before publishing the schedule.");
        publishEvent(data, event, user.id);
        audit(data, user.id, "Published schedule", "event", event.id);
        return { ok: true };
      }
      case "delete_event": {
        if (!hasManagerAccess(user.accessRoles, user.role)) throw new AppError("Only the administrator or director can delete events.", 403);
        const { eventId } = record(deleteEventSchema, p);
        const index = data.events.findIndex((row) => row.id === eventId);
        if (index < 0) throw new AppError("Event not found.", 404);
        const [event] = data.events.splice(index, 1);
        data.assignments = (data.assignments ?? []).filter((row) => row.eventId !== eventId);
        data.checklistItems = (data.checklistItems ?? []).filter((row) => row.eventId !== eventId);
        data.content = (data.content ?? []).filter((row) => row.eventId !== eventId);
        data.incidents = (data.incidents ?? []).map((row) => row.eventId === eventId ? { ...row, eventId: undefined } : row);
        data.notifications = (data.notifications ?? []).filter((row) => !(row.href === "events" && row.detail.includes(event.title)));
        audit(data, user.id, "Deleted event", "event", eventId);
        return { ok: true };
      }
      case "update_event": {
        requireCapability(user.accessRoles ?? user.role, "manage_events");
        const values = record(eventSchema, p);
        validateTimezone(values.timeZone);
        const event = data.events.find((row) => row.id === p.eventId);
        if (!event) throw new AppError("Event not found.", 404);
        validateEventSchedule(values);
        validateEventLead(data, values.leadId);
        const changedSchedule = event.title !== values.title || event.category !== values.category || event.date !== values.date || event.startTime !== values.startTime || event.endTime !== values.endTime || event.venue !== values.venue || event.timeZone !== values.timeZone;
        const previousLeadId = event.leadId;
        const leadChanged = previousLeadId !== values.leadId;
        const previousCrewIds = new Set(data.assignments.filter((row) => row.eventId === event.id).map((row) => row.userId));
        const assignedUserIds = selectedCrewIds(data, p, event.id);
        Object.assign(event, values);
        updateEventCrew(data, event, assignedUserIds, user.id);
        if (changedSchedule) for (const userId of new Set([...data.checklistItems.filter((row) => row.eventId === event.id).map((row) => row.userId), ...assignedUserIds.filter((id) => previousCrewIds.has(id))])) if (userId !== user.id) notify(data, userId, "Event schedule updated", `${event.title} · ${displayDateSafe(event.date)} · ${event.venue}`, "events");
        if (leadChanged && values.leadId && values.leadId !== user.id) notify(data, values.leadId, "New event to lead", `${event.title} · ${displayDateSafe(event.date)}`, "events");
        if (leadChanged && previousLeadId && previousLeadId !== user.id && previousLeadId !== values.leadId) notify(data, previousLeadId, "Event lead changed", `${event.title} is no longer assigned to you.`, "events");
        audit(data, user.id, "Updated event", "event", event.id);
        return { ok: true };
      }
      case "complete_checklist_item": {
        requireCapability(user.accessRoles ?? user.role, "complete_checklists");
        const item = data.checklistItems.find((row) => row.id === p.itemId);
        if (!item) throw new AppError("Checklist item not found.", 404);
        if (item.userId !== user.id && !hasManagerAccess(user.accessRoles, user.role)) throw new AppError("You can only update your assigned checklist.", 403);
        const status = p.status;
        if (!["Complete", "Needs attention", "Outstanding"].includes(String(status))) throw new AppError("Choose a valid checklist state.");
        const note = String(p.note ?? "").trim();
        if (status === "Needs attention" && item.required && note.length < 5) throw new AppError("Add a note describing the issue before reporting a failed check.");
        item.status = status as ChecklistItem["status"];
        item.note = note || (status === "Complete" ? item.note : undefined);
        item.completedAt = status === "Outstanding" ? undefined : now();
        audit(data, user.id, status === "Needs attention" ? "Flagged checklist item" : "Updated checklist item", "checklist_item", item.id);
        return { ok: true };
      }
      case "create_checklist_item": {
        if (!hasManagerAccess(user.accessRoles, user.role)) throw new AppError("Only the administrator or director can add checklist items.", 403);
        const values = record(checklistItemCreateSchema, p);
        const event = data.events.find((row) => row.id === values.eventId);
        const profile = data.profiles.find((row) => row.id === values.userId && row.active !== false);
        if (!event || !profile) throw new AppError("Choose a valid event and active team member.");
        const phases = checklistPhases(data);
        const programPhase = normalizeChecklistProgramPhase(values.programPhase) ?? normalizeChecklistProgramPhase(event.programPhase) ?? phases[0];
        validateChecklistPhase(data, programPhase);
        const item: ChecklistItem = { id: id(), eventId: event.id, userId: profile.id, label: values.label, required: values.required, status: "Outstanding", programPhase };
        data.checklistItems.push(item);
        notify(data, profile.id, "New checklist item", `${event.title} · ${values.label}`, "checklists");
        audit(data, user.id, "Added checklist item", "checklist_item", item.id);
        return { ok: true, id: item.id };
      }
      case "update_checklist_item": {
        if (!hasManagerAccess(user.accessRoles, user.role)) throw new AppError("Only the administrator or director can edit checklist items.", 403);
        const values = record(checklistItemUpdateSchema, p);
        const item = data.checklistItems.find((row) => row.id === values.itemId);
        if (!item) throw new AppError("Checklist item not found.", 404);
        item.label = values.label;
        item.required = values.required;
        if (values.programPhase) {
          if (values.programPhase !== item.programPhase) validateChecklistPhase(data, values.programPhase);
          item.programPhase = values.programPhase;
        }
        notify(data, item.userId, "Checklist item updated", item.label, "checklists");
        audit(data, user.id, "Edited checklist item", "checklist_item", item.id);
        return { ok: true };
      }
      case "delete_checklist_item": {
        if (!hasManagerAccess(user.accessRoles, user.role)) throw new AppError("Only the administrator or director can remove checklist items.", 403);
        const { itemId } = record(checklistItemDeleteSchema, p);
        const index = data.checklistItems.findIndex((row) => row.id === itemId);
        if (index < 0) throw new AppError("Checklist item not found.", 404);
        const [item] = data.checklistItems.splice(index, 1);
        audit(data, user.id, "Removed checklist item", "checklist_item", item.id);
        return { ok: true };
      }
      case "clear_completed_checklists": {
        if (!hasManagerAccess(user.accessRoles, user.role)) throw new AppError("Only the administrator or director can clear completed checklists.", 403);
        let count = 0;
        for (const item of data.checklistItems) if (item.status === "Complete" && !item.clearedFromChecklist) { item.clearedFromChecklist = true; count += 1; }
        audit(data, user.id, "Cleared completed checklist items from active view", "checklist", "completed");
        return { ok: true, count };
      }
      case "hide_service_history": {
        if (!hasManagerAccess(user.accessRoles, user.role)) throw new AppError("Only the administrator or director can manage service history.", 403);
        const { assignmentId } = record(serviceHistorySchema, p);
        const assignment = data.assignments.find((item) => item.id === assignmentId);
        if (!assignment) throw new AppError("Service history entry not found.", 404);
        assignment.serviceHistoryHidden = true;
        audit(data, user.id, "Removed an assignment from the service history view", "role_assignment", assignment.id);
        return { ok: true };
      }
      case "reset_member_service_history": {
        if (!hasManagerAccess(user.accessRoles, user.role)) throw new AppError("Only the administrator or director can reset service history.", 403);
        const { userId } = record(resetMemberHistorySchema, p);
        if (!data.profiles.some((profile) => profile.id === userId)) throw new AppError("Team member not found.", 404);
        for (const assignment of data.assignments) {
          if (assignment.userId !== userId) continue;
          const event = data.events.find((item) => item.id === assignment.eventId);
          if (event && event.status !== "Cancelled" && (event.status === "Completed" || event.date < new Date().toISOString().slice(0, 10))) assignment.serviceHistoryHidden = true;
        }
        for (const item of data.checklistItems) if (item.userId === userId && item.status === "Complete") item.serviceHistoryHidden = true;
        audit(data, user.id, "Reset team member service history view", "profile", userId);
        return { ok: true };
      }
      case "create_checklist_template": {
        requireCapability(user.accessRoles ?? user.role, "manage_checklists");
        const values = record(checklistTemplateSchema, p);
        if (hasChecklistTemplateNameConflict(data.checklistTemplates, values.name, values.category)) throw new AppError("A checklist template with that name already exists in this stage.", 409);
        const timestamp = now();
        const template: ChecklistTemplate = { id: id(), name: values.name, category: values.category, tasks: normalizeTemplateTasks(values.tasks), createdBy: user.id, createdAt: timestamp, updatedAt: timestamp };
        data.checklistTemplates.unshift(template);
        audit(data, user.id, "Created checklist template", "checklist_template", template.id);
        return { ok: true, id: template.id };
      }
      case "update_checklist_template": {
        requireCapability(user.accessRoles ?? user.role, "manage_checklists");
        const values = record(checklistTemplateUpdateSchema, p);
        if (hasChecklistTemplateNameConflict(data.checklistTemplates, values.name, values.category, values.templateId)) throw new AppError("A checklist template with that name already exists in this stage.", 409);
        const template = data.checklistTemplates.find((item) => item.id === values.templateId);
        if (!template) throw new AppError("Checklist template not found.", 404);
        template.name = values.name;
        template.category = values.category;
        template.tasks = normalizeTemplateTasks(values.tasks);
        template.updatedAt = now();
        audit(data, user.id, "Updated checklist template", "checklist_template", template.id);
        return { ok: true };
      }
      case "duplicate_checklist_template": {
        requireCapability(user.accessRoles ?? user.role, "manage_checklists");
        const { templateId } = record(checklistTemplateIdSchema, p);
        const source = data.checklistTemplates.find((item) => item.id === templateId);
        if (!source) throw new AppError("Checklist template not found.", 404);
        const timestamp = now();
        const duplicate: ChecklistTemplate = { ...source, id: id(), name: `Copy of ${source.name}`, tasks: source.tasks.map((task) => ({ ...task, id: id() })), createdBy: user.id, createdAt: timestamp, updatedAt: timestamp };
        data.checklistTemplates.unshift(duplicate);
        audit(data, user.id, "Duplicated checklist template", "checklist_template", duplicate.id);
        return { ok: true, id: duplicate.id };
      }
      case "delete_checklist_template": {
        requireCapability(user.accessRoles ?? user.role, "manage_checklists");
        const { templateId } = record(checklistTemplateIdSchema, p);
        const index = data.checklistTemplates.findIndex((item) => item.id === templateId);
        if (index < 0) throw new AppError("Checklist template not found.", 404);
        const [template] = data.checklistTemplates.splice(index, 1);
        audit(data, user.id, "Deleted checklist template", "checklist_template", template.id);
        return { ok: true };
      }
      case "quick_assign_checklist": {
        requireCapability(user.accessRoles ?? user.role, "manage_checklists");
        const values = record(quickAssignChecklistSchema, p);
        const template = data.checklistTemplates.find((item) => item.id === values.templateId);
        const event = data.events.find((item) => item.id === values.eventId && !["Completed", "Cancelled"].includes(item.status));
        const person = data.profiles.find((item) => item.id === values.userId && item.active !== false);
        if (!template || !event || !person) throw new AppError("Choose a saved template, upcoming event, and active team member.");
        const assignment = data.assignments.find((item) => item.eventId === event.id && item.userId === person.id);
        const tasks = normalizeTemplateTasks(values.tasks);
        const phases = checklistPhases(data);
        const programPhase = normalizeChecklistProgramPhase(template.category) ?? normalizeChecklistProgramPhase(event.programPhase) ?? phases[0];
        const created = tasks.map((task): ChecklistItem => ({ id: id(), eventId: event.id, assignmentId: assignment?.id, userId: person.id, label: task.label, required: task.required, status: "Outstanding", programPhase }));
        data.checklistItems.push(...created);
        notify(data, person.id, "Checklist assigned", `${event.title} · ${template.name} · ${created.length} task${created.length === 1 ? "" : "s"}`, "checklists");
        audit(data, user.id, `Assigned checklist template ${template.name}`, "checklist_template_assignment", event.id);
        return { ok: true, count: created.length };
      }
      case "create_equipment_template": {
        requireCapability(user.accessRoles ?? user.role, "manage_equipment");
        const values = record(equipmentTemplateSchema, p);
        data.equipmentTemplates ??= [];
        if (data.equipmentTemplates.some((item) => item.name.toLocaleLowerCase() === values.name.toLocaleLowerCase())) throw new AppError("An equipment template with that name already exists.", 409);
        const items = normalizeEquipmentTemplateItems(values.items);
        for (const item of items) {
          const asset = data.assets.find((row) => row.id === item.assetId);
          if (!asset) throw new AppError("Choose equipment that still exists in the inventory.");
          if (item.quantity > (asset.quantity ?? 1)) throw new AppError(`${asset.name} only has ${asset.quantity ?? 1} unit${(asset.quantity ?? 1) === 1 ? "" : "s"} in inventory.`);
        }
        const timestamp = now();
        const template: EquipmentTemplate = { id: id(), name: values.name, items, createdBy: user.id, createdAt: timestamp, updatedAt: timestamp };
        data.equipmentTemplates.unshift(template);
        audit(data, user.id, "Created equipment template", "equipment_template", template.id);
        return { ok: true, id: template.id };
      }
      case "update_equipment_template": {
        requireCapability(user.accessRoles ?? user.role, "manage_equipment");
        const values = record(equipmentTemplateUpdateSchema, p);
        data.equipmentTemplates ??= [];
        if (data.equipmentTemplates.some((item) => item.id !== values.templateId && item.name.toLocaleLowerCase() === values.name.toLocaleLowerCase())) throw new AppError("An equipment template with that name already exists.", 409);
        const template = data.equipmentTemplates.find((item) => item.id === values.templateId);
        if (!template) throw new AppError("Equipment template not found.", 404);
        const items = normalizeEquipmentTemplateItems(values.items);
        for (const item of items) {
          const asset = data.assets.find((row) => row.id === item.assetId);
          if (!asset) throw new AppError("Choose equipment that still exists in the inventory.");
          if (item.quantity > (asset.quantity ?? 1)) throw new AppError(`${asset.name} only has ${asset.quantity ?? 1} unit${(asset.quantity ?? 1) === 1 ? "" : "s"} in inventory.`);
        }
        template.name = values.name;
        template.items = items;
        template.updatedAt = now();
        audit(data, user.id, "Updated equipment template", "equipment_template", template.id);
        return { ok: true };
      }
      case "duplicate_equipment_template": {
        requireCapability(user.accessRoles ?? user.role, "manage_equipment");
        const { templateId } = record(checklistTemplateIdSchema, p);
        data.equipmentTemplates ??= [];
        const source = data.equipmentTemplates.find((item) => item.id === templateId);
        if (!source) throw new AppError("Equipment template not found.", 404);
        const timestamp = now();
        const duplicate: EquipmentTemplate = { ...source, id: id(), name: `Copy of ${source.name}`, items: source.items.map((item) => ({ ...item, id: id() })), createdBy: user.id, createdAt: timestamp, updatedAt: timestamp };
        data.equipmentTemplates.unshift(duplicate);
        audit(data, user.id, "Duplicated equipment template", "equipment_template", duplicate.id);
        return { ok: true, id: duplicate.id };
      }
      case "delete_equipment_template": {
        requireCapability(user.accessRoles ?? user.role, "manage_equipment");
        const { templateId } = record(checklistTemplateIdSchema, p);
        data.equipmentTemplates ??= [];
        const index = data.equipmentTemplates.findIndex((item) => item.id === templateId);
        if (index < 0) throw new AppError("Equipment template not found.", 404);
        const [template] = data.equipmentTemplates.splice(index, 1);
        audit(data, user.id, "Deleted equipment template", "equipment_template", template.id);
        return { ok: true };
      }
      case "quick_assign_equipment": {
        requireCapability(user.accessRoles ?? user.role, "manage_equipment");
        const values = record(quickAssignEquipmentSchema, p);
        validateTimezone(values.timeZone);
        if (values.dueDate && values.dueDate < currentDateInTimezone(values.timeZone)) throw new AppError("Due date must be today or later.");
        data.equipmentTemplates ??= [];
        const template = data.equipmentTemplates.find((item) => item.id === values.templateId);
        const borrower = data.profiles.find((row) => row.id === values.borrowerId && row.active !== false);
        if (!template || !borrower) throw new AppError("Choose a saved template and an active team member.");
        const checkoutItems = normalizeEquipmentTemplateItems(values.items).map((item) => {
          const asset = data.assets.find((row) => row.id === item.assetId);
          if (!asset) throw new AppError("An item in this equipment template is no longer in the inventory.");
          if (!canIssueEquipment(asset, data.loans)) throw new AppError(`${asset.name} is not available to hand out. Check its condition or current loans.`, 409);
          const activeLoans = data.loans.filter((row) => row.assetId === asset.id && !row.returnAt);
          const borrowedQuantity = activeLoans.reduce((sum, row) => sum + (row.quantity ?? 1), 0);
          const availableQuantity = (asset.quantity ?? 1) - borrowedQuantity;
          if (item.quantity > availableQuantity) throw new AppError(`Only ${availableQuantity} unit${availableQuantity === 1 ? " is" : "s are"} of ${asset.name} available to hand out.`, 409);
          return { ...item, asset, activeLoans, availableQuantity };
        });
        const issuedAt = dateTime(values.handoffDate, currentTimeInTimezone(values.timeZone), values.timeZone);
        const createdLoans = checkoutItems.map(({ asset, activeLoans, availableQuantity, quantity }) => {
          const loan: EquipmentLoan = { id: id(), assetId: asset.id, borrowerId: borrower.id, issuedBy: user.id, issuedAt, dueDate: values.dueDate, quantity, checkoutCondition: asset.condition, checkoutNotes: values.checkoutNotes || undefined };
          data.loans.unshift(loan);
          const remainingQuantity = availableQuantity - quantity;
          asset.status = remainingQuantity === 0 ? "Checked out" : "Available";
          const activeBorrowers = new Set([borrower.id, ...activeLoans.map((row) => row.borrowerId)]);
          asset.currentCustodianId = activeBorrowers.size === 1 ? borrower.id : undefined;
          return loan;
        });
        const summary = checkoutItems.map(({ asset, quantity }) => `${quantity} × ${asset.name}`).join(", ");
        notify(data, borrower.id, "Equipment handed to you", `${template.name} · ${summary} · recorded by the checkout crew`, "equipment");
        notifyEquipmentCrew(data, user.id, `${template.name} was handed to ${borrower.fullName} · ${summary}.`, borrower.id);
        audit(data, user.id, `Assigned equipment template ${template.name} to ${borrower.fullName}`, "equipment_template_assignment", template.id);
        return { ok: true, count: createdLoans.length };
      }
      case "create_asset": {
        requireCapability(user.accessRoles ?? user.role, "manage_equipment");
        const values = record(assetSchema, p);
        if (data.assets.some((item) => item.assetCode.toLowerCase() === values.assetCode.toLowerCase())) throw new AppError("That asset ID is already in use.", 409);
        const asset = { id: id(), ...values, status: values.condition === "Good" ? "Available" as const : "Under maintenance" as const };
        const sheetSynced = await syncEquipmentSheetRow(values);
        data.assets.unshift(asset);
        notifyEquipmentCrew(data, user.id, `${asset.name} added to the equipment list.`);
        audit(data, user.id, "Added equipment asset", "asset", asset.id);
        return { ok: true, id: asset.id, sheetSynced };
      }
      case "update_asset": {
        if (!can(user.accessRoles ?? user.role, "manage_equipment")) throw new AppError("Only equipment managers, directors, or administrators can edit equipment records.", 403);
        const values = record(assetUpdateSchema, p);
        const asset = data.assets.find((row) => row.id === values.assetId);
        if (!asset) throw new AppError("Equipment record not found.", 404);
        if (data.assets.some((row) => row.id !== asset.id && row.assetCode.toLowerCase() === values.assetCode.toLowerCase())) throw new AppError("That asset ID is already in use.", 409);
        const activeAssetLoans = data.loans.filter((loan) => loan.assetId === asset.id && !loan.returnAt);
        const activeLoanQuantity = activeAssetLoans.reduce((sum, loan) => sum + (loan.quantity ?? 1), 0);
        if (values.quantity < activeLoanQuantity) throw new AppError(`Quantity cannot be lower than the ${activeLoanQuantity} unit${activeLoanQuantity === 1 ? "" : "s"} currently borrowed.`, 409);
        Object.assign(asset, { assetCode: values.assetCode, name: values.name, category: values.category, location: values.location, model: values.model, serial: values.serial, quantity: values.quantity, condition: values.condition, notes: values.notes });
        if (!["Missing", "Retired"].includes(asset.status)) asset.status = values.condition !== "Good" ? "Under maintenance" : activeLoanQuantity >= values.quantity ? "Checked out" : "Available";
        asset.currentCustodianId = new Set(activeAssetLoans.map((loan) => loan.borrowerId)).size === 1 ? activeAssetLoans[0]?.borrowerId : undefined;
        const activeLoan = data.loans.find((loan) => loan.assetId === asset.id && !loan.returnAt);
        if (activeLoan) notify(data, activeLoan.borrowerId, "Borrowed equipment updated", `${asset.name} · ${asset.condition} · ${asset.location || "Location not listed"}`, "equipment");
        notifyEquipmentCrew(data, user.id, `${asset.name} details changed · ${asset.condition}`);
        audit(data, user.id, "Edited equipment record", "asset", asset.id);
        return { ok: true };
      }
      case "delete_asset": {
        requireCapability(user.accessRoles ?? user.role, "manage_equipment");
        const { assetId } = record(deleteAssetSchema, p);
        if (data.equipmentTemplates.some((template) => template.items.some((item) => item.assetId === assetId))) throw new AppError("Remove this equipment from its saved templates before deleting it.", 409);
        const index = data.assets.findIndex((item) => item.id === assetId);
        if (index < 0) throw new AppError("Equipment record not found.", 404);
        if (data.loans.some((loan) => loan.assetId === assetId)) {
          throw new AppError("This equipment has borrowing history and cannot be deleted. Its loan records are preserved.", 409);
        }
        const [asset] = data.assets.splice(index, 1);
        for (const incident of data.incidents) if (incident.assetId === assetId) incident.assetId = undefined;
        audit(data, user.id, "Deleted equipment asset", "asset", asset.id);
        return { ok: true };
      }
      case "delete_equipment_history": {
        if (!hasAccessRole(user.accessRoles, user.role, "Administrator")) throw new AppError("Only an administrator can delete equipment history.", 403);
        const values = record(equipmentHistoryDeleteSchema, p);
        if (!data.assets.some((asset) => asset.id === values.assetId)) throw new AppError("Equipment record not found.", 404);
        if (values.loanId) {
          const index = data.loans.findIndex((loan) => loan.id === values.loanId && loan.assetId === values.assetId);
          if (index < 0) throw new AppError("Equipment history record not found.", 404);
          if (!data.loans[index].returnAt) throw new AppError("Return this equipment before deleting its handoff history.", 409);
          data.loans.splice(index, 1);
          audit(data, user.id, "Deleted equipment handoff history", "asset", values.assetId);
          return { ok: true, count: 1 };
        }
        if (data.loans.some((loan) => loan.assetId === values.assetId && !loan.returnAt)) {
          throw new AppError("Return all borrowed equipment before deleting its full history.", 409);
        }
        const priorCount = data.loans.filter((loan) => loan.assetId === values.assetId).length;
        data.loans = data.loans.filter((loan) => loan.assetId !== values.assetId);
        audit(data, user.id, "Deleted all equipment handoff history", "asset", values.assetId);
        return { ok: true, count: priorCount };
      }
      case "issue_equipment": {
        requireCapability(user.accessRoles ?? user.role, "manage_equipment");
        const values = record(issueEquipmentSchema, p);
        validateTimezone(values.timeZone);
        const asset = data.assets.find((row) => row.id === values.assetId);
        const borrower = data.profiles.find((row) => row.id === values.borrowerId);
        if (!asset) throw new AppError("Choose valid equipment.");
        if (!borrower || borrower.active === false) throw new AppError("Choose an active media team member to borrow this item.");
        if (!canIssueEquipment(asset, data.loans)) throw new AppError("This item is not available to hand out. Check its condition or current loan.", 409);
        const activeAssetLoans = data.loans.filter((item) => item.assetId === asset.id && !item.returnAt);
        const borrowedQuantity = activeAssetLoans.reduce((sum, item) => sum + (item.quantity ?? 1), 0);
        const availableQuantity = (asset.quantity ?? 1) - borrowedQuantity;
        if (values.quantity > availableQuantity) throw new AppError(`Only ${availableQuantity} unit${availableQuantity === 1 ? " is" : "s are"} available to hand out.`, 409);
        const loan: EquipmentLoan = { id: id(), assetId: asset.id, borrowerId: borrower.id, issuedBy: user.id, issuedAt: dateTime(values.handoffDate, currentTimeInTimezone(values.timeZone), values.timeZone), dueDate: values.dueDate, quantity: values.quantity, checkoutCondition: asset.condition, checkoutNotes: values.checkoutNotes || undefined };
        data.loans.unshift(loan);
        const remainingQuantity = availableQuantity - values.quantity;
        asset.status = remainingQuantity === 0 ? "Checked out" : "Available";
        const activeBorrowers = new Set([borrower.id, ...activeAssetLoans.map((item) => item.borrowerId)]);
        asset.currentCustodianId = activeBorrowers.size === 1 ? borrower.id : undefined;
        notify(data, borrower.id, "Equipment handed to you", `${values.quantity} × ${asset.name} · recorded by the checkout crew`, "equipment");
        notifyEquipmentCrew(data, user.id, `${values.quantity} × ${asset.name} was handed to ${borrower.fullName}.`);
        audit(data, user.id, `Handed equipment to ${borrower.fullName}`, "equipment_loan", loan.id);
        return { ok: true, id: loan.id };
      }
      case "return_equipment": {
        requireCapability(user.accessRoles ?? user.role, "manage_equipment");
        const values = record(returnEquipmentSchema, { ...p, loanId: p.loanId ?? p.id });
        const loan = data.loans.find((item) => item.id === values.loanId);
        if (!loan || loan.returnAt) throw new AppError("This item is not currently borrowed or was already returned.", 409);
        const asset = data.assets.find((item) => item.id === loan.assetId);
        if (!asset) throw new AppError("The equipment record for this loan no longer exists.", 409);
        loan.returnAt = now();
        loan.returnedBy = user.id;
        loan.returnCondition = values.condition;
        loan.returnNotes = values.notes || undefined;
        asset.condition = values.condition;
        const remainingLoans = data.loans.filter((item) => item.assetId === asset.id && !item.returnAt);
        const remainingBorrowedQuantity = remainingLoans.reduce((sum, item) => sum + (item.quantity ?? 1), 0);
        asset.status = values.condition !== "Good" ? "Under maintenance" : remainingBorrowedQuantity >= (asset.quantity ?? 1) ? "Checked out" : "Available";
        asset.currentCustodianId = new Set(remainingLoans.map((item) => item.borrowerId)).size === 1 ? remainingLoans[0]?.borrowerId : undefined;
        const borrower = data.profiles.find((profile) => profile.id === loan.borrowerId);
        if (borrower && borrower.id !== user.id) notify(data, borrower.id, "Equipment return recorded", `${asset.name} · ${values.condition}`, "equipment");
        notifyEquipmentCrew(data, user.id, `${asset.name} was returned · ${values.condition}.`);
        audit(data, user.id, "Returned equipment", "equipment_loan", loan.id);
        return { ok: true };
      }
      case "report_incident": {
        requireCapability(user.accessRoles ?? user.role, "report_incidents");
        const values = record(incidentSchema, p);
        if (values.eventId && !data.events.some((row) => row.id === values.eventId)) throw new AppError("Choose a valid event.");
        if (values.assetId && !data.assets.some((row) => row.id === values.assetId)) throw new AppError("Choose a valid equipment record.");
        if (!hasManagerAccess(user.accessRoles, user.role) && !hasAccessRole(user.accessRoles, user.role, "Equipment Manager")) {
          const assignedEvents = new Set(data.checklistItems.filter((row) => row.userId === user.id).map((row) => row.eventId));
          if (values.eventId && !assignedEvents.has(values.eventId)) throw new AppError("You can report issues only for events on your checklist.", 403);
          if (values.assetId && !data.loans.some((loan) => loan.assetId === values.assetId && loan.borrowerId === user.id && !loan.returnAt)) throw new AppError("You can report equipment faults only for items currently borrowed by you.", 403);
        }
        const incident: Incident = { id: id(), ...values, immediateAction: values.immediateAction || undefined, photos: values.photos, reportedBy: user.id, status: "Open", createdAt: now() };
        data.incidents.unshift(incident);
        if (incident.assetId && (["High", "Critical"].includes(incident.severity) || incident.category.toLocaleLowerCase().includes("damage"))) {
          const asset = data.assets.find((row) => row.id === incident.assetId);
          if (asset) {
            asset.status = "Under maintenance";
            if (incident.category.toLocaleLowerCase().includes("damage")) asset.condition = "Damaged";
            for (const manager of data.profiles.filter((profile) => profile.id !== user.id && hasAccessRole(profile.accessRoles, profile.role, "Equipment Manager"))) notify(data, manager.id, "Equipment needs service", `${asset.name} was marked under maintenance.`, "equipment");
          }
        }
        const reporterName = data.profiles.find((profile) => profile.id === user.id)?.fullName ?? "Team member";
        for (const profile of data.profiles.filter((row) => row.id !== user.id && hasManagerAccess(row.accessRoles, row.role))) notify(data, profile.id, "New incident reported", `${incident.severity} · ${incident.category} · ${reporterName}`, "incidents");
        audit(data, user.id, "Reported incident", "incident", incident.id);
        return { ok: true, id: incident.id };
      }
      case "resolve_incident": {
        if (!hasManagerAccess(user.accessRoles, user.role)) throw new AppError("Only the administrator or director can change an incident after it is reported.", 403);
        const incident = data.incidents.find((row) => row.id === p.incidentId);
        const resolution = String(p.resolution ?? "").trim();
        if (!incident) throw new AppError("Incident not found.", 404);
        if (resolution.length < 1) throw new AppError("Add a resolution note before closing the incident.");
        incident.status = "Resolved";
        incident.resolution = resolution;
        audit(data, user.id, "Resolved incident", "incident", incident.id);
        return { ok: true };
      }
      case "complete_own_incident": {
        const values = record(incidentCompletionSchema, p);
        const incident = data.incidents.find((row) => row.id === values.incidentId && row.reportedBy === user.id);
        const resolution = values.resolution;
        if (!incident) throw new AppError("You can only complete an incident you reported.", 403);
        incident.status = "Resolved";
        incident.resolution = resolution;
        incident.photos = values.photos;
        audit(data, user.id, "Completed own incident job", "incident", incident.id);
        return { ok: true };
      }
      case "update_incident": {
        if (!hasManagerAccess(user.accessRoles, user.role)) throw new AppError("Only the administrator or director can edit incident records.", 403);
        const values = record(incidentEditSchema, p);
        const incident = data.incidents.find((row) => row.id === values.incidentId);
        if (!incident) throw new AppError("Incident not found.", 404);
        if (values.eventId && !data.events.some((row) => row.id === values.eventId)) throw new AppError("Choose a valid event.");
        if (values.assetId && !data.assets.some((row) => row.id === values.assetId)) throw new AppError("Choose valid equipment.");
        const resolution = values.resolution || incident.resolution || "";
        if (["Resolved", "Closed"].includes(values.status) && resolution.trim().length < 1) throw new AppError("Add a resolution note before keeping this incident resolved or closed.");
        Object.assign(incident, { eventId: values.eventId, assetId: values.assetId, category: values.category, severity: values.severity, description: values.description, immediateAction: values.immediateAction || undefined, photos: values.photos, status: values.status, resolution: resolution || undefined });
        audit(data, user.id, "Edited incident record", "incident", incident.id);
        return { ok: true };
      }
      case "delete_incident": {
        if (!hasAccessRole(user.accessRoles, user.role, "Administrator")) throw new AppError("Only an administrator can delete incidents.", 403);
        const { incidentId } = record(incidentDeleteSchema, p);
        const index = data.incidents.findIndex((row) => row.id === incidentId);
        if (index < 0) throw new AppError("Incident not found.", 404);
        const [incident] = data.incidents.splice(index, 1);
        audit(data, user.id, "Deleted incident", "incident", incident.id);
        return { ok: true };
      }
      case "create_sop": {
        requireCapability(user.accessRoles ?? user.role, "manage_sops");
        const title = String(p.title ?? "").trim();
        const category = String(p.category ?? "").trim();
        const summary = String(p.summary ?? "").trim();
        if (title.length < 3 || !category || summary.length < 10) throw new AppError("Add a title, category, and meaningful SOP purpose.");
        const assignedUserIds = Array.isArray(p.assignedUserIds) ? p.assignedUserIds.filter((value): value is string => typeof value === "string") : [];
        const sop = { id: id(), title: title.slice(0, 120), category, status: "Draft" as const, version: 1, summary, steps: ["Review this procedure with an authorized technical lead.", "Document verified steps for this role.", "Add a final check and escalation contact."], reviewRequired: true, updatedAt: now(), assignedUserIds, availableToAll: p.availableToAll === true || p.availableToAll === "on" };
        data.sops.unshift(sop);
        audit(data, user.id, "Created SOP draft", "sop", sop.id);
        return { ok: true, id: sop.id };
      }
      case "update_sop_audience": {
        requireCapability(user.accessRoles ?? user.role, "manage_sops");
        const values = record(sopAudienceSchema, p);
        const sop = data.sops.find((item) => item.id === values.sopId);
        if (!sop) throw new AppError("SOP not found.", 404);
        if (values.assignedUserIds.some((memberId) => !data.profiles.some((profile) => profile.id === memberId && profile.active !== false))) throw new AppError("Choose active team members only.");
        sop.assignedUserIds = values.assignedUserIds;
        sop.availableToAll = values.availableToAll;
        sop.updatedAt = now();
        audit(data, user.id, "Updated SOP visibility", "sop", sop.id);
        return { ok: true };
      }
      case "publish_sop": {
        requireCapability(user.accessRoles ?? user.role, "manage_sops");
        const sop = data.sops.find((row) => row.id === p.sopId);
        if (!sop) throw new AppError("SOP not found.", 404);
        if (p.reviewConfirmed !== true) throw new AppError("An authorized technical review is required before publishing.", 403);
        sop.status = "Published";
        sop.reviewRequired = false;
        sop.updatedAt = now();
        audit(data, user.id, "Published reviewed SOP", "sop", sop.id);
        return { ok: true };
      }
      case "update_content": {
        if (!includesCapability(user.accessRoles ?? user.role, "manage_content") && !includesCapability(user.accessRoles ?? user.role, "update_content")) throw new AppError("You do not have permission to update content.", 403);
        const project = data.content.find((row) => row.id === p.contentId);
        const stages = ["Recording pending verification", "Files transferred", "Backup verified", "Editing", "Awaiting review", "Revisions requested", "Approved", "Scheduled", "Published", "Archived"];
        const stage = String(p.stage ?? "");
        if (!project || !stages.includes(stage)) throw new AppError("Choose a valid content workflow stage.");
        if (!includesCapability(user.accessRoles ?? user.role, "manage_content") && project.assignedEditor !== user.id && project.reviewer !== user.id) throw new AppError("You can only update content assigned to you.", 403);
        const allowedNext: Record<string, string[]> = {
          "Recording pending verification": ["Files transferred"], "Files transferred": ["Backup verified"], "Backup verified": ["Editing"],
          Editing: ["Awaiting review"], "Awaiting review": ["Revisions requested", "Approved"], "Revisions requested": ["Editing"],
          Approved: ["Scheduled"], Scheduled: ["Published"], Published: ["Archived"], Archived: [],
        };
        if (!allowedNext[project.stage]?.includes(stage)) throw new AppError(`The workflow cannot move from ${project.stage} to ${stage}.`, 409);
        if (["Revisions requested", "Approved"].includes(stage) && !includesCapability(user.accessRoles ?? user.role, "manage_content") && project.reviewer !== user.id) throw new AppError("Only the assigned reviewer or an authorized director can review this content.", 403);
        if (["Scheduled", "Published", "Archived"].includes(stage) && !includesCapability(user.accessRoles ?? user.role, "manage_content")) throw new AppError("Only an authorized director can schedule or publish content.", 403);
        if (stage === "Backup verified" && (String(p.backupLocation ?? "").trim().length < 3 || String(p.verificationNote ?? "").trim().length < 8)) throw new AppError("Add the backup location and verify that the intended files open before confirming the backup.");
        project.stage = stage;
        if (p.link) project.link = String(p.link).slice(0, 500);
        audit(data, user.id, `Moved content to ${stage}`, "content", project.id);
        return { ok: true };
      }
      case "mark_notification_read": {
        const notification = data.notifications.find((row) => row.id === p.notificationId && row.userId === user.id);
        if (!notification) throw new AppError("Notification not found.", 404);
        notification.read = true;
        notification.readAt = now();
        return { ok: true };
      }
      default: throw new AppError("That action is not available.", 400);
    }
  });
}

async function runSupabase(action: string, payload: Record<string, unknown>, user: { id: string; role: AppRole; accessRoles?: AppRole[] }) {
  const supabase = await createSupabaseServerClient();
  const p = payload;
  const fail = (error: { message: string } | null) => { if (error) throw new AppError(error.message, error.message.toLowerCase().includes("conflict") ? 409 : 400); };
  switch (action) {
    case "create_time_alarm": {
      const values = record(timeAlarmSchema, p);
      const canManage = hasManagerAccess(user.accessRoles, user.role);
      const targetUserId = canManage ? values.userId || user.id : user.id;
      if (values.userId && values.userId !== user.id && !canManage) throw new AppError("Only the administrator or director can set an alarm for another member.", 403);
      const fireAt = alarmFireAt(values);
      if (Date.parse(fireAt) <= Date.now()) throw new AppError("Choose a future time for this alarm.");
      const { data: profile, error: profileError } = await supabase.from("profiles").select("id,active").eq("id", targetUserId).maybeSingle();
      fail(profileError);
      if (!profile?.active) throw new AppError("Choose an active team member.");
      const { data: alarm, error } = await supabase.from("time_alarms").insert({ user_id: targetUserId, created_by: user.id, fire_at: fireAt, description: values.description }).select("id").single();
      fail(error); return { ok: true, alarmId: alarm?.id };
    }
    case "cancel_time_alarm": {
      const values = record(timeAlarmIdSchema, p);
      const { data, error } = await supabase.rpc("cancel_time_alarm", { p_alarm_id: values.alarmId });
      fail(error);
      if (!data) throw new AppError("Alarm not found or you do not have permission to cancel it.", 403);
      return { ok: true };
    }
    case "complete_time_alarm": {
      const values = record(timeAlarmIdSchema, p);
      const { data, error } = await supabase.rpc("complete_time_alarm", { p_alarm_id: values.alarmId });
      fail(error);
      if (!data) throw new AppError("This alarm is not due, or you are not the assigned person.", 403);
      return { ok: true };
    }
    case "process_due_alarms": {
      const { data, error } = await supabase.rpc("process_due_time_alarms");
      fail(error); return { ok: true, triggered: Number(data ?? 0) };
    }
    case "add_category":
    case "delete_category": {
      const values = record(categorySchema, p);
      if (!mayManageCategories(user.accessRoles ?? user.role)) throw new AppError("Only the administrator, director, or equipment manager can manage categories.", 403);
      if (values.categoryType === "checklists") throw new AppError("The five checklist phases cannot be added or removed. You can change their order.");
      if (action === "add_category") {
        const { data: last, error: orderError } = await supabase.from("operation_categories").select("sort_order").eq("category_type", values.categoryType).order("sort_order", { ascending: false }).limit(1).maybeSingle();
        fail(orderError);
        const { error } = await supabase.from("operation_categories").insert({ category_type: values.categoryType, category_name: values.category, created_by: user.id, sort_order: (last?.sort_order ?? -1) + 1 });
        fail(error);
      } else {
        const { data: existing, error: listError } = await supabase.from("operation_categories").select("category_name").eq("category_type", values.categoryType);
        fail(listError);
        if ((existing ?? []).length <= 1) throw new AppError("Keep at least one category in each list.");
        const { error } = await supabase.from("operation_categories").delete().eq("category_type", values.categoryType).eq("category_name", values.category);
        fail(error);
      }
      return { ok: true };
    }
    case "reorder_categories": {
      const values = record(categoryOrderSchema, p);
      if (!mayManageCategories(user.accessRoles ?? user.role)) throw new AppError("Only the administrator, director, or equipment manager can manage categories.", 403);
      if (values.categoryType === "checklists" && (values.categories.length !== CHECKLIST_PROGRAM_PHASES.length || CHECKLIST_PROGRAM_PHASES.some((phase) => !values.categories.includes(phase)))) throw new AppError("Keep all five program phases when changing their order.", 409);
      const { error } = await supabase.rpc("reorder_operation_categories", { p_category_type: values.categoryType, p_categories: values.categories });
      fail(error); return { ok: true };
    }
    case "set_event_response": {
      const assignmentId = String(p.assignmentId ?? "");
      if (!["Accepted", "Declined"].includes(String(p.response))) throw new AppError("Choose whether you can attend.");
      const { data, error } = await supabase.rpc("respond_to_event_assignment", { p_assignment_id: assignmentId, p_response: p.response });
      fail(error);
      if (!data) throw new AppError("Only your published event assignments can be updated.", 403);
      return { ok: true };
    }
    case "set_event_program_phase": {
      requireCapability(user.accessRoles ?? user.role, "manage_events");
      const values = record(eventProgramPhaseSchema, p);
      const { error } = await supabase.rpc("set_event_program_phase", { p_event_id: values.eventId, p_phase: values.programPhase });
      fail(error); return { ok: true };
    }
    case "create_event": {
      requireCapability(user.accessRoles ?? user.role, "manage_events");
      const values = record(eventSchema, p);
      validateTimezone(values.timeZone);
      if (!values.startTime || !values.endTime || !values.setupTime || values.venue === "To be confirmed") throw new AppError("Connected mode requires the event schedule and venue before saving.", 503);
      const { data, error } = await supabase.rpc("create_event_with_notes", { p_title: values.title, p_category: values.category, p_event_date: values.date, p_start_time: values.startTime, p_end_time: values.endTime, p_setup_time: values.setupTime, p_time_zone: values.timeZone, p_venue: values.venue, p_event_lead_id: values.leadId || null, p_description: values.description, p_livestream_required: values.livestream, p_recording_required: values.recording, p_photography_required: values.photography, p_public_information: values.publicInfo, p_private_notes: values.privateNotes });
      fail(error);
      const assignedUserIds = Array.isArray(p.assignedUserIds) ? [...new Set(p.assignedUserIds.filter((value): value is string => typeof value === "string"))] : null;
      const { error: crewError } = await supabase.rpc("sync_event_crew", { p_event_id: data, p_user_ids: assignedUserIds });
      fail(crewError); return { ok: true, id: data };
    }
    case "publish_event": {
      requireCapability(user.accessRoles ?? user.role, "manage_events");
      const { error } = await supabase.rpc("publish_event_schedule", { p_event_id: String(p.eventId) }); fail(error); return { ok: true };
    }
    case "update_event": {
      requireCapability(user.accessRoles ?? user.role, "manage_events");
      const values = record(eventSchema, p);
      validateTimezone(values.timeZone);
      if (!values.startTime || !values.endTime || !values.setupTime || values.venue === "To be confirmed") throw new AppError("Connected mode requires the event schedule and venue before saving.", 503);
      const { error } = await supabase.rpc("update_event_with_notes", { p_event_id: String(p.eventId), p_title: values.title, p_category: values.category, p_event_date: values.date, p_start_time: values.startTime, p_end_time: values.endTime, p_setup_time: values.setupTime, p_time_zone: values.timeZone, p_venue: values.venue, p_event_lead_id: values.leadId || null, p_description: values.description, p_livestream_required: values.livestream, p_recording_required: values.recording, p_photography_required: values.photography, p_public_information: values.publicInfo, p_private_notes: values.privateNotes });
      fail(error);
      const assignedUserIds = Array.isArray(p.assignedUserIds) ? [...new Set(p.assignedUserIds.filter((value): value is string => typeof value === "string"))] : null;
      const { error: crewError } = await supabase.rpc("sync_event_crew", { p_event_id: String(p.eventId), p_user_ids: assignedUserIds });
      fail(crewError); return { ok: true };
    }
    case "delete_event": {
      if (!hasManagerAccess(user.accessRoles, user.role)) throw new AppError("Only the administrator or director can delete events.", 403);
      throw new AppError("Deleting events from connected mode needs the approved database permission update. Local account mode is ready for this.", 503);
    }
    case "complete_checklist_item": {
      if (!includesCapability(user.accessRoles ?? user.role, "complete_checklists")) throw new AppError("You do not have permission to update checklists.", 403);
      const itemId = String(p.itemId);
      const { data: checklistItem, error: checklistError } = await supabase.from("checklist_items").select("assigned_user_id").eq("id", itemId).maybeSingle();
      fail(checklistError);
      if (!checklistItem || (checklistItem.assigned_user_id !== user.id && !hasManagerAccess(user.accessRoles, user.role))) throw new AppError("You can only update your assigned checklist.", 403);
      const { error } = await supabase.rpc("complete_checklist_item", { p_item_id: itemId, p_status: String(p.status), p_notes: String(p.note ?? "") }); fail(error); return { ok: true };
    }
    case "create_checklist_item": {
      if (!hasManagerAccess(user.accessRoles, user.role)) throw new AppError("Only the administrator or director can add checklist items.", 403);
      throw new AppError("Directly assigning a checklist to a team member needs the connected database update. Local account mode is ready for this.", 503);
    }
    case "create_checklist_template": {
      requireCapability(user.accessRoles ?? user.role, "manage_checklists");
      const values = record(checklistTemplateSchema, p);
      const { data: existingTemplates, error: templatesError } = await supabase.from("checklist_templates").select("id,title,category");
      fail(templatesError);
      if (hasChecklistTemplateNameConflict((existingTemplates ?? []).map((item) => ({ id: item.id, name: item.title, category: item.category })), values.name, values.category)) throw new AppError("A checklist template with that name already exists in this stage.", 409);
      const { data, error } = await supabase.rpc("admin_create_checklist_template", { p_name: values.name, p_tasks: values.tasks });
      fail(error);
      const { error: categoryError } = await supabase.from("checklist_templates").update({ category: values.category }).eq("id", data);
      fail(categoryError); return { ok: true, id: data };
    }
    case "update_checklist_template": {
      requireCapability(user.accessRoles ?? user.role, "manage_checklists");
      const values = record(checklistTemplateUpdateSchema, p);
      const { data: existingTemplates, error: templatesError } = await supabase.from("checklist_templates").select("id,title,category");
      fail(templatesError);
      if (hasChecklistTemplateNameConflict((existingTemplates ?? []).map((item) => ({ id: item.id, name: item.title, category: item.category })), values.name, values.category, values.templateId)) throw new AppError("A checklist template with that name already exists in this stage.", 409);
      const { error } = await supabase.rpc("admin_update_checklist_template", { p_template_id: values.templateId, p_name: values.name, p_tasks: values.tasks });
      fail(error);
      const { error: categoryError } = await supabase.from("checklist_templates").update({ category: values.category }).eq("id", values.templateId);
      fail(categoryError); return { ok: true };
    }
    case "duplicate_checklist_template": {
      requireCapability(user.accessRoles ?? user.role, "manage_checklists");
      const { templateId } = record(checklistTemplateIdSchema, p);
      const { data, error } = await supabase.rpc("admin_duplicate_checklist_template", { p_template_id: templateId });
      fail(error); return { ok: true, id: data };
    }
    case "delete_checklist_template": {
      requireCapability(user.accessRoles ?? user.role, "manage_checklists");
      const { templateId } = record(checklistTemplateIdSchema, p);
      const { error } = await supabase.rpc("admin_delete_checklist_template", { p_template_id: templateId });
      fail(error); return { ok: true };
    }
    case "quick_assign_checklist": {
      requireCapability(user.accessRoles ?? user.role, "manage_checklists");
      const values = record(quickAssignChecklistSchema, p);
      const { data, error } = await supabase.rpc("admin_quick_assign_checklist_template", { p_template_id: values.templateId, p_event_id: values.eventId, p_user_id: values.userId, p_tasks: values.tasks });
      fail(error); return { ok: true, count: data };
    }
    case "update_checklist_item": {
      if (!hasManagerAccess(user.accessRoles, user.role)) throw new AppError("Only the administrator or director can edit checklist items.", 403);
      const values = record(checklistItemUpdateSchema, p);
      const { error } = await supabase.rpc("admin_update_checklist_item", { p_item_id: values.itemId, p_label: values.label, p_is_required: values.required, p_program_phase: values.programPhase ?? null });
      fail(error); return { ok: true };
    }
    case "delete_checklist_item": {
      if (!hasManagerAccess(user.accessRoles, user.role)) throw new AppError("Only the administrator or director can remove checklist items.", 403);
      const values = record(checklistItemDeleteSchema, p);
      const { error } = await supabase.rpc("admin_delete_checklist_item", { p_item_id: values.itemId });
      fail(error); return { ok: true };
    }
    case "clear_completed_checklists": {
      if (!hasManagerAccess(user.accessRoles, user.role)) throw new AppError("Only the administrator or director can clear completed checklists.", 403);
      const { data, error } = await supabase.rpc("admin_clear_completed_checklists");
      fail(error); return { ok: true, count: data };
    }
    case "hide_service_history": {
      if (!hasManagerAccess(user.accessRoles, user.role)) throw new AppError("Only the administrator or director can manage service history.", 403);
      const { assignmentId } = record(serviceHistorySchema, p);
      const { data, error } = await supabase.from("role_assignments").update({ service_history_hidden: true }).eq("id", assignmentId).select("id").maybeSingle();
      fail(error);
      if (!data) throw new AppError("Service history entry not found.", 404);
      return { ok: true };
    }
    case "reset_member_service_history": {
      if (!hasManagerAccess(user.accessRoles, user.role)) throw new AppError("Only the administrator or director can reset service history.", 403);
      const { userId } = record(resetMemberHistorySchema, p);
      const { error } = await supabase.rpc("admin_reset_member_service_history", { p_user_id: userId });
      fail(error); return { ok: true };
    }
    case "create_asset": {
      requireCapability(user.accessRoles ?? user.role, "manage_equipment");
      const values = record(assetSchema, p);
      const sheetSynced = await syncEquipmentSheetRow(values);
      const { data, error } = await supabase.from("equipment_assets").insert({ asset_code: values.assetCode, name: values.name, category: values.category, storage_location: values.location, model: values.model, serial_number: values.serial, quantity: values.quantity, condition: values.condition, status: values.condition === "Good" ? "Available" : "Under maintenance", notes: values.notes, created_by: user.id }).select("id").single();
      fail(error); return { ok: true, id: data?.id, sheetSynced };
    }
    case "update_asset": {
      if (!can(user.accessRoles ?? user.role, "manage_equipment")) throw new AppError("Only equipment managers, directors, or administrators can edit equipment records.", 403);
      const values = record(assetUpdateSchema, p);
      const { data: current, error: currentError } = await supabase.from("equipment_assets").select("id,status,quantity").eq("id", values.assetId).maybeSingle();
      fail(currentError);
      if (!current) throw new AppError("Equipment record not found.", 404);
      const status = ["Missing", "Retired"].includes(current.status) ? current.status : values.condition === "Good" ? "Available" : "Under maintenance";
      const { error } = await supabase.from("equipment_assets").update({ asset_code: values.assetCode, name: values.name, category: values.category, storage_location: values.location, model: values.model, serial_number: values.serial, quantity: values.quantity, condition: values.condition, status: status as AppData["assets"][number]["status"], notes: values.notes }).eq("id", values.assetId);
      fail(error); return { ok: true };
    }
    case "delete_asset": {
      requireCapability(user.accessRoles ?? user.role, "manage_equipment");
      const { assetId } = record(deleteAssetSchema, p);
      const { error } = await supabase.rpc("delete_equipment_asset", { p_asset_id: assetId });
      fail(error); return { ok: true };
    }
    case "delete_equipment_history": {
      if (!hasAccessRole(user.accessRoles, user.role, "Administrator")) throw new AppError("Only an administrator can delete equipment history.", 403);
      const values = record(equipmentHistoryDeleteSchema, p);
      const { data, error } = await supabase.rpc("admin_delete_equipment_history", { p_asset_id: values.assetId, p_loan_id: values.loanId ?? null });
      fail(error); return { ok: true, count: data };
    }
    case "create_equipment_template": {
      requireCapability(user.accessRoles ?? user.role, "manage_equipment");
      const values = record(equipmentTemplateSchema, p);
      const { data, error } = await supabase.rpc("save_equipment_template", { p_template_id: null, p_name: values.name, p_items: normalizeEquipmentTemplateItems(values.items) });
      fail(error); return { ok: true, id: data };
    }
    case "update_equipment_template": {
      requireCapability(user.accessRoles ?? user.role, "manage_equipment");
      const values = record(equipmentTemplateUpdateSchema, p);
      const { error } = await supabase.rpc("save_equipment_template", { p_template_id: values.templateId, p_name: values.name, p_items: normalizeEquipmentTemplateItems(values.items) });
      fail(error); return { ok: true };
    }
    case "duplicate_equipment_template": {
      requireCapability(user.accessRoles ?? user.role, "manage_equipment");
      const { templateId } = record(checklistTemplateIdSchema, p);
      const { data: source, error: sourceError } = await supabase.from("equipment_templates").select("name,items").eq("id", templateId).maybeSingle();
      fail(sourceError);
      if (!source) throw new AppError("Equipment template not found.", 404);
      const { data, error } = await supabase.rpc("save_equipment_template", { p_template_id: null, p_name: `Copy of ${source.name}`, p_items: source.items });
      fail(error); return { ok: true, id: data };
    }
    case "delete_equipment_template": {
      requireCapability(user.accessRoles ?? user.role, "manage_equipment");
      const { templateId } = record(checklistTemplateIdSchema, p);
      const { error } = await supabase.rpc("delete_equipment_template", { p_template_id: templateId });
      fail(error); return { ok: true };
    }
    case "quick_assign_equipment": {
      requireCapability(user.accessRoles ?? user.role, "manage_equipment");
      const values = record(quickAssignEquipmentSchema, p);
      validateTimezone(values.timeZone);
      if (values.dueDate && values.dueDate < currentDateInTimezone(values.timeZone)) throw new AppError("Due date must be today or later.");
      const issuedAt = dateTime(values.handoffDate, currentTimeInTimezone(values.timeZone), values.timeZone);
      const { data, error } = await supabase.rpc("quick_assign_equipment_template", { p_template_id: values.templateId, p_borrower_id: values.borrowerId, p_items: normalizeEquipmentTemplateItems(values.items), p_due_date: values.dueDate ?? null, p_checkout_notes: values.checkoutNotes, p_issued_at: issuedAt });
      fail(error); return { ok: true, count: data };
    }
    case "issue_equipment": {
      requireCapability(user.accessRoles ?? user.role, "manage_equipment");
      const values = record(issueEquipmentSchema, p);
      validateTimezone(values.timeZone);
      const issuedAt = dateTime(values.handoffDate, currentTimeInTimezone(values.timeZone), values.timeZone);
      const { data, error } = await supabase.rpc("issue_equipment_to_person", { p_asset_id: values.assetId, p_borrower_id: values.borrowerId, p_due_date: values.dueDate ?? null, p_checkout_notes: values.checkoutNotes, p_issued_at: issuedAt, p_quantity: values.quantity });
      fail(error); return { ok: true, id: data };
    }
    case "return_equipment": {
      requireCapability(user.accessRoles ?? user.role, "manage_equipment");
      const values = record(returnEquipmentSchema, { ...p, loanId: p.loanId ?? p.id });
      const { error } = await supabase.rpc("return_borrowed_equipment", { p_loan_id: values.loanId, p_return_condition: values.condition, p_notes: values.notes });
      fail(error); return { ok: true };
    }
    case "report_incident": {
      if (!includesCapability(user.accessRoles ?? user.role, "report_incidents")) throw new AppError("You do not have permission to report incidents.", 403);
      const values = record(incidentSchema, p);
      const { data, error } = await supabase.from("incidents").insert({ event_id: values.eventId ?? null, asset_id: values.assetId ?? null, reported_by: user.id, category: values.category, severity: values.severity, description: values.description, immediate_action: values.immediateAction, photos: values.photos }).select("id").single();
      fail(error);
      if (values.assetId && can(user.accessRoles ?? user.role, "manage_equipment") && (["High", "Critical"].includes(values.severity) || values.category.toLocaleLowerCase().includes("damage"))) {
        const { error: assetError } = await supabase.from("equipment_assets").update({ status: "Under maintenance", condition: values.category.toLocaleLowerCase().includes("damage") ? "Damaged" : "Needs service" }).eq("id", values.assetId);
        fail(assetError);
      }
      return { ok: true, id: data?.id };
    }
    case "resolve_incident": {
      if (!hasManagerAccess(user.accessRoles, user.role)) throw new AppError("Only the administrator or director can change an incident after it is reported.", 403);
      const resolution = String(p.resolution ?? "").trim();
      if (resolution.length < 1) throw new AppError("Add a resolution note before closing the incident.");
      const { error } = await supabase.from("incidents").update({ status: "Resolved", resolution_notes: resolution, resolved_by: user.id, resolved_at: now() }).eq("id", String(p.incidentId)); fail(error); return { ok: true };
    }
    case "complete_own_incident": {
      const values = record(incidentCompletionSchema, p);
      const { data, error } = await supabase.from("incidents").update({ status: "Resolved", resolution_notes: values.resolution, photos: values.photos, resolved_by: user.id, resolved_at: now() }).eq("id", values.incidentId).eq("reported_by", user.id).select("id").maybeSingle();
      fail(error);
      if (!data) throw new AppError("You can only complete an incident you reported.", 403);
      return { ok: true };
    }
    case "update_incident": {
      if (!hasManagerAccess(user.accessRoles, user.role)) throw new AppError("Only the administrator or director can edit incident records.", 403);
      const values = record(incidentEditSchema, p);
      const resolution = values.resolution.trim();
      if (["Resolved", "Closed"].includes(values.status) && resolution.length < 1) throw new AppError("Add a resolution note before keeping this incident resolved or closed.");
      const resolved = ["Resolved", "Closed"].includes(values.status);
      const { data, error } = await supabase.from("incidents").update({ event_id: values.eventId ?? null, asset_id: values.assetId ?? null, category: values.category, severity: values.severity, description: values.description, immediate_action: values.immediateAction, photos: values.photos, status: values.status, resolution_notes: resolution || null, resolved_by: resolved ? user.id : null, resolved_at: resolved ? now() : null }).eq("id", values.incidentId).select("id").maybeSingle();
      fail(error);
      if (!data) throw new AppError("Incident not found or cannot be edited.", 404);
      return { ok: true };
    }
    case "delete_incident": {
      if (!hasAccessRole(user.accessRoles, user.role, "Administrator")) throw new AppError("Only an administrator can delete incidents.", 403);
      const { incidentId } = record(incidentDeleteSchema, p);
      const { error } = await supabase.rpc("admin_delete_incident", { p_incident_id: incidentId });
      fail(error); return { ok: true };
    }
    case "create_sop": {
      requireCapability(user.accessRoles ?? user.role, "manage_sops");
      const title = String(p.title ?? "").trim(); const category = String(p.category ?? "").trim(); const summary = String(p.summary ?? "").trim();
      if (title.length < 3 || !category || summary.length < 10) throw new AppError("Add a title, category, and meaningful SOP purpose.");
      const assignedUserIds = Array.isArray(p.assignedUserIds) ? p.assignedUserIds.filter((value): value is string => typeof value === "string") : [];
      const availableToAll = p.availableToAll === true || p.availableToAll === "on";
      const { data, error } = await supabase.rpc("create_sop_draft", { p_title: title, p_category: category, p_purpose: summary, p_steps: ["Review with an authorized technical lead."] });
      fail(error);
      const { error: assignmentError } = await supabase.from("sops").update({ assigned_user_ids: assignedUserIds, available_to_all: availableToAll }).eq("id", data);
      fail(assignmentError); return { ok: true, id: data };
    }
    case "update_sop_audience": {
      requireCapability(user.accessRoles ?? user.role, "manage_sops");
      const values = record(sopAudienceSchema, p);
      const { error } = await supabase.from("sops").update({ assigned_user_ids: values.assignedUserIds, available_to_all: values.availableToAll }).eq("id", values.sopId);
      fail(error); return { ok: true };
    }
    case "publish_sop": {
      requireCapability(user.accessRoles ?? user.role, "manage_sops");
      if (p.reviewConfirmed !== true) throw new AppError("An authorized technical review is required before publishing.", 403);
      const { error } = await supabase.rpc("publish_sop_version", { p_sop_id: String(p.sopId) }); fail(error); return { ok: true };
    }
    case "update_content": {
      if (!includesCapability(user.accessRoles ?? user.role, "manage_content") && !includesCapability(user.accessRoles ?? user.role, "update_content")) throw new AppError("You do not have permission to update content.", 403);
      if (p.stage === "Backup verified" && (String(p.backupLocation ?? "").trim().length < 3 || String(p.verificationNote ?? "").trim().length < 8)) throw new AppError("Add the backup location and verify that the intended files open before confirming the backup.");
      const { error } = await supabase.rpc("transition_content_stage", { p_content_id: String(p.contentId), p_stage: String(p.stage), p_backup_location: String(p.backupLocation ?? ""), p_verification_note: String(p.verificationNote ?? ""), p_storage_link: String(p.link ?? "") }); fail(error); return { ok: true };
    }
    case "mark_notification_read": {
      const { error } = await supabase.from("notifications").update({ read_at: now() }).eq("id", String(p.notificationId)).eq("user_id", user.id); fail(error); return { ok: true };
    }
    default: throw new AppError("That action is not available.", 400);
  }
}

export async function POST(request: NextRequest) {
  const context = await getSessionContext();
  if (!context) return NextResponse.json({ error: "Your session has expired. Sign in again." }, { status: 401 });
  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "The request could not be understood." }, { status: 400 });
  try {
    const result = context.mode === "demo"
      ? await runDemo(parsed.data.action, parsed.data.payload, context.user)
      : await runSupabase(parsed.data.action, parsed.data.payload, context.user);
    return NextResponse.json(result);
  } catch (error) {
    const status = error instanceof AppError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "The action could not be completed." }, { status });
  }
}
