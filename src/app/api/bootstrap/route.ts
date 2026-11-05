import { NextResponse } from "next/server";
import { getSessionContext } from "@/lib/auth";
import { readDemoStore } from "@/lib/store";
import { isStaff } from "@/lib/policy.mjs";
import type { AppData, AppRole, EquipmentTemplateItem } from "@/lib/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { hasAccessRole, hasManagerAccess, normalizeAccessRoles, primaryAccessRole } from "@/lib/roles";
import { normalizeChecklistProgramPhase, orderChecklistProgramPhases } from "@/lib/checklist-phases.mjs";

export const dynamic = "force-dynamic";type DbProfile = { id: string; full_name: string; username: string | null; avatar_url: string | null; role: AppRole; access_roles: AppRole[] | null; qualification_status: string; job_title: string | null; active: boolean };
type DbAttendanceCrew = Pick<DbProfile, "id" | "role" | "job_title"> & { full_name: string };
type DbAssignment = { id: string; event_id: string; user_id: string; role_name: string; arrival_time: string | null; instructions: string; response_status: "Pending" | "Accepted" | "Declined"; backup_user_id: string | null; service_history_hidden?: boolean };
type DbChecklistTemplateTask = { id: string; step_order: number; label: string; is_required: boolean };
type DbChecklistTemplateVersion = { id: string; version: number; checklist_template_items: DbChecklistTemplateTask[] };
type DbChecklistTemplate = { id: string; title: string; category: string | null; created_by: string; created_at: string; updated_at: string; checklist_template_versions: DbChecklistTemplateVersion[] };
type DbEquipmentTemplate = { id: string; name: string; items: EquipmentTemplateItem[]; created_by: string; created_at: string; updated_at: string };
type DbEvent = { id: string; title: string; category: string; event_date: string; start_time: string | null; end_time: string | null; setup_time: string | null; time_zone: string; venue: string; event_lead_id: string | null; description: string | null; livestream_required: boolean; recording_required: boolean; photography_required: boolean; status: AppData["events"][number]["status"]; public_information: string | null; current_program_phase?: string | null; started_at?: string | null; ended_at?: string | null };
type DbAsset = { id: string; asset_code: string; name: string; category: string; storage_location: string | null; quantity: number; condition: AppData["assets"][number]["condition"]; status: AppData["assets"][number]["status"]; model: string | null; serial_number: string | null; notes: string | null; current_custodian_id: string | null };
type DbLoanReturn = { returned_at: string; return_condition: string; notes: string; received_by: string };
type DbLoan = { id: string; asset_id: string; borrower_id: string; issued_by: string; issued_at: string; due_date: string | null; quantity: number; checkout_condition: string; checkout_notes: string; equipment_loan_returns: DbLoanReturn[] | DbLoanReturn | null };
type DbChecklist = { id: string; checklist_instances: { event_id: string; assignment_id: string } | null; assigned_user_id: string | null; label: string; is_required: boolean; status: AppData["checklistItems"][number]["status"]; completed_at: string | null; notes: string | null; verified_by: string | null; cleared_from_checklist?: boolean; service_history_hidden?: boolean; program_phase?: string | null };
type DbSopStep = { step_number: number; instruction: string };
type DbSopVersion = { id: string; version: number; purpose: string; reviewed_at: string | null; rich_content?: unknown; sop_steps: DbSopStep[] };
type DbEventActivity = { id: string; event_id: string; actor_id: string | null; action: string; summary: string; metadata: Record<string, unknown> | null; occurred_at: string };
type DbSop = { id: string; title: string; category: string; status: AppData["sops"][number]["status"]; current_version_id: string | null; updated_at: string; available_to_all: boolean | null; assigned_user_ids: string[] | null; sop_versions: DbSopVersion[] };
type DbIncident = { id: string; event_id: string | null; asset_id: string | null; reported_by: string; category: string; severity: AppData["incidents"][number]["severity"]; description: string; immediate_action: string | null; photos: string[] | null; status: AppData["incidents"][number]["status"]; created_at: string; resolution_notes: string | null };
type DbCategory = { category_type: keyof NonNullable<AppData["categories"]>; category_name: string; sort_order?: number };
type DbNotification = { id: string; user_id: string; sender_id?: string | null; title: string; body: string; created_at: string; read_at: string | null; href: string | null };
type DbContent = { id: string; event_id: string; title: string; content_type: string; stage: string; assigned_editor_id: string | null; due_date: string | null; assigned_reviewer_id: string | null; storage_link: string | null };
type DbAudit = { id: string; actor_id: string | null; action: string; target_type: string; target_id: string | null; created_at: string };

