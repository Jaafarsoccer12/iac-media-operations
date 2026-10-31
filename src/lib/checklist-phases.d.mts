export type ChecklistProgramPhase = "Pre-event" | "Quran" | "During recitation" | "Noha" | "After event";
export const CHECKLIST_PROGRAM_PHASES: readonly ["Pre-event", "Quran", "During recitation", "Noha", "After event"];
export function normalizeChecklistProgramPhase(value: unknown): ChecklistProgramPhase | undefined;
export function orderChecklistProgramPhases(values: unknown): ChecklistProgramPhase[];
