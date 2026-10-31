import "server-only";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createDemoData } from "@/lib/demo-data";
import { demoAccountSeed } from "@/lib/demo-account-seed";
import type { AppData, AppRole, Profile, SessionContext } from "@/lib/types";
import { normalizeAccessRoles, primaryAccessRole } from "@/lib/roles";
import { can, roleChecklist } from "@/lib/policy.mjs";
import { normalizeChecklistProgramPhase, orderChecklistProgramPhases } from "@/lib/checklist-phases.mjs";

const dataPath = process.env.IAC_DEMO_DATA_PATH || path.join(process.cwd(), ".local", "operations.json");
const accountPath = path.join(path.dirname(dataPath), "accounts.json");
const settingsPinPath = path.join(path.dirname(dataPath), "settings-pins.json");
const sessionCookie = "iac_demo_session";
let writeQueue = Promise.resolve();
let settingsPinWriteQueue = Promise.resolve();
type DemoAccount = { userId: string; username: string; salt: string; passwordHash: string; lastSignInAt: string | null };
export type SettingsPinFailure = { createdAt: string; device: string };
type SettingsPinRecord = { salt: string; pinHash: string; failedAttempts: SettingsPinFailure[] };

type LegacyReservation = { id: string; assetId: string; custodianId?: string; checkoutAt?: string; checkoutCondition?: string; returnAt?: string; returnCondition?: string; notes?: string };
type PersistedDemoData = Partial<AppData> & { reservations?: LegacyReservation[] };

