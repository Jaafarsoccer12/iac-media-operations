import type { AppRole, Asset, ChecklistItem, EquipmentLoan, MediaEvent } from "@/lib/types";

export const STAFF_ROLES: AppRole[];
export function can(role: AppRole | string | AppRole[] | string[], capability: string): boolean;
export function isStaff(role: AppRole | string | AppRole[]): boolean;
export function canIssueEquipment(asset: Asset | undefined, loans: EquipmentLoan[]): boolean;
export function eventReadiness(event: MediaEvent, checklistItems: ChecklistItem[]): { label: string; tone: string; reasons: string[] };
export function roleChecklist(role: string): string[];
