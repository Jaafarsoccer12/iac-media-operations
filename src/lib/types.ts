export type AppRole = "Administrator" | "Director" | "Videographer" | "Video Switcher Operator" | "Camera Operator" | "PTZ Camera Operator" | "Audio Operator" | "Equipment Manager" | "Video Operator" | "Photography";
export type EventStatus = "Planning" | "Published" | "Completed" | "Cancelled";

export type Profile = { id: string; fullName: string; email: string; role: AppRole; accessRoles?: AppRole[]; qualification?: string; jobTitle?: string; active?: boolean; username?: string; avatarUrl?: string };
export type MediaEvent = {
  id: string; title: string; category: string; date: string; startTime: string; endTime: string;
  setupTime: string; timeZone: string; venue: string; leadId: string; description: string; livestream: boolean;
  recording: boolean; photography: boolean; status: EventStatus; publicInfo: string; privateNotes: string; programPhase?: string;
};
export type Assignment = {
  id: string; eventId: string; userId: string; roleName: string; arrivalTime?: string;
  instructions: string; response: "Pending" | "Accepted" | "Declined"; backupUserId?: string; serviceHistoryHidden?: boolean;
};
export type Asset = {
  id: string; assetCode: string; name: string; category: string; location: string;
  quantity?: number;
  condition: "Good" | "Needs service" | "Damaged"; status: "Available" | "Reserved" | "Checked out" | "Under maintenance" | "Damaged" | "Missing" | "Retired";
  model: string; serial: string; notes: string; currentCustodianId?: string;
};
export type EquipmentLoan = { id: string; assetId: string; borrowerId: string; issuedBy: string; issuedAt: string; dueDate?: string; quantity?: number; checkoutCondition: string; checkoutNotes?: string; returnAt?: string; returnedBy?: string; returnCondition?: string; returnNotes?: string };
export type EquipmentTemplateItem = { id: string; assetId: string; quantity: number };
export type EquipmentTemplate = { id: string; name: string; items: EquipmentTemplateItem[]; createdBy: string; createdAt: string; updatedAt: string };
export type ChecklistItem = { id: string; eventId: string; assignmentId?: string; userId: string; label: string; required: boolean; status: "Outstanding" | "Complete" | "Needs attention"; completedAt?: string; note?: string; verifiedBy?: string; clearedFromChecklist?: boolean; serviceHistoryHidden?: boolean; programPhase?: string };
export type ChecklistTemplateTask = { id: string; label: string; required: boolean };
export type ChecklistTemplate = { id: string; name: string; category?: string; tasks: ChecklistTemplateTask[]; createdBy: string; createdAt: string; updatedAt: string };
export type Sop = { id: string; title: string; category: string; status: "Draft" | "Published" | "Archived"; version: number; summary: string; steps: string[]; reviewRequired: boolean; updatedAt: string; assignedUserIds?: string[]; availableToAll?: boolean };
export type Incident = { id: string; eventId?: string; assetId?: string; reportedBy: string; category: string; severity: "Low" | "Medium" | "High" | "Critical"; description: string; immediateAction?: string; photos?: string[]; status: "Open" | "Acknowledged" | "In progress" | "Resolved" | "Closed"; createdAt: string; resolution?: string };
export type Notification = { id: string; userId: string; senderId?: string; title: string; detail: string; date: string; read: boolean; readAt?: string; href: string };
export type ChatMessage = { id: string; conversationType: "all" | "direct"; senderId: string; recipientId?: string; body: string; createdAt: string };
export type TimeAlarm = { id: string; userId: string; createdBy: string; fireAt: string; description: string; triggeredAt?: string; cancelledAt?: string; completedAt?: string };
export type ContentProject = { id: string; eventId: string; title: string; type: string; stage: string; assignedEditor: string; dueDate: string; reviewer: string; link?: string };
export type AuditEntry = { id: string; actorId: string; action: string; target: string; targetId: string; createdAt: string };
export type AppData = { profiles: Profile[]; events: MediaEvent[]; assignments: Assignment[]; assets: Asset[]; loans: EquipmentLoan[]; checklistItems: ChecklistItem[]; checklistTemplates: ChecklistTemplate[]; equipmentTemplates: EquipmentTemplate[]; sops: Sop[]; incidents: Incident[]; notifications: Notification[]; chatMessages?: ChatMessage[]; timeAlarms: TimeAlarm[]; content: ContentProject[]; audit: AuditEntry[]; categories?: { equipment: string[]; sops: string[]; incidents: string[]; checklists: string[]; events: string[] }; crewAssignmentsInitialized?: boolean };

export type SessionContext = { user: Profile; mode: "demo" | "supabase"; capabilities: string[] };