function normalizeDemoData(raw: PersistedDemoData): AppData {
  const data = { ...raw, loans: Array.isArray(raw.loans) ? raw.loans : [] } as AppData;
  data.profiles = Array.isArray(data.profiles) ? data.profiles : [];
  data.assignments = Array.isArray(data.assignments) ? data.assignments : [];
  data.checklistTemplates = Array.isArray(data.checklistTemplates) ? data.checklistTemplates : [];
  data.equipmentTemplates = Array.isArray(data.equipmentTemplates) ? data.equipmentTemplates : [];
  data.chatMessages = Array.isArray(data.chatMessages) ? data.chatMessages : [];
  data.timeAlarms = Array.isArray(data.timeAlarms) ? data.timeAlarms : [];
  if (data.categories) data.categories.checklists = orderChecklistProgramPhases(data.categories.checklists);
  const seeded = createDemoData();
  const removedProfiles: Record<string, string> = { "demo-director": "demo-admin", "demo-lead": "demo-ameen", "demo-operator": "demo-naqi", "demo-trainee": "demo-zayn", "demo-organizer": "demo-moqset" };
  const remapId = (value?: string) => value ? removedProfiles[value] ?? value : value;
  for (const starter of seeded.profiles) {
    const existing = data.profiles.find((profile) => profile.id === starter.id);
    if (!existing) data.profiles.push({ ...starter });
    else {
      existing.username ??= starter.username;
      existing.jobTitle ??= starter.jobTitle;
      existing.active ??= true;
      existing.accessRoles = normalizeAccessRoles(existing.accessRoles, existing.role);
      existing.role = primaryAccessRole(existing.accessRoles, existing.role);
    }
  }
  data.profiles = data.profiles.filter((profile) => !Object.hasOwn(removedProfiles, profile.id));
  if (!data.crewAssignmentsInitialized) {
    for (const event of data.events ?? []) {
      const eventAssignments = data.assignments.filter((assignment) => assignment.eventId === event.id);
      for (const member of data.profiles.filter((profile) => profile.active !== false)) {
        if (eventAssignments.some((assignment) => assignment.userId === member.id)) continue;
        data.assignments.push({
          id: `assignment-${event.id}-${member.id}`, eventId: event.id, userId: member.id,
          roleName: member.jobTitle || member.role, arrivalTime: event.setupTime || undefined,
          instructions: "", response: "Pending",
        });
      }
    }
    data.crewAssignmentsInitialized = true;
  }
  data.incidents = (data.incidents ?? []).filter((item) => item.id !== "incident-sample");
  for (const event of data.events ?? []) {
    event.leadId = remapId(event.leadId) ?? "";
    event.programPhase = normalizeChecklistProgramPhase(event.programPhase) ?? data.categories?.checklists?.[0] ?? "Pre-event";
    if (!["Happy", "Sad", "General"].includes(event.category)) event.category = "General";
  }
  for (const item of data.assignments ?? []) {
    const previousUserId = item.userId;
    item.userId = remapId(item.userId) ?? item.userId;
    item.backupUserId = remapId(item.backupUserId);
    if (previousUserId === "demo-operator" || item.id === "assignment-1") item.roleName = "PTZ Camera Operator";
    if (previousUserId === "demo-trainee" || item.id === "assignment-4") item.roleName = "Video Switcher Operator";
  }
  for (const template of data.checklistTemplates) {
    template.category = normalizeChecklistProgramPhase(template.category) ?? data.categories?.checklists?.[0] ?? "Pre-event";
    template.tasks = Array.isArray(template.tasks) ? template.tasks : [];
    template.tasks = template.tasks.filter((task) => task && typeof task.label === "string").map((task) => ({ ...task, id: task.id || randomBytes(8).toString("hex"), required: task.required !== false }));
  }
  for (const template of data.equipmentTemplates) {
    template.items = Array.isArray(template.items) ? template.items : [];
    template.items = template.items.filter((item) => item && typeof item.assetId === "string" && Number.isInteger(item.quantity) && item.quantity > 0).map((item) => ({ ...item, id: item.id || randomBytes(8).toString("hex") }));
  }
  for (const item of data.checklistItems ?? []) {
    const eventPhase = (data.events ?? []).find((event) => event.id === item.eventId)?.programPhase;
    item.programPhase = normalizeChecklistProgramPhase(item.programPhase) ?? eventPhase ?? data.categories?.checklists?.[0] ?? "Pre-event";
    const assignment = data.assignments?.find((row) => row.id === item.assignmentId);
    if (assignment) {
      item.userId = assignment.userId;
      const checkIndex = Math.max(0, Number(item.id.match(/-check-(\d+)$/)?.[1] ?? 1) - 1);
      item.label = (roleChecklist(assignment.roleName) as string[])[checkIndex] ?? item.label;
    } else item.userId = remapId(item.userId) ?? item.userId;
  }
  for (const item of data.assets ?? []) item.currentCustodianId = remapId(item.currentCustodianId);
  for (const item of data.loans) { item.borrowerId = remapId(item.borrowerId) ?? item.borrowerId; item.issuedBy = remapId(item.issuedBy) ?? item.issuedBy; item.returnedBy = remapId(item.returnedBy); }
  for (const item of data.incidents ?? []) item.reportedBy = remapId(item.reportedBy) ?? item.reportedBy;
  for (const item of data.notifications ?? []) item.userId = remapId(item.userId) ?? item.userId;
  for (const item of data.chatMessages ?? []) { item.senderId = remapId(item.senderId) ?? item.senderId; item.recipientId = remapId(item.recipientId); }
  for (const item of data.content ?? []) { item.assignedEditor = remapId(item.assignedEditor) ?? item.assignedEditor; item.reviewer = remapId(item.reviewer) ?? item.reviewer; }
  for (const item of data.audit ?? []) item.actorId = remapId(item.actorId) ?? item.actorId;
  if (!Array.isArray(raw.loans) && Array.isArray(raw.reservations)) {
    data.loans = raw.reservations.filter((item) => item.checkoutAt || item.returnAt || ["Checked out", "Returned"].includes((item as LegacyReservation & { status?: string }).status ?? "")).map((item) => {
      const reservation = item as LegacyReservation & { status?: string };
      const checkoutAudit = data.audit.find((entry) => entry.targetId === reservation.id && entry.action === "Checked out equipment");
      const returnAudit = data.audit.find((entry) => entry.targetId === reservation.id && entry.action === "Returned equipment");
      const borrowerId = reservation.custodianId ?? checkoutAudit?.actorId ?? "";
      const returned = Boolean(reservation.returnAt || reservation.status === "Returned");
      return {
        id: reservation.id,
        assetId: reservation.assetId,
        borrowerId,
        issuedBy: checkoutAudit?.actorId ?? borrowerId,
        issuedAt: reservation.checkoutAt ?? new Date().toISOString(),
        checkoutCondition: reservation.checkoutCondition ?? "Good",
        returnAt: reservation.returnAt ?? (returned ? returnAudit?.createdAt : undefined),
        returnedBy: returned ? returnAudit?.actorId : undefined,
        returnCondition: reservation.returnCondition,
        returnNotes: reservation.notes,
      };
    });
    delete (data as AppData & { reservations?: LegacyReservation[] }).reservations;
    for (const asset of data.assets) {
      const activeLoan = data.loans.find((loan) => loan.assetId === asset.id && !loan.returnAt);
      if (activeLoan) {
        asset.status = "Checked out";
        asset.currentCustodianId = activeLoan.borrowerId;
      } else if (asset.status === "Reserved") {
        asset.status = asset.condition === "Good" ? "Available" : "Under maintenance";
      }
    }
  }
  return data;
}

