import "server-only";
import { cookies } from "next/headers";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { demoSessionCookieName, hasSupabaseConfig, profileContext, readDemoStore, verifyDemoSession } from "@/lib/store";
import type { Profile, SessionContext } from "@/lib/types";

export async function getSessionContext(): Promise<SessionContext | null> {
  if (!hasSupabaseConfig()) {
    const cookieStore = await cookies();
    const session = verifyDemoSession(cookieStore.get(demoSessionCookieName())?.value);
    if (!session) return null;
    const data = await readDemoStore();
    const user = data.profiles.find((profile) => profile.id === session.userId);
    return user && user.active !== false ? profileContext(user, "demo") : null;
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return null;
  const { data: profile, error: profileError } = await supabase.from("profiles").select("id, full_name, username, avatar_url, role, access_roles, qualification_status, job_title, active").eq("id", user.id).single();
  if (profileError || !profile) return null;
  if (!profile.active) {
    await supabase.auth.signOut();
    return null;
  }
  const mapped: Profile = { id: profile.id, fullName: profile.full_name, email: user.email ?? "", username: profile.username ?? undefined, avatarUrl: profile.avatar_url ?? undefined, role: profile.role, accessRoles: profile.access_roles ?? [profile.role], qualification: profile.qualification_status, jobTitle: profile.job_title ?? undefined, active: profile.active };
  return profileContext(mapped, "supabase");
}

