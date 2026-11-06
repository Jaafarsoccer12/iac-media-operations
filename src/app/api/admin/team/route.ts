import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { User } from "@supabase/supabase-js";
import { getSessionContext } from "@/lib/auth";
import { hasSupabaseAdminConfig, createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createDemoTeamAccount, listDemoTeamAccounts, resetDemoTeamPassword, setDemoTeamPassword, updateDemoTeamAccount } from "@/lib/store";
import type { AppRole } from "@/lib/types";
import { hasAccessRole, hasManagerAccess, primaryAccessRole } from "@/lib/roles";

export const dynamic = "force-dynamic";

const roleSchema = z.enum(["Administrator", "Director", "Videographer", "Video Switcher Operator", "Camera Operator", "PTZ Camera Operator", "Audio Operator", "Equipment Manager", "Video Operator", "Photography"]);
const envelopeSchema = z.object({ action: z.string(), payload: z.record(z.string(), z.unknown()).default({}) });
const usernameSchema = z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).transform((value) => value.toLowerCase());
const avatarSchema = z.string().trim().max(400_000).refine((value) => !value || /^https?:\/\/[^\s]+$/i.test(value) || /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value), "Choose a JPEG photo or use a secure image link.").default("");
const accessRolesSchema = z.array(roleSchema).min(1).max(10);
const inviteSchema = z.object({ fullName: z.string().trim().min(1).max(120), email: z.email().trim().max(254), username: usernameSchema, jobTitle: z.string().trim().max(240).default(""), avatarUrl: avatarSchema, accessRoles: accessRolesSchema });
const demoInviteSchema = z.object({ fullName: z.string().trim().min(1).max(120), username: usernameSchema.optional(), jobTitle: z.string().trim().max(240).default(""), avatarUrl: avatarSchema, accessRoles: accessRolesSchema });
const updateSchema = z.object({ memberId: z.uuid(), fullName: z.string().trim().min(1).max(120), email: z.email().trim().max(254), username: usernameSchema, jobTitle: z.string().trim().max(240).default(""), avatarUrl: avatarSchema, accessRoles: accessRolesSchema, active: z.boolean() });
const demoUpdateSchema = z.object({ memberId: z.string().min(1), fullName: z.string().trim().min(1).max(120), username: usernameSchema, jobTitle: z.string().trim().max(240).default(""), avatarUrl: avatarSchema, accessRoles: accessRolesSchema, active: z.boolean() });
const resetSchema = z.object({ memberId: z.uuid() });
const setPasswordSchema = z.object({ memberId: z.string().min(1), password: z.string().min(4).max(128), confirmPassword: z.string().min(4).max(128) }).refine((value) => value.password === value.confirmPassword, { message: "The passwords do not match.", path: ["confirmPassword"] });

function redirectUrl(request: NextRequest) {
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() || request.nextUrl.origin;
  const target = new URL("/auth/callback", baseUrl);
  target.searchParams.set("next", "/set-password");
  return target.toString();
}

async function writeAudit(actorId: string, action: string, memberId: string, metadata: Record<string, unknown> = {}) {
  const admin = createSupabaseAdminClient();
  const { error } = await admin.from("audit_logs").insert({ actor_id: actorId, action, target_type: "profile", target_id: memberId, metadata });
  if (error) throw new Error("The account changed, but its audit entry could not be saved. Contact the system administrator.");
}

async function listMembers() {
  const admin = createSupabaseAdminClient();
  const profilesResult = await admin.from("profiles").select("id,full_name,username,avatar_url,job_title,role,access_roles,active,qualification_status,created_at").order("full_name");
  if (profilesResult.error) throw new Error("Team profiles could not be loaded. Apply the latest team account migration.");

  const authUsers: User[] = [];
  for (let page = 1; page <= 200; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error("Sign-in accounts could not be loaded.");
    authUsers.push(...data.users);
    if (data.users.length < 1000) break;
  }
  const byId = new Map(authUsers.map((authUser) => [authUser.id, authUser]));
  return (profilesResult.data ?? []).map((profile) => {
    const authUser = byId.get(profile.id);
    return {
      id: profile.id,
      fullName: profile.full_name,
      email: authUser?.email ?? "",
      username: profile.username ?? "",
      jobTitle: profile.job_title ?? "",
      avatarUrl: profile.avatar_url ?? "",
      role: profile.role as AppRole,
      accessRoles: (profile.access_roles as AppRole[] | null) ?? [profile.role as AppRole],
      active: profile.active,
      qualification: profile.qualification_status,
      createdAt: authUser?.created_at ?? profile.created_at,
      lastSignInAt: authUser?.last_sign_in_at ?? null,
    };
  });
}