export function hasSupabaseConfig() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

export function isDemoMode() {
  return process.env.NODE_ENV !== "production" && !hasSupabaseConfig() && process.env.DEMO_MODE !== "false";
}

export function demoSessionCookieName() {
  return sessionCookie;
}

export async function readDemoStore(): Promise<AppData> {
  if (!isDemoMode()) throw new Error("Local demo storage is disabled.");
  await mkdir(path.dirname(dataPath), { recursive: true });
  try {
    const content = await readFile(/* turbopackIgnore: true */ dataPath, "utf8");
    return normalizeDemoData(JSON.parse(content) as PersistedDemoData);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const initial = createDemoData();
    await writeFile(dataPath, JSON.stringify(initial, null, 2), "utf8");
    return initial;
  }
}

async function readSettingsPinStore(): Promise<Record<string, SettingsPinRecord>> {
  await mkdir(path.dirname(settingsPinPath), { recursive: true });
  try { return JSON.parse(await readFile(/* turbopackIgnore: true */ settingsPinPath, "utf8")) as Record<string, SettingsPinRecord>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return {}; }
}

async function writeSettingsPinStore(store: Record<string, SettingsPinRecord>) {
  const temporaryPath = `${settingsPinPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(store, null, 2), "utf8");
  await rename(temporaryPath, settingsPinPath);
}

export async function getDemoSettingsPinSecurity(userId: string) {
  const store = await readSettingsPinStore();
  const record = store[userId];
  return { pinConfigured: Boolean(record?.salt && record?.pinHash), failedAttempts: record?.failedAttempts ?? [] };
}

export async function setDemoSettingsPin(userId: string, pin: string, currentPin?: string) {
  const operation = settingsPinWriteQueue.then(async () => {
    const store = await readSettingsPinStore();
    const previous = store[userId];
    if (previous && (!currentPin || !verifySettingsPin(currentPin, previous.salt, previous.pinHash))) throw new Error("Enter your current settings PIN before changing it.");
    const salt = randomBytes(16).toString("hex");
    store[userId] = { salt, pinHash: scryptSync(pin, salt, 64).toString("hex"), failedAttempts: previous?.failedAttempts ?? [] };
    await writeSettingsPinStore(store);
  });
  settingsPinWriteQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function verifySettingsPin(pin: string, salt: string, hash: string) {
  const candidate = scryptSync(pin, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export async function verifyDemoSettingsPin(userId: string, pin: string, device: string) {
  const operation = settingsPinWriteQueue.then(async () => {
    const store = await readSettingsPinStore();
    const record = store[userId];
    if (!record) throw new Error("Create a settings PIN before opening Administration.");
    if (verifySettingsPin(pin, record.salt, record.pinHash)) return { valid: true, failedAttempts: record.failedAttempts ?? [] };
    const failedAttempts = [...(record.failedAttempts ?? []), { createdAt: new Date().toISOString(), device: device.slice(0, 80) }].slice(-30);
    store[userId] = { ...record, failedAttempts };
    await writeSettingsPinStore(store);
    return { valid: false, failedAttempts };
  });
  settingsPinWriteQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

async function readDemoAccounts(): Promise<DemoAccount[]> {
  await mkdir(path.dirname(accountPath), { recursive: true });
  try {
    const content = await readFile(/* turbopackIgnore: true */ accountPath, "utf8");
    return JSON.parse(content) as DemoAccount[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const initial = demoAccountSeed.map((account) => ({ ...account, lastSignInAt: null }));
    await writeFile(accountPath, JSON.stringify(initial, null, 2), "utf8");
    return initial;
  }
}

async function writeDemoAccounts(accounts: DemoAccount[]) {
  const temporaryPath = `${accountPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(accounts, null, 2), "utf8");
  await rename(temporaryPath, accountPath);
}