function filterDemoData(data: AppData, userId: string, roles: AppRole[]): AppData {
  const fallback = roles[0] ?? "Videographer";
  const administrator = hasAccessRole(roles, fallback, "Administrator");
  const director = hasAccessRole(roles, fallback, "Director");
  if (administrator || director) return { ...data, assignments: data.assignments, checklistItems: data.checklistItems, chatMessages: [] };
  const equipmentManager = hasAccessRole(roles, fallback, "Equipment Manager");
  const ownChecklists = data.checklistItems.filter((item) => item.userId === userId);
  const visibleLoans = equipmentManager ? data.loans : data.loans.filter((item) => item.borrowerId === userId);
  const visibleAssetIds = new Set(visibleLoans.map((item) => item.assetId));
  const loanProfileIds = new Set(visibleLoans.flatMap((item) => [item.borrowerId, item.issuedBy]));
  const eventCrewProfileIds = new Set(data.assignments.map((item) => item.userId));
  return {
    ...data,
    profiles: (equipmentManager || director ? data.profiles : data.profiles.filter((item) => item.id === userId || loanProfileIds.has(item.id) || eventCrewProfileIds.has(item.id))).map((item) => ({ ...item, email: "" })),
    events: data.events.map((item) => ({ ...item, privateNotes: director ? item.privateNotes : "" })),
    assignments: data.assignments,
    assets: equipmentManager ? data.assets : data.assets.filter((asset) => visibleAssetIds.has(asset.id)),
    loans: visibleLoans,
    checklistItems: ownChecklists,
    timeAlarms: data.timeAlarms.filter((alarm) => alarm.userId === userId),
    checklistTemplates: director ? data.checklistTemplates : [],
    equipmentTemplates: equipmentManager ? data.equipmentTemplates : [],
    sops: director ? data.sops : data.sops.filter((item) => item.status === "Published"),
    incidents: data.incidents.filter((item) => administrator || director || item.reportedBy === userId),
    notifications: data.notifications.filter((item) => item.userId === userId),
    chatMessages: [],
    content: director ? data.content : data.content.filter((item) => item.assignedEditor === userId || item.reviewer === userId),
    audit: [],
  };
}

function rows<T>(result: { data: T[] | null; error: { message: string } | null }, label: string): T[] {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data ?? [];
}

