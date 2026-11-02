import type { AppRole } from "@/lib/types";

export const APP_ROLES: AppRole[] = ["Administrator", "Director", "Videographer", "Video Switcher Operator", "Camera Operator", "PTZ Camera Operator", "Audio Operator", "Equipment Manager", "Video Operator", "Photography"];

const ROLE_PRIORITY: AppRole[] = APP_ROLES;
const LEGACY_ROLE: Record<string, AppRole> = {
  "Media Director": "Director",
  "Team Lead": "Director",
  Operator: "Videographer",
  Trainee: "Videographer",
  "Event Organizer": "Videographer",
};

export function normalizeRole(role: unknown, fallback: AppRole = "Videographer"): AppRole {
  if (typeof role === "string" && APP_ROLES.includes(role as AppRole)) return role as AppRole;
  if (typeof role === "string" && LEGACY_ROLE[role]) return LEGACY_ROLE[role];
  return fallback;
}

export function normalizeAccessRoles(roles: AppRole[] | undefined, fallback: AppRole): AppRole[] {
  const selectedValues = new Set((roles ?? []).map((role) => normalizeRole(role)));
  const selected = APP_ROLES.filter((role) => selectedValues.has(role));
  return selected.length ? selected : [normalizeRole(fallback)];
}

export function primaryAccessRole(roles: AppRole[] | undefined, fallback: AppRole): AppRole {
  const normalized = normalizeAccessRoles(roles, fallback);
  return ROLE_PRIORITY.find((role) => normalized.includes(role)) ?? normalizeRole(fallback);
}

export function hasAccessRole(roles: AppRole[] | undefined, fallback: AppRole, role: AppRole): boolean {
  return normalizeAccessRoles(roles, fallback).includes(role);
}

export function hasManagerAccess(roles: AppRole[] | undefined, fallback: AppRole): boolean {
  return hasAccessRole(roles, fallback, "Administrator") || hasAccessRole(roles, fallback, "Director");
}