function passwordRecord(password: string, userId: string, username: string, lastSignInAt: string | null = null): DemoAccount {
  const salt = randomBytes(16).toString("hex");
  const passwordHash = scryptSync(password, salt, 64).toString("hex");
  return { userId, username, salt, passwordHash, lastSignInAt };
}

function generatedUsername(fullName: string) {
  return fullName.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "").slice(0, 32);
}

function validateUsername(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(normalized)) throw new Error("Usernames must be 3–32 characters and use letters, numbers, dots, dashes, or underscores.");
  return normalized;
}

export async function listDemoTeamAccounts() {
  const [data, accounts] = await Promise.all([readDemoStore(), readDemoAccounts()]);
  return accounts.flatMap((account) => {
    const profile = data.profiles.find((item) => item.id === account.userId);
    if (!profile) return [];
    const accessRoles = normalizeAccessRoles(profile.accessRoles, profile.role);
    return [{ id: profile.id, fullName: profile.fullName, email: profile.email, username: account.username, jobTitle: profile.jobTitle ?? "", avatarUrl: profile.avatarUrl ?? "", role: primaryAccessRole(accessRoles, profile.role), accessRoles, active: profile.active ?? true, qualification: profile.qualification ?? "Not started", createdAt: "", lastSignInAt: account.lastSignInAt }];
  });
}

export async function authenticateDemoAccount(username: string, password: string) {
  if (!isDemoMode()) return null;
  const accounts = await readDemoAccounts();
  const normalized = username.trim().toLowerCase();
  const account = accounts.find((item) => item.username === normalized);
  const data = await readDemoStore();
  const profile = account && data.profiles.find((item) => item.id === account.userId);
  if (!account || !profile || profile.active === false) return null;
  const candidate = scryptSync(password, account.salt, 64);
  const expected = Buffer.from(account.passwordHash, "hex");
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) return null;
  account.lastSignInAt = new Date().toISOString();
  await writeDemoAccounts(accounts);
  return { id: profile.id, role: profile.role };
}

export async function createDemoTeamAccount(values: { fullName: string; username?: string; jobTitle?: string; accessRoles: AppRole[]; avatarUrl?: string }, actorId: string) {
  const accessRoles = normalizeAccessRoles(values.accessRoles, "Videographer");
  const role = primaryAccessRole(accessRoles, "Videographer");
  const username = validateUsername(values.username || generatedUsername(values.fullName));
  const accounts = await readDemoAccounts();
  if (accounts.some((item) => item.username === username)) throw new Error("That username is already in use.");
  const id = `demo-${crypto.randomUUID()}`;
  const temporaryPassword = randomBytes(18).toString("base64url");
  await updateDemoStore((data) => {
    data.profiles.push({ id, fullName: values.fullName, email: "", username, role, accessRoles, qualification: "Not started", jobTitle: values.jobTitle ?? "", active: true, avatarUrl: values.avatarUrl ?? "" });
    addAudit(data, actorId, "Created team account", "profile", id);
  });
  try {
    accounts.push(passwordRecord(temporaryPassword, id, username));
    await writeDemoAccounts(accounts);
  } catch (error) {
    await updateDemoStore((data) => { data.profiles = data.profiles.filter((profile) => profile.id !== id); });
    throw error;
  }
  return { id, username, temporaryPassword };
}

