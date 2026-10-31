export const CHECKLIST_PROGRAM_PHASES = Object.freeze([
  "Pre-event",
  "Quran",
  "During recitation",
  "Noha",
  "After event",
]);

export function normalizeChecklistProgramPhase(value) {
  if (typeof value !== "string") return undefined;
  const migrated = value === "During lecture" ? "During recitation" : value === "Special event" ? "After event" : value;
  return CHECKLIST_PROGRAM_PHASES.includes(migrated) ? migrated : undefined;
}

export function orderChecklistProgramPhases(values) {
  const ordered = [];
  for (const value of Array.isArray(values) ? values : []) {
    const phase = normalizeChecklistProgramPhase(value);
    if (phase && !ordered.includes(phase)) ordered.push(phase);
  }
  return [...ordered, ...CHECKLIST_PROGRAM_PHASES.filter((phase) => !ordered.includes(phase))];
}