export async function GET() {
  const context = await getSessionContext();
  if (!context) return NextResponse.json({ error: "Sign in to view media operations." }, { status: 401 });

  if (context.mode === "demo") {
    const data = filterDemoData(await readDemoStore(), context.user.id, normalizeAccessRoles(context.user.accessRoles, context.user.role));
    data.categories ??= { equipment: ["Camera", "Audio", "Wiring", "Video", "Lighting", "Other"], sops: ["Production", "Audio", "Video", "Livestream & recording", "Equipment", "Operations", "Safety"], incidents: ["Equipment damage", "Audio issue", "Video issue", "Stream interruption", "Recording issue", "Network", "Other"], checklists: orderChecklistProgramPhases([]), events: ["Happy", "Sad", "General"] };
    return NextResponse.json({ context, data });
  }

  try {
    const supabase = await createSupabaseServerClient();
    const canManageEquipment = hasManagerAccess(context.user.accessRoles, context.user.role) || hasAccessRole(context.user.accessRoles, context.user.role, "Equipment Manager");
    const [events, profiles, attendanceCrew, assignments, assets, loans, checklists, checklistTemplates, equipmentTemplates, sops, incidents, notifications, timeAlarms, content, audit, privateNotes, categories, eventActivity] = await Promise.all([
      supabase.from("events").select("*").order("event_date"),
      supabase.from("profiles").select("id, full_name, username, avatar_url, role, access_roles, qualification_status, job_title, active"),
      supabase.rpc("list_event_attendance_crew"),
      supabase.from("role_assignments").select("id, event_id, user_id, role_name, arrival_time, instructions, response_status, backup_user_id, service_history_hidden").order("created_at"),
      supabase.from("equipment_assets").select("*"),
      supabase.from("equipment_loans").select("*, equipment_loan_returns(*)"),
      supabase.from("checklist_items").select("*, checklist_instances(event_id, assignment_id)"),
      supabase.from("checklist_templates").select("id, title, category, created_by, created_at, updated_at, checklist_template_versions(id, version, checklist_template_items(id, step_order, label, is_required))").order("created_at", { ascending: false }),
      canManageEquipment ? supabase.from("equipment_templates").select("id,name,items,created_by,created_at,updated_at").order("created_at", { ascending: false }) : Promise.resolve({ data: [], error: null }),
      supabase.from("sops").select("*, sop_versions!sop_versions_sop_id_fkey(*, sop_steps(*))"),
      supabase.from("incidents").select("*"),
      supabase.from("notifications").select("*"),
      supabase.from("time_alarms").select("id,user_id,created_by,fire_at,description,triggered_at,cancelled_at,completed_at,created_at").order("fire_at"),
      supabase.from("content_projects").select("*"),
      hasManagerAccess(context.user.accessRoles, context.user.role) ? supabase.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(100) : Promise.resolve({ data: [], error: null }),
      isStaff(context.user.role) ? supabase.from("event_private_notes").select("event_id, notes") : Promise.resolve({ data: [], error: null }),
      supabase.from("operation_categories").select("category_type, category_name, sort_order").order("category_type").order("sort_order"),
      hasManagerAccess(context.user.accessRoles, context.user.role) ? supabase.from("event_activity").select("id,event_id,actor_id,action,summary,metadata,occurred_at").order("occurred_at", { ascending: false }).limit(2000) : Promise.resolve({ data: [], error: null }),
    ]);
    const profileRows = rows<DbProfile>(profiles, "Team");
    const attendanceProfileRows = rows<DbAttendanceCrew>(attendanceCrew, "Event attendance crew");
    const eventRows = rows<DbEvent>(events, "Events");
    const assignmentRows = rows<DbAssignment>(assignments, "Event crew");
    const assetRows = rows<DbAsset>(assets, "Equipment");
    const loanRows = rows<DbLoan>(loans, "Equipment loans");
    const checklistRows = rows<DbChecklist>(checklists, "Checklists");
    const templateRows = rows<DbChecklistTemplate>(checklistTemplates, "Checklist templates");
    const equipmentTemplateResult = equipmentTemplates as { data: DbEquipmentTemplate[] | null; error: { message: string; code?: string } | null };
    const equipmentTemplateSchemaNotApplied = Boolean(equipmentTemplateResult.error && /equipment_templates/i.test(equipmentTemplateResult.error.message) && ["PGRST205", "42P01"].includes(equipmentTemplateResult.error.code ?? ""));
    const equipmentTemplateRows = equipmentTemplateSchemaNotApplied ? [] : rows<DbEquipmentTemplate>(equipmentTemplateResult, "Equipment templates");
    const sopRows = rows<DbSop>(sops, "SOPs");
    const incidentRows = rows<DbIncident>(incidents, "Incidents");
    const notificationRows = rows<DbNotification>(notifications, "Notifications");
    const timeAlarmResult = timeAlarms as { data: { id: string; user_id: string; created_by: string; fire_at: string; description: string; triggered_at: string | null; cancelled_at: string | null; completed_at?: string | null }[] | null; error: { message: string; code?: string } | null };
    const completionColumnMissing = Boolean(timeAlarmResult.error && /completed_at/i.test(timeAlarmResult.error.message) && ["42703", "PGRST204"].includes(timeAlarmResult.error.code ?? ""));
    const readableTimeAlarmResult = completionColumnMissing
      ? await supabase.from("time_alarms").select("id,user_id,created_by,fire_at,description,triggered_at,cancelled_at,created_at").order("fire_at")
      : timeAlarmResult;
    const timeAlarmRows = rows<{ id: string; user_id: string; created_by: string; fire_at: string; description: string; triggered_at: string | null; cancelled_at: string | null; completed_at?: string | null }>(readableTimeAlarmResult, "Time alarms");
    const contentRows = rows<DbContent>(content, "Content");
    const auditRows = rows<DbAudit>(audit as { data: DbAudit[] | null; error: { message: string } | null }, "Audit history");
    const privateNoteRows = rows(privateNotes as { data: { event_id: string; notes: string }[] | null; error: { message: string } | null }, "Private event notes");
    const categoryRows = rows<DbCategory>(categories, "Categories");
    const activityRows = rows<DbEventActivity>(eventActivity as { data: DbEventActivity[] | null; error: { message: string } | null }, "Event activity");
    const noteByEvent = new Map(privateNoteRows.map((item) => [item.event_id, item.notes]));

    const canManage = hasManagerAccess(context.user.accessRoles, context.user.role);
    const data: AppData = {
      profiles: [...profileRows.map((p) => { const accessRoles = normalizeAccessRoles(p.access_roles ?? undefined, p.role); return { id: p.id, fullName: p.full_name, email: "", username: p.username ?? undefined, avatarUrl: p.avatar_url ?? undefined, role: primaryAccessRole(accessRoles, p.role), accessRoles, qualification: p.qualification_status, jobTitle: p.job_title ?? undefined, active: p.active }; }), ...attendanceProfileRows.filter((p) => !profileRows.some((profile) => profile.id === p.id)).map((p) => { const accessRoles = normalizeAccessRoles(undefined, p.role); return { id: p.id, fullName: p.full_name, email: "", role: primaryAccessRole(accessRoles, p.role), accessRoles, jobTitle: p.job_title ?? undefined }; })],
      events: eventRows.map((e) => ({ id: e.id, title: e.title, category: e.category, date: e.event_date, startTime: e.start_time ?? "", endTime: e.end_time ?? "", setupTime: e.setup_time ?? "", timeZone: e.time_zone, venue: e.venue, leadId: e.event_lead_id ?? "", description: e.description ?? "", livestream: e.livestream_required, recording: e.recording_required, photography: e.photography_required, status: e.status, publicInfo: e.public_information ?? "", privateNotes: noteByEvent.get(e.id) ?? "", programPhase: normalizeChecklistProgramPhase(e.current_program_phase) ?? "Pre-event", startedAt: e.started_at ?? undefined, endedAt: e.ended_at ?? undefined })),
      assignments: assignmentRows.map((assignment) => ({ id: assignment.id, eventId: assignment.event_id, userId: assignment.user_id, roleName: assignment.role_name, arrivalTime: assignment.arrival_time ?? undefined, instructions: assignment.instructions ?? "", response: assignment.response_status, backupUserId: assignment.backup_user_id ?? undefined, serviceHistoryHidden: assignment.service_history_hidden ?? false })),
      assets: assetRows.map((a) => ({ id: a.id, assetCode: a.asset_code, name: a.name, category: a.category, location: a.storage_location ?? "", quantity: a.quantity ?? 1, condition: a.condition, status: a.status, model: a.model ?? "", serial: a.serial_number ?? "", notes: a.notes ?? "", currentCustodianId: a.current_custodian_id ?? undefined })),
      loans: loanRows.map((loan) => { const returns = loan.equipment_loan_returns; const returned = Array.isArray(returns) ? returns[0] : returns; return { id: loan.id, assetId: loan.asset_id, borrowerId: loan.borrower_id, issuedBy: loan.issued_by, issuedAt: loan.issued_at, dueDate: loan.due_date ?? undefined, quantity: loan.quantity ?? 1, checkoutCondition: loan.checkout_condition, checkoutNotes: loan.checkout_notes, returnAt: returned?.returned_at, returnedBy: returned?.received_by, returnCondition: returned?.return_condition, returnNotes: returned?.notes }; }),
      checklistItems: checklistRows.flatMap((c) => c.checklist_instances && (canManage || c.assigned_user_id === context.user.id) ? [{ id: c.id, eventId: c.checklist_instances.event_id, assignmentId: c.checklist_instances.assignment_id, userId: c.assigned_user_id ?? "", label: c.label, required: c.is_required, status: c.status, completedAt: c.completed_at ?? undefined, note: c.notes ?? undefined, verifiedBy: c.verified_by ?? undefined, clearedFromChecklist: c.cleared_from_checklist ?? false, serviceHistoryHidden: c.service_history_hidden ?? false, programPhase: normalizeChecklistProgramPhase(c.program_phase) ?? "Pre-event" }] : []),
      checklistTemplates: templateRows.map((template) => {
        const latest = [...(template.checklist_template_versions ?? [])].sort((a, b) => b.version - a.version)[0];
        return { id: template.id, name: template.title, category: normalizeChecklistProgramPhase(template.category) ?? "Pre-event", createdBy: template.created_by, createdAt: template.created_at, updatedAt: template.updated_at, tasks: (latest?.checklist_template_items ?? []).sort((a, b) => a.step_order - b.step_order).map((task) => ({ id: task.id, label: task.label, required: task.is_required })) };
      }),
      equipmentTemplates: equipmentTemplateRows.map((template) => ({ id: template.id, name: template.name, items: Array.isArray(template.items) ? template.items : [], createdBy: template.created_by, createdAt: template.created_at, updatedAt: template.updated_at })),
      sops: sopRows.map((s) => { const versions = s.sop_versions ?? []; const version = versions.find((item) => item.id === s.current_version_id) ?? [...versions].sort((a, b) => b.version - a.version)[0]; const rawBlocks = Array.isArray(version?.rich_content) ? version.rich_content : []; const contentBlocks = rawBlocks.flatMap((block): NonNullable<AppData["sops"][number]["contentBlocks"]> => { if (!block || typeof block !== "object") return []; const item = block as Record<string, unknown>; if (["title", "heading", "subheading", "body"].includes(String(item.kind)) && typeof item.text === "string") return [{ kind: item.kind as "title" | "heading" | "subheading" | "body", text: item.text, fontSize: typeof item.fontSize === "number" ? item.fontSize : 16 }]; if (item.kind === "image" && typeof item.path === "string") return [{ kind: "image", path: item.path, alt: typeof item.alt === "string" ? item.alt : "" }]; return []; }); return { id: s.id, title: s.title, category: s.category, status: s.status, version: version?.version ?? 1, summary: version?.purpose ?? "", steps: (version?.sop_steps ?? []).sort((a, b) => a.step_number - b.step_number).map((step) => step.instruction), contentBlocks, reviewRequired: !version?.reviewed_at, updatedAt: s.updated_at, assignedUserIds: s.assigned_user_ids ?? [], availableToAll: s.available_to_all ?? true }; }),
      incidents: incidentRows.map((i) => ({ id: i.id, eventId: i.event_id ?? undefined, assetId: i.asset_id ?? undefined, reportedBy: i.reported_by, category: i.category, severity: i.severity, description: i.description, immediateAction: i.immediate_action ?? undefined, photos: i.photos ?? [], status: i.status, createdAt: i.created_at, resolution: i.resolution_notes ?? undefined })),
      categories: {
        equipment: categoryRows.filter((row) => row.category_type === "equipment").map((row) => row.category_name),
        sops: categoryRows.filter((row) => row.category_type === "sops").map((row) => row.category_name),
        incidents: categoryRows.filter((row) => row.category_type === "incidents").map((row) => row.category_name),
        checklists: orderChecklistProgramPhases(categoryRows.filter((row) => row.category_type === "checklists").sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)).map((row) => row.category_name)),
        events: categoryRows.filter((row) => row.category_type === "events").map((row) => row.category_name),
      },
      notifications: notificationRows.map((n) => ({ id: n.id, userId: n.user_id, senderId: n.sender_id ?? undefined, title: n.title, detail: n.body, date: n.created_at, read: Boolean(n.read_at), readAt: n.read_at ?? undefined, href: n.href ?? "dashboard" })),
      timeAlarms: timeAlarmRows.map((alarm) => ({ id: alarm.id, userId: alarm.user_id, createdBy: alarm.created_by, fireAt: alarm.fire_at, description: alarm.description, triggeredAt: alarm.triggered_at ?? undefined, cancelledAt: alarm.cancelled_at ?? undefined, completedAt: alarm.completed_at ?? undefined })),
      content: contentRows.map((c) => ({ id: c.id, eventId: c.event_id, title: c.title, type: c.content_type, stage: c.stage, assignedEditor: c.assigned_editor_id ?? "", dueDate: c.due_date ?? "", reviewer: c.assigned_reviewer_id ?? "", link: c.storage_link ?? undefined })),
      audit: auditRows.map((a) => ({ id: a.id, actorId: a.actor_id ?? "", action: a.action, target: a.target_type, targetId: a.target_id ?? "", createdAt: a.created_at })),
      eventActivity: activityRows.map((a) => ({ id: a.id, eventId: a.event_id, actorId: a.actor_id, action: a.action, summary: a.summary, metadata: a.metadata ?? {}, occurredAt: a.occurred_at })),
    };
    return NextResponse.json({ context, data: filterDemoData(data, context.user.id, normalizeAccessRoles(context.user.accessRoles, context.user.role)) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The database could not be read. Check the migration status." }, { status: 503 });
  }
}