export async function GET() {
  const context = await getSessionContext();
  if (!context) return NextResponse.json({ error: "Sign in to manage team accounts." }, { status: 401 });
  if (!hasManagerAccess(context.user.accessRoles, context.user.role)) return NextResponse.json({ error: "Only an administrator or director can manage sign-in accounts." }, { status: 403 });
  if (context.mode === "demo") return NextResponse.json({ ready: true, reason: "local-accounts", members: await listDemoTeamAccounts() });
  if (!hasSupabaseAdminConfig()) return NextResponse.json({ ready: false, reason: "server-key-missing", members: [] });
  try {
    return NextResponse.json({ ready: true, members: await listMembers() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Team accounts could not be loaded." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  const context = await getSessionContext();
  if (!context) return NextResponse.json({ error: "Your session has expired. Sign in again." }, { status: 401 });
  const isAdministrator = hasAccessRole(context.user.accessRoles, context.user.role, "Administrator");
  if (!isAdministrator && !hasAccessRole(context.user.accessRoles, context.user.role, "Director")) return NextResponse.json({ error: "Only an administrator or director can manage sign-in accounts." }, { status: 403 });

  const parsed = envelopeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "The account request could not be understood." }, { status: 400 });
  if (["team_reset_password", "team_set_password"].includes(parsed.data.action) && !isAdministrator) return NextResponse.json({ error: "Only an administrator can set or reset a team member's password." }, { status: 403 });

  if (parsed.data.action === "team_update_roles") {
    const values = z.object({ memberId: z.uuid(), accessRoles: accessRolesSchema }).safeParse(parsed.data.payload);
    if (!values.success) return NextResponse.json({ error: values.error.issues.map((issue) => issue.message).join(" ") }, { status: 400 });
    if (!isAdministrator && values.data.accessRoles.includes("Administrator")) return NextResponse.json({ error: "Only an administrator can grant administrator access." }, { status: 403 });
    try {
      if (context.mode === "demo") {
        const current = (await listDemoTeamAccounts()).find((member) => member.id === values.data.memberId);
        if (!current) return NextResponse.json({ error: "That team member could not be found." }, { status: 404 });
        if (!isAdministrator && (current.accessRoles ?? [current.role]).includes("Administrator")) return NextResponse.json({ error: "Only an administrator can edit an administrator account." }, { status: 403 });
        const role = primaryAccessRole(values.data.accessRoles, "Videographer");
        await updateDemoTeamAccount({ memberId: current.id, fullName: current.fullName, username: current.username, jobTitle: current.jobTitle, avatarUrl: current.avatarUrl ?? "", accessRoles: values.data.accessRoles, active: current.active }, context.user.id);
        return NextResponse.json({ ok: true, role });
      }
      const supabase = await createSupabaseServerClient();
      const { error } = await supabase.rpc("admin_update_profile_roles", { p_member_id: values.data.memberId, p_access_roles: values.data.accessRoles });
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "App access roles could not be updated." }, { status: 400 });
    }
  }

  if (context.mode === "demo") {
    try {
      if (parsed.data.action === "team_invite") {
        const values = demoInviteSchema.safeParse(parsed.data.payload);
        if (!values.success) return NextResponse.json({ error: values.error.issues.map((issue) => issue.message).join(" ") }, { status: 400 });
        if (!isAdministrator && values.data.accessRoles.includes("Administrator")) return NextResponse.json({ error: "Only an administrator can grant administrator access." }, { status: 403 });
        const account = await createDemoTeamAccount(values.data, context.user.id);
        return NextResponse.json({ ok: true, ...account });
      }
      if (parsed.data.action === "team_update_member") {
        const values = demoUpdateSchema.safeParse(parsed.data.payload);
        if (!values.success) return NextResponse.json({ error: values.error.issues.map((issue) => issue.message).join(" ") }, { status: 400 });
        const current = (await listDemoTeamAccounts()).find((member) => member.id === values.data.memberId);
        if (!current) return NextResponse.json({ error: "That team member could not be found." }, { status: 404 });
        if (!isAdministrator && ((current.accessRoles ?? [current.role]).includes("Administrator") || values.data.accessRoles.includes("Administrator"))) return NextResponse.json({ error: "Only an administrator can change an administrator account or grant administrator access." }, { status: 403 });
        return NextResponse.json(await updateDemoTeamAccount(values.data, context.user.id));
      }
      if (parsed.data.action === "team_reset_password") {
        const values = z.object({ memberId: z.string().min(1) }).safeParse(parsed.data.payload);
        if (!values.success) return NextResponse.json({ error: "Choose a valid team account." }, { status: 400 });
        const current = (await listDemoTeamAccounts()).find((member) => member.id === values.data.memberId);
        if (!current) return NextResponse.json({ error: "That team member could not be found." }, { status: 404 });
        if (!isAdministrator && (current.accessRoles ?? [current.role]).includes("Administrator")) return NextResponse.json({ error: "Only an administrator can reset an administrator account's password." }, { status: 403 });
        return NextResponse.json({ ok: true, ...(await resetDemoTeamPassword(values.data.memberId, context.user.id)) });
      }
      if (parsed.data.action === "team_set_password") {
        const values = setPasswordSchema.safeParse(parsed.data.payload);
        if (!values.success) return NextResponse.json({ error: values.error.issues.map((issue) => issue.message).join(" ") }, { status: 400 });
        const result = await setDemoTeamPassword(values.data.memberId, values.data.password, context.user.id);
        return NextResponse.json({ ok: true, username: result.username });
      }
      return NextResponse.json({ error: "That account action is not available." }, { status: 400 });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "The account could not be updated." }, { status: 400 });
    }
  }
  if (!hasSupabaseAdminConfig()) return NextResponse.json({ error: "Account invitations need the server-side Supabase service key. Add it to the server environment and restart the app." }, { status: 503 });
  const admin = createSupabaseAdminClient();

  try {
    if (parsed.data.action === "team_invite") {
      const values = inviteSchema.safeParse(parsed.data.payload);
      if (!values.success) return NextResponse.json({ error: values.error.issues.map((issue) => issue.message).join(" ") }, { status: 400 });
      if (!isAdministrator && values.data.accessRoles.includes("Administrator")) return NextResponse.json({ error: "Only an administrator can grant administrator access." }, { status: 403 });
      const email = values.data.email.toLowerCase();
      const authAvatarUrl = values.data.avatarUrl.startsWith("data:") ? "" : values.data.avatarUrl;
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
        data: { full_name: values.data.fullName, username: values.data.username, job_title: values.data.jobTitle, avatar_url: authAvatarUrl },
        redirectTo: redirectUrl(request),
      });
      if (error || !data.user) {
        const alreadyRegistered = /already|registered|exists/i.test(error?.message ?? "");
        return NextResponse.json({ error: alreadyRegistered ? "That email already has an account. Find it in the team list and update its access." : "The invitation could not be sent. Check the email address and Supabase email delivery settings." }, { status: alreadyRegistered ? 409 : 502 });
      }
      const primaryRole = primaryAccessRole(values.data.accessRoles, "Videographer");
      const { error: profileError } = await admin.from("profiles").upsert({ id: data.user.id, full_name: values.data.fullName, username: values.data.username, avatar_url: values.data.avatarUrl, job_title: values.data.jobTitle, role: primaryRole, access_roles: values.data.accessRoles, active: true }, { onConflict: "id" });
      if (profileError) {
        await admin.auth.admin.deleteUser(data.user.id);
        return NextResponse.json({ error: "The invite could not be linked to a team profile. Apply the latest account migration and try again." }, { status: 503 });
      }
      await writeAudit(context.user.id, "Invited team member", data.user.id, { email, access_roles: values.data.accessRoles, role: primaryRole, job_title: values.data.jobTitle });
      return NextResponse.json({ ok: true, id: data.user.id });
    }

    if (parsed.data.action === "team_update_member") {
      const values = updateSchema.safeParse(parsed.data.payload);
      if (!values.success) return NextResponse.json({ error: values.error.issues.map((issue) => issue.message).join(" ") }, { status: 400 });
      const memberId = values.data.memberId;
      const { data: current, error: currentError } = await admin.from("profiles").select("id,role,access_roles,active").eq("id", memberId).maybeSingle();
      if (currentError || !current) return NextResponse.json({ error: "That team member could not be found." }, { status: 404 });
      const currentRoles = (current.access_roles as AppRole[] | null) ?? [current.role as AppRole];
      if (!isAdministrator && (currentRoles.includes("Administrator") || values.data.accessRoles.includes("Administrator"))) return NextResponse.json({ error: "Only an administrator can change an administrator account or grant administrator access." }, { status: 403 });
      const nextRole = primaryAccessRole(values.data.accessRoles, "Videographer");
      const removesAdmin = currentRoles.includes("Administrator") && current.active && (!values.data.accessRoles.includes("Administrator") || !values.data.active);
      if (removesAdmin) {
        const { count, error } = await admin.from("profiles").select("id", { count: "exact", head: true }).contains("access_roles", ["Administrator"]).eq("active", true);
        if (error) throw new Error("Administrator access could not be checked.");
        if ((count ?? 0) <= 1) return NextResponse.json({ error: "Keep at least one active administrator so the team does not lose account control." }, { status: 409 });
      }
      const authAvatarUrl = values.data.avatarUrl.startsWith("data:") ? "" : values.data.avatarUrl;
      const { data: authResult, error: authError } = await admin.auth.admin.updateUserById(memberId, { email: values.data.email.trim().toLowerCase(), user_metadata: { full_name: values.data.fullName, username: values.data.username, job_title: values.data.jobTitle, avatar_url: authAvatarUrl } });
      if (authError || !authResult.user) return NextResponse.json({ error: "The sign-in email could not be updated. The person may need to confirm the new address." }, { status: 502 });
      const { error: profileError } = await admin.from("profiles").update({ full_name: values.data.fullName, username: values.data.username, avatar_url: values.data.avatarUrl, job_title: values.data.jobTitle, role: nextRole, access_roles: values.data.accessRoles, active: values.data.active }).eq("id", memberId);
      if (profileError) throw new Error("The sign-in email was updated, but the team profile could not be saved. Apply the latest account migration.");
      await writeAudit(context.user.id, "Updated team account", memberId, { email: values.data.email.trim().toLowerCase(), access_roles: values.data.accessRoles, role: nextRole, active: values.data.active, job_title: values.data.jobTitle });
      return NextResponse.json({ ok: true });
    }

    if (parsed.data.action === "team_reset_password") {
      const values = resetSchema.safeParse(parsed.data.payload);
      if (!values.success) return NextResponse.json({ error: "Choose a valid team account." }, { status: 400 });
      const { data: member, error: memberError } = await admin.from("profiles").select("id,active,role,access_roles").eq("id", values.data.memberId).maybeSingle();
      if (memberError || !member) return NextResponse.json({ error: "That team member could not be found." }, { status: 404 });
      if (!isAdministrator && (((member.access_roles as AppRole[] | null) ?? [member.role as AppRole]).includes("Administrator"))) return NextResponse.json({ error: "Only an administrator can reset an administrator account's password." }, { status: 403 });
      if (!member.active) return NextResponse.json({ error: "Enable this account before sending a password setup link." }, { status: 409 });
      const users = await admin.auth.admin.getUserById(values.data.memberId);
      const email = users.data.user?.email;
      if (users.error || !email) return NextResponse.json({ error: "This account does not have a sign-in email." }, { status: 404 });
      const supabase = await createSupabaseServerClient();
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl(request) });
      if (error) return NextResponse.json({ error: "The password setup email could not be sent. Check Supabase email delivery settings." }, { status: 502 });
      await writeAudit(context.user.id, "Sent password setup link", values.data.memberId, { email });
      return NextResponse.json({ ok: true });
    }

    if (parsed.data.action === "team_set_password") {
      const values = setPasswordSchema.safeParse(parsed.data.payload);
      if (!values.success) return NextResponse.json({ error: values.error.issues.map((issue) => issue.message).join(" ") }, { status: 400 });
      const { data: member, error: memberError } = await admin.from("profiles").select("id,active").eq("id", values.data.memberId).maybeSingle();
      if (memberError || !member) return NextResponse.json({ error: "That team member could not be found." }, { status: 404 });
      if (!member.active) return NextResponse.json({ error: "Enable this account before setting its password." }, { status: 409 });
      const { error } = await admin.auth.admin.updateUserById(values.data.memberId, { password: values.data.password });
      if (error) return NextResponse.json({ error: "The password could not be saved. Use at least 4 characters and try again." }, { status: 400 });
      await writeAudit(context.user.id, "Set team account password", values.data.memberId);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "That account action is not available." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The account could not be updated." }, { status: 503 });
  }
}