export async function updateDemoTeamAccount(values: { memberId: string; fullName: string; username: string; jobTitle?: string; accessRoles: AppRole[]; active: boolean; avatarUrl?: string }, actorId: string) {
  const accessRoles = normalizeAccessRoles(values.accessRoles, "Videographer");
  const role = primaryAccessRole(accessRoles, "Videographer");
  const username = validateUsername(values.username);
  const accounts = await readDemoAccounts();
  const account = accounts.find((item) => item.userId === values.memberId);
  if (!account) throw new Error("That sign-in account could not be found.");
  if (accounts.some((item) => item.userId !== values.memberId && item.username === username)) throw new Error("That username is already in use.");
  const data = await readDemoStore();
  const target = data.profiles.find((item) => item.id === values.memberId);
  if (!target) throw new Error("That team member could not be found.");
  const targetIsAdmin = target.accessRoles?.includes("Administrator") || target.role === "Administrator";
  if (targetIsAdmin && (!accessRoles.includes("Administrator") || !values.active)
    && !data.profiles.some((profile) => profile.id !== target.id && (profile.accessRoles?.includes("Administrator") || profile.role === "Administrator") && profile.active !== false)) {
    throw new Error("Keep at least one active administrator so the team does not lose account control.");
  }
  await updateDemoStore((current) => {
    const profile = current.profiles.find((item) => item.id === values.memberId);
    if (!profile) throw new Error("That team member could not be found.");
    Object.assign(profile, { fullName: values.fullName, username, jobTitle: values.jobTitle ?? "", role, accessRoles, active: values.active, avatarUrl: values.avatarUrl ?? "" });
    addAudit(current, actorId, "Updated team account", "profile", profile.id);
  });
  account.username = username;
  await writeDemoAccounts(accounts);
  return { ok: true };
}

export async function updateDemoOwnProfile(userId: string, values: { username: string; avatarUrl: string }) {
  const username = validateUsername(values.username);
  const [data, accounts] = await Promise.all([readDemoStore(), readDemoAccounts()]);
  const account = accounts.find((item) => item.userId === userId);
  const profile = data.profiles.find((item) => item.id === userId);
  if (!account || !profile) throw new Error("Your account could not be found.");
  if (accounts.some((item) => item.userId !== userId && item.username === username)) throw new Error("That username is already in use.");
  await updateDemoStore((current) => {
    const currentProfile = current.profiles.find((item) => item.id === userId);
    if (!currentProfile) throw new Error("Your profile could not be found.");
    currentProfile.username = username;
    currentProfile.avatarUrl = values.avatarUrl;
    addAudit(current, userId, "Updated own profile", "profile", userId);
  });
  account.username = username;
  await writeDemoAccounts(accounts);
  return { ok: true };
}

export async function changeDemoPassword(userId: string, currentPassword: string, nextPassword: string) {
  const accounts = await readDemoAccounts();
  const index = accounts.findIndex((item) => item.userId === userId);
  const account = accounts[index];
  if (!account) throw new Error("Your sign-in account could not be found.");
  const candidate = scryptSync(currentPassword, account.salt, 64);
  const expected = Buffer.from(account.passwordHash, "hex");
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) throw new Error("The current password is incorrect.");
  accounts[index] = passwordRecord(nextPassword, account.userId, account.username, account.lastSignInAt);
  await writeDemoAccounts(accounts);
  await updateDemoStore((current) => addAudit(current, userId, "Changed own password", "profile", userId));
  return { ok: true };
}

