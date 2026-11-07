export const STAFF_ROLES = ["Administrator", "Director"];

const CAPABILITIES = {
  Administrator: ["manage_system", "manage_events", "manage_team", "manage_equipment", "manage_equipment_inventory", "view_equipment", "manage_sops", "manage_content", "resolve_incidents", "view_reports", "view_team", "update_content", "view_sops", "manage_checklists", "report_incidents", "complete_checklists", "view_public_events", "view_notifications"],
  Director: ["manage_system", "manage_events", "manage_team", "manage_equipment", "view_equipment", "manage_sops", "manage_content", "resolve_incidents", "view_reports", "view_team", "update_content", "view_sops", "manage_checklists", "report_incidents", "complete_checklists", "view_public_events", "view_notifications"],
  Videographer: ["view_equipment", "complete_checklists", "report_incidents", "update_content", "view_sops", "view_notifications"],
  "Video Switcher Operator": ["view_equipment", "complete_checklists", "report_incidents", "update_content", "view_sops", "view_notifications"],
  "Camera Operator": ["view_equipment", "complete_checklists", "report_incidents", "update_content", "view_sops", "view_notifications"],
  "PTZ Camera Operator": ["view_equipment", "complete_checklists", "report_incidents", "update_content", "view_sops", "view_notifications"],
  "Audio Operator": ["view_equipment", "complete_checklists", "report_incidents", "update_content", "view_sops", "view_notifications"],
  "Equipment Manager": ["manage_equipment", "manage_equipment_inventory", "view_equipment", "report_incidents", "view_notifications"],
  "Video Operator": ["view_equipment", "complete_checklists", "report_incidents", "update_content", "view_sops", "view_notifications"],
  Photography: ["view_equipment", "complete_checklists", "report_incidents", "update_content", "view_sops", "view_notifications"],
};

export function can(role, capability) {
  const roles = Array.isArray(role) ? role : [role];
  return roles.some((item) => (CAPABILITIES[item] ?? []).includes(capability));
}

export function isStaff(role) {
  const roles = Array.isArray(role) ? role : [role];
  return roles.some((item) => STAFF_ROLES.includes(item));
}

export function canIssueEquipment(asset, loans) {
  if (!asset || asset.condition !== "Good" || !["Available", "Checked out"].includes(asset.status)) return false;
  const total = Math.max(1, Number(asset.quantity) || 1);
  const borrowed = loans.filter((loan) => loan.assetId === asset.id && !loan.returnAt)
    .reduce((sum, loan) => sum + Math.max(1, Number(loan.quantity) || 1), 0);
  return borrowed < total;
}

export function eventReadiness(event, checklistItems) {
  const checks = checklistItems.filter((item) => item.eventId === event.id && item.required);
  const failed = checks.filter((item) => item.status === "Needs attention");
  const pending = checks.filter((item) => item.status !== "Complete");
  if (failed.length) return { label: "Needs attention", tone: "danger", reasons: failed.map((item) => item.label) };
  if (checks.length === 0 || pending.length > 0) {
    const reasons = [];
    if (checks.length === 0) reasons.push("No checklist items assigned");
    if (pending.length) reasons.push(`${pending.length} required check${pending.length === 1 ? "" : "s"} outstanding`);
    return { label: "In progress", tone: "warning", reasons };
  }
  return { label: "Ready", tone: "success", reasons: [] };
}

export function roleChecklist(role) {
  const items = {
    Director: ["Confirm the production plan", "Review event readiness", "Coordinate with the media team"],
    Videographer: ["Inspect the camera, lens, tripod, and cables", "Check framing, focus, and exposure", "Confirm the recording is running"],
    "Video Switcher Operator": ["Verify video inputs and signal", "Confirm program and preview outputs", "Check transitions and audio follow"],
    "Camera Operator": ["Inspect camera, lens, tripod, and cables", "Check framing, focus, and exposure", "Confirm recording or tally status with the director"],
    "PTZ Camera Operator": ["Confirm camera control and presets", "Verify framing with the director", "Check movement and communication"],
    "Audio Operator": ["Inspect microphones and batteries", "Verify routing and monitor levels", "Complete the audio line check"],
    "Video Operator": ["Verify the video signal", "Check the program output", "Confirm recording or stream status"],
    Photography: ["Check camera, lens, and batteries", "Confirm the photo coverage plan", "Transfer and verify the selected photos"],
  };
  return items[role] ?? ["Review event instructions", "Check assigned equipment", "Confirm readiness with team lead"];
}
