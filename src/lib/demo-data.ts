import type { AppData, MediaEvent, Profile, Sop } from "@/lib/types";

// Keep only synthetic examples in public source. Real IAC records stay in the
// ignored .local directory or the configured Supabase project.
const profiles: Profile[] = [
  { id: "demo-admin", fullName: "Demo Administrator", email: "", role: "Administrator", accessRoles: ["Administrator"], username: "admin.test", jobTitle: "System administrator", active: true },
  { id: "demo-naqi", fullName: "Camera Operator", email: "", role: "PTZ Camera Operator", accessRoles: ["PTZ Camera Operator"], username: "camera.test", jobTitle: "Camera operator", active: true },
  { id: "demo-ameen", fullName: "Audio and Equipment Operator", email: "", role: "Audio Operator", accessRoles: ["Audio Operator", "Equipment Manager"], username: "audio.test", jobTitle: "Audio operator", active: true },
  { id: "demo-zayn", fullName: "Video Operator", email: "", role: "Video Operator", accessRoles: ["Video Operator"], username: "video.test", jobTitle: "Video operator", active: true },
  { id: "demo-moqset", fullName: "Photographer", email: "", role: "Photography", accessRoles: ["Photography"], username: "photo.test", jobTitle: "Photographer", active: true },
];

const events: MediaEvent[] = Array.from({ length: 13 }, (_, index) => {
  const date = new Date(Date.now() + (index - 1) * 86_400_000).toISOString().slice(0, 10);
  return {
    id: `event-demo-${String(index + 1).padStart(2, "0")}`,
    title: `Demo Program ${String(index + 1).padStart(2, "0")}`,
    category: ["General", "Happy", "Sad"][index % 3],
    date,
    startTime: "18:00",
    endTime: "20:00",
    setupTime: "16:30",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York",
    venue: "Demo room",
    leadId: "demo-admin",
    description: "Synthetic example schedule entry.",
    livestream: false,
    recording: false,
    photography: false,
    status: index < 3 ? "Completed" : "Published",
    publicInfo: "Demo event details.",
    privateNotes: "",
  };
});

const assets: AppData["assets"] = [
  { id: "asset-demo-camera", assetCode: "DEMO-CAM-01", name: "Demo Camera", category: "Camera", location: "Demo storage", condition: "Good", status: "Available", quantity: 1, model: "Sample model", serial: "", notes: "Synthetic example inventory item." },
  { id: "asset-demo-audio", assetCode: "DEMO-AUD-01", name: "Demo Audio Kit", category: "Audio", location: "Demo storage", condition: "Good", status: "Available", quantity: 1, model: "Sample model", serial: "", notes: "Synthetic example inventory item." },
  { id: "asset-demo-cable", assetCode: "DEMO-WIR-01", name: "Demo Cable Kit", category: "Wiring", location: "Demo storage", condition: "Good", status: "Available", quantity: 4, model: "Sample kit", serial: "", notes: "Synthetic example inventory item." },
  { id: "asset-demo-tripod", assetCode: "DEMO-SUP-01", name: "Demo Tripod", category: "Support", location: "Demo storage", condition: "Good", status: "Available", quantity: 1, model: "Sample model", serial: "", notes: "Synthetic example inventory item." },
];

const sops: Sop[] = [
  { id: "sop-demo-setup", title: "Demo setup procedure", category: "General", status: "Published", version: 1, summary: "Synthetic example procedure for previewing the SOP screen.", steps: ["Review the approved event plan.", "Check assigned equipment condition.", "Confirm the setup with the team lead."], reviewRequired: false, updatedAt: new Date().toISOString(), availableToAll: true },
];

export function createDemoData(): AppData {
  const assignments = events.flatMap((event) => profiles.map((person) => ({
    id: `assignment-${event.id}-${person.id}`,
    eventId: event.id,
    userId: person.id,
    roleName: person.jobTitle || person.role,
    arrivalTime: event.setupTime,
    instructions: "Synthetic example assignment.",
    response: "Pending" as const,
  })));
  return {
    profiles,
    events,
    assignments,
    crewAssignmentsInitialized: true,
    assets,
    loans: [],
    checklistItems: [],
    checklistTemplates: [],
    equipmentTemplates: [],
    sops,
    incidents: [],
    notifications: [],
    chatMessages: [],
    timeAlarms: [],
    content: [],
    audit: [],
  };
}

export function demoRoleUsers() {
  return profiles.map(({ id, fullName, role }) => ({ id, fullName, role }));
}

export function publicEvent(event: MediaEvent) {
  return { ...event, privateNotes: "" };
}