export async function resetDemoTeamPassword(memberId: string, actorId: string) {
  const data = await readDemoStore();
  const profile = data.profiles.find((item) => item.id === memberId);
  if (!profile || profile.active === false) throw new Error("Enable this account before resetting its password.");
  const accounts = await readDemoAccounts();
  const account = accounts.find((item) => item.userId === memberId);
  if (!account) throw new Error("That sign-in account could not be found.");
  const temporaryPassword = randomBytes(18).toString("base64url");
  const updated = passwordRecord(temporaryPassword, account.userId, account.username, account.lastSignInAt);
  accounts[accounts.findIndex((item) => item.userId === memberId)] = updated;
  await writeDemoAccounts(accounts);
  await updateDemoStore((current) => addAudit(current, actorId, "Reset team account password", "profile", memberId));
  return { username: account.username, temporaryPassword };
}

export async function setDemoTeamPassword(memberId: string, password: string, actorId: string) {
  const data = await readDemoStore();
  const profile = data.profiles.find((item) => item.id === memberId);
  if (!profile || profile.active === false) throw new Error("Enable this account before setting its password.");
  const accounts = await readDemoAccounts();
  const index = accounts.findIndex((item) => item.userId === memberId);
  const account = accounts[index];
  if (!account) throw new Error("That sign-in account could not be found.");
  accounts[index] = passwordRecord(password, account.userId, account.username, account.lastSignInAt);
  await writeDemoAccounts(accounts);
  await updateDemoStore((current) => addAudit(current, actorId, "Set team account password", "profile", memberId));
  return { username: account.username };
}

export async function updateDemoStore<T>(update: (data: AppData) => T | Promise<T>): Promise<T> {
  const action = writeQueue.then(async () => {
    const data = await readDemoStore();
    const result = await update(data);
    const tempPath = `${dataPath}.${process.pid}.tmp`;
    await writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
    await rename(tempPath, dataPath);
    return result;
  });
  writeQueue = action.then(() => undefined, () => undefined);
  return action;
}

export function signDemoUser(userId: string) {
  return signDemoPayload(`user:${userId}`);
}

function signDemoPayload(value: string) {
  const secret = process.env.DEMO_SESSION_SECRET && !process.env.DEMO_SESSION_SECRET.startsWith("replace-")
    ? process.env.DEMO_SESSION_SECRET
    : process.env.IAC_DEMO_SESSION_FALLBACK ??= randomBytes(32).toString("hex");
  const payload = Buffer.from(value).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyDemoSession(token: string | undefined): { userId: string } | null {
  if (!token || !isDemoMode()) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const secret = process.env.DEMO_SESSION_SECRET && !process.env.DEMO_SESSION_SECRET.startsWith("replace-")
    ? process.env.DEMO_SESSION_SECRET
    : process.env.IAC_DEMO_SESSION_FALLBACK;
  if (!secret) return null;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const session = Buffer.from(payload, "base64url").toString("utf8");
  if (session.startsWith("user:")) return { userId: session.slice(5) };
  return null;
}

export function profileContext(user: Profile, mode: "demo" | "supabase"): SessionContext {
  const accessRoles = normalizeAccessRoles(user.accessRoles, user.role);
  const normalizedUser = { ...user, accessRoles, role: primaryAccessRole(accessRoles, user.role) };
  const capabilities = ["manage_system", "manage_events", "manage_team", "manage_equipment", "view_equipment", "manage_sops", "manage_content", "resolve_incidents", "view_reports", "view_team", "manage_checklists", "report_incidents", "complete_checklists", "update_content", "view_public_events", "view_sops", "view_notifications"].filter((capability) => can(accessRoles, capability));
  return { user: normalizedUser, mode, capabilities };
}

export function addAudit(data: AppData, actorId: string, action: string, target: string, targetId: string) {
  data.audit.unshift({ id: crypto.randomUUID(), actorId, action, target, targetId, createdAt: new Date().toISOString() });
  data.audit = data.audit.slice(0, 100);
}

