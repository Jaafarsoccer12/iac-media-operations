"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import NextImage from "next/image";
import {
  Activity, AlarmClock, AlertTriangle, ArrowDownToLine, ArrowRight, Bell, BookOpen, CalendarDays, Check,
  CheckCircle2, ChevronDown, ClipboardCheck, Clock3, FileText, GripHorizontal, HardDrive, Headphones, ImagePlus, LayoutDashboard,
  LogOut, Menu, MessageCircle, Moon, MoreVertical, Paperclip, Pencil, Plus, Radio, Reply, Search, Send, Settings2, ShieldCheck, Sparkles, Sun, Trash2, Users, Video, Wrench, X,
} from "lucide-react";
import { can, eventReadiness } from "@/lib/policy.mjs";
import { CHECKLIST_PROGRAM_PHASES, normalizeChecklistProgramPhase, orderChecklistProgramPhases } from "@/lib/checklist-phases.mjs";
import type { AppData, AppRole, ChatAttachment, ChatMessage, ChecklistTemplateTask, EquipmentTemplateItem, MediaEvent, Profile, SessionContext, SopContentBlock } from "@/lib/types";
import { hasAccessRole, hasManagerAccess } from "@/lib/roles";
import { fileAsDataUrl, formatFileSize, prepareChatFile } from "@/lib/browser-media";

type PageKey = "dashboard" | "time" | "chat" | "events" | "equipment" | "checklists" | "sops" | "incidents" | "reports" | "notifications" | "settings";
type AppPayload = { context: SessionContext; data: AppData };
type TeamAccount = { id: string; fullName: string; email: string; username: string; jobTitle: string; avatarUrl?: string; role: AppRole; accessRoles?: AppRole[]; active: boolean; qualification?: string; createdAt?: string; lastSignInAt: string | null };
type ModalState = { type: string; id?: string; member?: TeamAccount; username?: string; secret?: string } | null;

const accessRoles: AppRole[] = ["Administrator", "Director", "Videographer", "Video Switcher Operator", "Camera Operator", "PTZ Camera Operator", "Audio Operator", "Equipment Manager", "Video Operator", "Photography"];

const productionPositions = ["Camera Operator", "PTZ Camera Operator", "Video Operator", "Audio Operator", "Equipment Manager", "Photography", "Video Switcher Operator", "Videography", "Director"];
const categoryDefaults = { events: ["Happy", "Sad", "General"], equipment: ["Camera", "Audio", "Wiring", "Video", "Lighting", "Other"], incidents: ["Equipment damage", "Audio issue", "Video issue", "Stream interruption", "Recording issue", "Network", "Other"], checklists: [...CHECKLIST_PROGRAM_PHASES], sops: ["Production", "Audio", "Video", "Livestream & recording", "Equipment", "Operations", "Safety"], productionRoles: [...productionPositions] };

function selectedProductionRoles(value?: string, roles: string[] = productionPositions) {
  const selected = new Set((value ?? "").split(/\s*[·,;]\s*/).map((role) => role.trim() === "Videographer" ? "Videography" : role.trim()).filter(Boolean));
  return roles.filter((role) => selected.has(role));
}

const teamInvitePresets: { id: string; fullName: string; username: string; productionRoles: string[]; accessRoles: AppRole[] }[] = [
  { id: "director", fullName: "Director", username: "director", productionRoles: ["Director"], accessRoles: ["Director"] },
  { id: "ptz-operator", fullName: "PTZ Camera Operator", username: "ptz.operator", productionRoles: ["PTZ Camera Operator"], accessRoles: ["PTZ Camera Operator"] },
  { id: "equipment-manager", fullName: "Equipment Manager", username: "equipment.manager", productionRoles: ["Audio Operator"], accessRoles: ["Audio Operator", "Equipment Manager"] },
  { id: "video-operator", fullName: "Video Operator", username: "video.operator", productionRoles: ["Video Operator"], accessRoles: ["Video Operator"] },
  { id: "photographer", fullName: "Photographer", username: "photographer", productionRoles: ["Photography"], accessRoles: ["Photography"] },
];

const navItems: { key: PageKey; label: string; icon: typeof LayoutDashboard; needs?: string }[] = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "time", label: "Time", icon: AlarmClock, needs: "view_notifications" },
  { key: "chat", label: "Crew chat", icon: MessageCircle, needs: "view_notifications" },
  { key: "events", label: "Events & calendar", icon: CalendarDays },
  { key: "equipment", label: "Equipment", icon: HardDrive, needs: "view_equipment" },
  { key: "checklists", label: "Checklists", icon: CheckCircle2, needs: "complete_checklists" },
  { key: "sops", label: "SOP library", icon: BookOpen, needs: "view_sops" },
  { key: "incidents", label: "Incidents", icon: AlertTriangle, needs: "report_incidents" },
  { key: "reports", label: "Reports", icon: Activity, needs: "view_reports" },
  { key: "notifications", label: "Notifications", icon: Bell, needs: "view_notifications" },
  { key: "settings", label: "Settings", icon: Settings2, needs: "manage_system" },
];

const pageTitles: Record<PageKey, string> = {
  dashboard: "Dashboard", events: "Events & calendar", equipment: "Equipment & inventory",
  checklists: "Checklists", sops: "SOP library",
  incidents: "Incidents", reports: "Reports", notifications: "Notifications", settings: "Administration", time: "Time & alarms", chat: "Crew chat",
};

const emptyData: AppData = { profiles: [], events: [], assignments: [], assets: [], loans: [], checklistItems: [], checklistTemplates: [], equipmentTemplates: [], sops: [], incidents: [], notifications: [], timeAlarms: [], content: [], audit: [] };
const sharedTimeZone = "America/New_York";
const themeStorageKey = "iac-media-operations-theme";
const themeChangeEvent = "iac-media-operations-theme-change";

function getStoredDarkMode() {
  if (typeof window === "undefined") return false;
  try { return window.localStorage.getItem(themeStorageKey) === "dark"; }
  catch { return false; }
}
function subscribeToTheme(onChange: () => void) {
  window.addEventListener(themeChangeEvent, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(themeChangeEvent, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function initials(name: string) { return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase(); }
function displayDate(value: string) { return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }); }
function localCalendarDate() { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function displayTime(value: string) { const normalized = /^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value) ? value.slice(0, 5) : ""; if (!normalized) return "To be confirmed"; const [hour, minute] = normalized.split(":").map(Number); return new Date(2000, 0, 1, hour, minute).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); }
function eventTimeRange(event: MediaEvent) { return event.startTime && event.endTime ? `${displayTime(event.startTime)}–${displayTime(event.endTime)}` : "Time to be confirmed"; }
function normalizeEventTimeInput(value: unknown) {
  if (typeof value !== "string") return value;
  const match = /^(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value.trim());
  return match ? match[1] : value;
}

function phaseOptions(data: AppData) { return orderChecklistProgramPhases(data.categories?.checklists); }
function ProgramPhaseButtons({ data, event, onSelect }: { data: AppData; event: MediaEvent; onSelect: (phase: string) => void }) {
  const phases = phaseOptions(data);
  const current = normalizeChecklistProgramPhase(event.programPhase) ?? phases[0];
  return <div className="program-phase-picker" role="group" aria-label={`Set current program phase for ${event.title}`}>
    {phases.map((phase) => <button type="button" key={phase} className={current === phase ? "selected" : ""} aria-pressed={current === phase} onClick={() => onSelect(phase)}>{phase}</button>)}
  </div>;
}
function isRequiredPhaseOverdue(item: AppData["checklistItems"][number], event: MediaEvent, phases: string[]) {
  if (!item.required || item.status === "Complete") return false;
  const itemPhase = item.programPhase ?? phases[0];
  const currentPhase = event.programPhase ?? phases[0];
  const itemIndex = phases.indexOf(itemPhase);
  const currentIndex = phases.indexOf(currentPhase);
  return itemIndex >= 0 && currentIndex > itemIndex;
}
function formatStamp(value: string) { return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
function centerTimeParts(epochMs: number) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: sharedTimeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hourCycle: "h23" }).formatToParts(new Date(epochMs)).map((part) => [part.type, part.value]));
  return { display: `${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}`, date: new Intl.DateTimeFormat("en-US", { timeZone: sharedTimeZone, weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(epochMs)), inputDate: new Intl.DateTimeFormat("en-CA", { timeZone: sharedTimeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(epochMs)) };
}
function formatAlarmCountdown(fireAt: string, nowMs: number) {
  const totalSeconds = Math.ceil(Math.max(0, Date.parse(fireAt) - nowMs) / 1000);
  if (!totalSeconds) return "Due now";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours ? `${hours}h ${minutes}m ${seconds}s remaining` : `${minutes}m ${seconds}s remaining`;
}
function alarmCountdownHue(remainingMs: number) {
  if (remainingMs > 5 * 60_000) return 215;
  if (remainingMs <= 60_000) return 4;
  return Math.round(4 + 27 * ((remainingMs - 60_000) / (4 * 60_000)));
}
async function showPhoneAlarmNotification(alarmId: string, description: string) {
  if (typeof window === "undefined" || !("Notification" in window) || window.Notification.permission !== "granted" || !("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const options = {
      body: "Your task is due. Complete it in IAC Media Operations to stop reminders.",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: `iac-time-alarm-${alarmId}`,
      renotify: true,
      requireInteraction: true,
      vibrate: [500, 250, 500, 250, 800],
      actions: [{ action: "complete", title: "Task completed" }],
      data: { alarmId },
    } as NotificationOptions;
    await registration.showNotification(`Alarm: ${description}`, options);
  } catch { /* In-app reminders remain available when system notifications are unavailable. */ }
}
function isStaff(role: AppRole) { return ["Administrator", "Director"].includes(role); }
function StatusPill({ children, tone = "neutral" }: { children: ReactNode; tone?: string }) { return <span className={`status-pill tone-${tone.toLowerCase().replaceAll(" ", "-")}`}>{children}</span>; }
function EmptyState({ icon: Icon = FileText, title, detail, action }: { icon?: typeof FileText; title: string; detail: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Icon size={19} /></span><strong>{title}</strong><p>{detail}</p>{action}</div>;
}
function ProfileAvatar({ name, src, className }: { name: string; src?: string; className: string }) {
  return <span role="img" aria-label={`${name} profile photo`} className={className} style={src ? { backgroundImage: `url(${JSON.stringify(src)})` } : undefined}>{src ? null : initials(name)}</span>;
}
function BrandMark({ large = false }: { large?: boolean }) {
  return <span className={`brand-mark ${large ? "large" : ""}`} role="img" aria-label="Imam Ali Center logo" style={{ backgroundImage: "url('/iac-media-logo.png')", backgroundPosition: "center", backgroundSize: "contain" }} />;
}
function ProfilePhotoField({ name, personName, initialValue = "" }: { name: string; personName: string; initialValue?: string }) {
  const [photo, setPhoto] = useState(initialValue);
  const [cropSource, setCropSource] = useState<{ url: string; width: number; height: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(50);
  const [panY, setPanY] = useState(50);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => () => { if (cropSource) URL.revokeObjectURL(cropSource.url); }, [cropSource]);
  const selectPhoto = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 12 * 1024 * 1024) {
      setError("Choose an image smaller than 12 MB.");
      event.currentTarget.value = "";
      return;
    }
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) {
        URL.revokeObjectURL(url);
        setError("This photo could not be opened. Choose a JPG, PNG, or WebP image.");
        return;
      }
      setCropSource({ url, width: image.naturalWidth, height: image.naturalHeight });
      setZoom(1);
      setPanX(50);
      setPanY(50);
      setError("");
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      setError("This photo format could not be opened. Choose a JPG, PNG, or WebP image.");
    };
    image.src = url;
    event.currentTarget.value = "";
  };
  const applyCrop = async () => {
    if (!cropSource) return;
    setProcessing(true);
    setError("");
    try {
      const image = new Image();
      image.src = cropSource.url;
      await new Promise<void>((resolve, reject) => {
        if (image.complete && image.naturalWidth) resolve();
        else { image.onload = () => resolve(); image.onerror = () => reject(new Error("This photo could not be opened.")); }
      });
      const cropSize = Math.min(cropSource.width, cropSource.height) / zoom;
      const cropLeft = (cropSource.width - cropSize) * panX / 100;
      const cropTop = (cropSource.height - cropSize) * panY / 100;
      let blob: Blob | null = null;
      for (const size of [512, 448, 384, 320, 256]) {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("This photo could not be prepared. Choose another image.");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, size, size);
        context.drawImage(image, cropLeft, cropTop, cropSize, cropSize, 0, 0, size, size);
        for (const quality of [0.82, 0.72, 0.62]) {
          blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
          if (blob && blob.size <= 260_000) break;
        }
        if (blob && blob.size <= 260_000) break;
      }
      if (!blob || blob.size > 260_000) throw new Error("This photo is too detailed to save. Try a smaller image.");
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("This photo could not be read."));
        reader.onerror = () => reject(new Error("This photo could not be read."));
        reader.readAsDataURL(blob);
      });
      setPhoto(dataUrl);
      setCropSource(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "This photo could not be processed. Choose another image.");
    } finally {
      setProcessing(false);
    }
  };
  const cropSize = cropSource ? Math.min(cropSource.width, cropSource.height) / zoom : 1;
  const cropImageStyle = cropSource ? {
    width: String(cropSource.width / cropSize * 100) + "%",
    height: String(cropSource.height / cropSize * 100) + "%",
    left: String(-(cropSource.width - cropSize) * panX / 100 / cropSize * 100) + "%",
    top: String(-(cropSource.height - cropSize) * panY / 100 / cropSize * 100) + "%",
    backgroundImage: "url(" + JSON.stringify(cropSource.url) + ")",
    backgroundSize: "100% 100%",
    backgroundRepeat: "no-repeat",
  } : undefined;
  return <><div className="profile-photo-editor"><ProfileAvatar name={personName} src={photo || undefined} className="avatar profile-photo-preview" /><div className="profile-photo-tools"><label className="form-field profile-photo-picker"><span>Profile picture</span><input type="file" accept="image/*" onChange={selectPhoto} /><small>Choose a photo from this device’s files or photo library.</small></label>{photo && <button type="button" className="text-button profile-photo-remove" onClick={() => { setPhoto(""); setError(""); }}>Remove photo</button>}{error && <small role="alert" className="profile-photo-error">{error}</small>}</div><input type="hidden" name={name} value={photo} /></div>
    {cropSource && <section className="profile-photo-crop" aria-label="Crop profile picture"><div className="photo-crop-preview-block"><div className="photo-crop-stage"><span className="photo-crop-image" role="img" aria-label="Selected photo crop preview" style={cropImageStyle} /></div><div><strong>Circle preview</strong><small>This is how your profile picture will appear.</small></div></div><div className="photo-crop-controls"><label>Zoom <input type="range" min="1" max="3" step="0.01" value={zoom} onChange={(event) => setZoom(Number(event.currentTarget.value))} /></label><label>Left / right <input type="range" min="0" max="100" value={panX} onChange={(event) => setPanX(Number(event.currentTarget.value))} /></label><label>Up / down <input type="range" min="0" max="100" value={panY} onChange={(event) => setPanY(Number(event.currentTarget.value))} /></label></div><div className="photo-crop-actions"><button type="button" className="button button-quiet" onClick={() => setCropSource(null)} disabled={processing}>Cancel</button><button type="button" className="button button-primary" onClick={() => void applyCrop()} disabled={processing}>{processing ? "Preparing photo…" : "Next"}<ArrowRight size={15} /></button></div></section>}
  </>;
}

export function OperationsApp() {
  const [authSettings, setAuthSettings] = useState<{ demoAvailable: boolean; supabaseConfigured: boolean } | null>(null);
  const [payload, setPayload] = useState<AppPayload | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [alarmDisplayNow, setAlarmDisplayNow] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState<PageKey>("dashboard");
  const [mobileNav, setMobileNav] = useState(false);
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<ModalState>(null);
  const [teamRefresh, setTeamRefresh] = useState(0);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [notificationAlert, setNotificationAlert] = useState<{ id: string; title: string; detail: string; alarmId?: string } | null>(null);
  const [alarmWidgetPosition, setAlarmWidgetPosition] = useState<{ left: number; top: number } | null>(null);
  const alarmDrag = useRef<{ pointerId: number; startX: number; startY: number; left: number; top: number; moved: boolean } | null>(null);
  const alarmClickSuppressed = useRef(false);
  const [chatUnread, setChatUnread] = useState<{ userId: string | null; count: number }>({ userId: null, count: 0 });
  const [animatedNavItems, setAnimatedNavItems] = useState<PageKey[]>([]);
  const [loginError, setLoginError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const seenNotificationIds = useRef<Set<string> | null>(null);
  const notificationUserId = useRef<string | null>(null);
  const alarmReminderAt = useRef(new Map<string, number>());
  const notificationAudio = useRef<AudioContext | null>(null);
  const notificationSoundPending = useRef(false);
  const priorNavCounts = useRef<{ userId: string; chat: number; checklists: number; notifications: number } | null>(null);
  const navAnimationTimer = useRef<number | null>(null);
  const darkMode = useSyncExternalStore(subscribeToTheme, getStoredDarkMode, () => false);

  useEffect(() => {
    const target = new URLSearchParams(window.location.search).get("open");
    if (target === "chat" || target === "time") {
      setPage(target);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const saved = window.localStorage.getItem("iac-alarm-widget-position");
        if (!saved) return;
        const position = JSON.parse(saved) as { left?: number; top?: number };
        if (Number.isFinite(position.left) && Number.isFinite(position.top)) setAlarmWidgetPosition({ left: Math.max(8, position.left!), top: Math.max(8, position.top!) });
      } catch { /* Keep the default corner position when browser storage is unavailable. */ }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (!alarmWidgetPosition) return;
    const constrain = () => {
      const widget = document.querySelector<HTMLButtonElement>(".alarm-countdown-widget");
      if (!widget) return;
      const rect = widget.getBoundingClientRect();
      const bottomClearance = page === "chat" ? 184 : 8;
      const position = {
        left: Math.min(Math.max(8, alarmWidgetPosition.left), Math.max(8, window.innerWidth - rect.width - 8)),
        top: Math.min(Math.max(8, alarmWidgetPosition.top), Math.max(8, window.innerHeight - rect.height - bottomClearance)),
      };
      if (position.left !== alarmWidgetPosition.left || position.top !== alarmWidgetPosition.top) {
        setAlarmWidgetPosition(position);
        try { window.localStorage.setItem("iac-alarm-widget-position", JSON.stringify(position)); } catch { /* Position remains constrained for this session. */ }
      }
    };
    const frame = window.requestAnimationFrame(constrain);
    window.addEventListener("resize", constrain);
    return () => { window.cancelAnimationFrame(frame); window.removeEventListener("resize", constrain); };
  }, [alarmWidgetPosition, payload?.data.timeAlarms, page]);
  const startAlarmWidgetDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    alarmDrag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveAlarmWidget = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = alarmDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX; const dy = event.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
    if (!drag.moved) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const left = Math.min(Math.max(8, drag.left + dx), Math.max(8, window.innerWidth - rect.width - 8));
    const bottomClearance = page === "chat" ? 184 : 8;
    const top = Math.min(Math.max(8, drag.top + dy), Math.max(8, window.innerHeight - rect.height - bottomClearance));
    setAlarmWidgetPosition({ left, top });
  };
  const endAlarmWidgetDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = alarmDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    alarmDrag.current = null;
    if (drag.moved) {
      alarmClickSuppressed.current = true;
      const rect = event.currentTarget.getBoundingClientRect();
      const dx = event.clientX - drag.startX; const dy = event.clientY - drag.startY;
      const position = {
        left: Math.min(Math.max(8, drag.left + dx), Math.max(8, window.innerWidth - rect.width - 8)),
        top: Math.min(Math.max(8, drag.top + dy), Math.max(8, window.innerHeight - rect.height - (page === "chat" ? 184 : 8))),
      };
      setAlarmWidgetPosition(position);
      try { window.localStorage.setItem("iac-alarm-widget-position", JSON.stringify(position)); } catch { /* Position remains movable for this session. */ }
      window.setTimeout(() => { alarmClickSuppressed.current = false; }, 0);
    }
  };

  useEffect(() => {
    const updateClock = () => setAlarmDisplayNow(Date.now());
    updateClock();
    const timer = window.setInterval(updateClock, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const playNotificationTone = useCallback((audio: AudioContext) => {
    const startAt = audio.currentTime;
    for (const [frequency, offset] of [[880, 0], [1175, 0.14]] as const) {
      const oscillator = audio.createOscillator();
      const volume = audio.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      volume.gain.setValueAtTime(0.0001, startAt + offset);
      volume.gain.exponentialRampToValueAtTime(0.18, startAt + offset + 0.025);
      volume.gain.exponentialRampToValueAtTime(0.0001, startAt + offset + 0.28);
      oscillator.connect(volume);
      volume.connect(audio.destination);
      oscillator.start(startAt + offset);
      oscillator.stop(startAt + offset + 0.29);
    }
  }, []);

  const primeNotificationAudio = useCallback(() => {
    if (typeof window === "undefined" || !window.AudioContext) return;
    const audio = notificationAudio.current ??= new window.AudioContext();
    const resume = audio.state === "suspended" ? audio.resume() : Promise.resolve();
    void resume.then(() => {
      if (audio.state === "running" && notificationSoundPending.current) {
        notificationSoundPending.current = false;
        playNotificationTone(audio);
      }
    }).catch(() => undefined);
  }, [playNotificationTone]);
  const ringNotification = useCallback(() => {
    const audio = notificationAudio.current;
    if (!audio || audio.state !== "running") { notificationSoundPending.current = true; return; }
    playNotificationTone(audio);
  }, [playNotificationTone]);

  useEffect(() => {
    const unlockAudio = () => primeNotificationAudio();
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    window.addEventListener("keydown", unlockAudio, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
      void notificationAudio.current?.close().catch(() => undefined);
      notificationAudio.current = null;
    };
  }, [primeNotificationAudio]);

  const load = useCallback(async (showLoginFailure = false) => {
    try {
      const settings = await fetch("/api/auth", { cache: "no-store" }).then((r) => r.json());
      setAuthSettings(settings);
      await fetch("/api/operations", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "process_due_alarms", payload: {} }) }).catch(() => undefined);
      const response = await fetch("/api/bootstrap", { cache: "no-store" });
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { error?: string } | null;
        setPayload(null); seenNotificationIds.current = null; notificationUserId.current = null;
        if (showLoginFailure) setLoginError(failure?.error ?? `Your sign-in was accepted, but the dashboard could not load (HTTP ${response.status}). Please try again.`);
        return false;
      }
      const body = await response.json();
      const nextPayload = body as AppPayload;
      setCurrentTime(Date.now());
      const nextUserId = nextPayload.context.user.id;
      const managerView = hasManagerAccess(nextPayload.context.user.accessRoles, nextPayload.context.user.role);
      const notificationCutoff = Date.now() - 24 * 60 * 60 * 1000;
      const nextNotifications = nextPayload.data.notifications.filter((item) => item.userId === nextUserId && (!managerView || Date.parse(item.date) >= notificationCutoff));
      if (notificationUserId.current !== nextUserId || !seenNotificationIds.current) {
        try {
          const saved = JSON.parse(window.localStorage.getItem(`iac-notifications-seen:${nextUserId}`) ?? "[]") as unknown;
          seenNotificationIds.current = new Set(Array.isArray(saved) ? saved.filter((value): value is string => typeof value === "string") : []);
        } catch { seenNotificationIds.current = new Set(); }
      }
      const seen = seenNotificationIds.current ??= new Set();
      const missed = nextNotifications.filter((item) => !item.read && !seen.has(item.id) && !item.href.startsWith("time-alarm:")).sort((a, b) => b.date.localeCompare(a.date));
      const arrival = missed[0];
      if (arrival) {
        setNotificationAlert({ id: arrival.id, title: arrival.title, detail: arrival.detail });
        ringNotification();
      }
      nextNotifications.forEach((item) => seen.add(item.id));
      if (seen.size > 500) seenNotificationIds.current = new Set([...seen].slice(-500));
      try { window.localStorage.setItem(`iac-notifications-seen:${nextUserId}`, JSON.stringify([...(seenNotificationIds.current ?? seen)])); } catch { /* Notifications still work when browser storage is unavailable. */ }
      notificationUserId.current = nextUserId;
      setPayload(nextPayload);
      return true;
    } catch (failure) {
      const detail = failure instanceof Error ? failure.message : "Could not connect to the application server.";
      if (showLoginFailure) setLoginError(`Sign-in could not finish loading the app: ${detail}`);
      else setNotice({ text: "Could not connect to the application server.", error: true });
      return false;
    } finally { setLoading(false); }
  }, [ringNotification]);
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? "dark" : "light";
  }, [darkMode]);
  const activeUserId = payload?.context.user.id;
  useEffect(() => {
    if (!activeUserId) return;
    const storageKey = `iac-chat-last-seen:${activeUserId}`;
    let lastSeen = 0;
    try {
      const saved = Number(window.localStorage.getItem(storageKey));
      lastSeen = Number.isFinite(saved) && saved > 0 ? saved : Date.now();
      window.localStorage.setItem(storageKey, String(lastSeen));
    } catch { lastSeen = Date.now(); }

    const markChatSeen = () => {
      lastSeen = Date.now();
      try { window.localStorage.setItem(storageKey, String(lastSeen)); } catch { /* Keep the in-memory timestamp for this session. */ }
      setChatUnread({ userId: activeUserId, count: 0 });
    };
    if (page === "chat") markChatSeen();
    let checkingMessages = false;
    const refreshUnreadCount = async () => {
      if (page === "chat" || document.visibilityState !== "visible" || checkingMessages) return;
      checkingMessages = true;
      try {
        const params = new URLSearchParams({ summary: "1", since: new Date(lastSeen).toISOString() });
        const response = await fetch(`/api/chat?${params.toString()}`, { cache: "no-store" });
        if (!response.ok) return;
        const body = await response.json() as { count?: number };
        setChatUnread({ userId: activeUserId, count: Math.max(0, Number(body.count) || 0) });
      } catch { /* The next poll will retry when the server is available. */ }
      finally { checkingMessages = false; }
    };
    void refreshUnreadCount();
    const timer = window.setInterval(() => {
      if (page === "chat") markChatSeen();
      else void refreshUnreadCount();
    }, 5_000);
    const onVisibility = () => { if (document.visibilityState === "visible") void refreshUnreadCount(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [activeUserId, page]);

  useEffect(() => () => { if (navAnimationTimer.current !== null) window.clearTimeout(navAnimationTimer.current); }, []);

  useEffect(() => {
    if (!activeUserId) return;
    let checkingAlarm = false;
    const checkDueAlarms = async () => {
      if (checkingAlarm) return;
      checkingAlarm = true;
      try {
        const response = await fetch("/api/operations", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "process_due_alarms", payload: {} }) });
        if (!response.ok) return;
        const result = await response.json() as { triggered?: number };
        if ((result.triggered ?? 0) > 0) await load();
      } catch { /* The next visible check will retry if the network is briefly unavailable. */ }
      finally { checkingAlarm = false; }
    };
    const refreshWhenVisible = () => { if (document.visibilityState === "visible") { void load(); void checkDueAlarms(); } };
    const timer = window.setInterval(() => void checkDueAlarms(), 2_000);
    const refreshTimer = window.setInterval(refreshWhenVisible, 15_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(refreshTimer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [activeUserId, load]);

  useEffect(() => {
    if (!activeUserId || !payload) return;
    const remindForPendingAlarms = () => {
      const nowMs = Date.now();
      for (const alarm of payload.data.timeAlarms) {
        if (alarm.userId !== activeUserId || !alarm.triggeredAt || alarm.completedAt || alarm.cancelledAt) continue;
        if (!payload.data.notifications.some((item) => item.userId === activeUserId && item.href === `time-alarm:${alarm.id}`)) continue;
        const storageKey = `iac-alarm-reminder:${activeUserId}:${alarm.id}`;
        let lastReminderAt = alarmReminderAt.current.get(alarm.id) ?? 0;
        if (!lastReminderAt) {
          try { lastReminderAt = Number(window.localStorage.getItem(storageKey) ?? 0) || 0; } catch { /* Session memory is enough when storage is unavailable. */ }
        }
        if (nowMs - lastReminderAt < 60_000) continue;
        alarmReminderAt.current.set(alarm.id, nowMs);
        try { window.localStorage.setItem(storageKey, String(nowMs)); } catch { /* Continue reminding during this session. */ }
        setNotificationAlert({ id: `${alarm.id}-${nowMs}`, title: "Alarm is due", detail: alarm.description, alarmId: alarm.id });
        ringNotification();
        if ("vibrate" in navigator) navigator.vibrate([500, 250, 500, 250, 800]);
        void showPhoneAlarmNotification(alarm.id, alarm.description);
      }
    };
    remindForPendingAlarms();
    const timer = window.setInterval(remindForPendingAlarms, 1_000);
    return () => window.clearInterval(timer);
  }, [activeUserId, payload, ringNotification]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onServiceWorkerMessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type === "alarm-completed") void load();
      if (event.data?.type === "open-chat") setPage("chat");
      if (event.data?.type === "open-time") setPage("time");
    };
    navigator.serviceWorker.addEventListener("message", onServiceWorkerMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onServiceWorkerMessage);
  }, [load]);

  const setDarkMode = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    const selected = typeof next === "function" ? next(getStoredDarkMode()) : next;
    const selectedTheme = selected ? "dark" : "light";
    try { window.localStorage.setItem(themeStorageKey, selectedTheme); } catch { /* Keep the current-tab preference even if storage is unavailable. */ }
    document.documentElement.dataset.theme = selectedTheme;
    window.dispatchEvent(new Event(themeChangeEvent));
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4200);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!notificationAlert || notificationAlert.alarmId) return;
    const timer = window.setTimeout(() => setNotificationAlert(null), 6500);
    return () => window.clearTimeout(timer);
  }, [notificationAlert]);
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>(".global-search input")?.focus();
      } else if (event.key === "Escape" && document.activeElement?.matches(".global-search input")) {
        setSearch("");
        (document.activeElement as HTMLElement).blur();
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);

  const signInDemoAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setLoginBusy(true); setLoginError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "demo_login", username: form.get("username"), password: form.get("password") }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not sign in.");
      await load(true);
    } catch (error) { setLoginError(error instanceof Error ? error.message : "Could not sign in."); }
    finally { setLoginBusy(false); }
  };

  const signInSupabase = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setLoginBusy(true); setLoginError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "login", identifier: form.get("identifier"), password: form.get("password") }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not sign in.");
      await load(true);
    } catch (error) { setLoginError(error instanceof Error ? error.message : "Could not sign in."); }
    finally { setLoginBusy(false); }
  };

  const run = useCallback(async (action: string, payload: Record<string, unknown> = {}) => {
    const endpoint = action.startsWith("team_") ? "/api/admin/team" : action.startsWith("profile_") ? "/api/profile" : "/api/operations";
    const apiAction = action === "profile_update" ? "update_profile" : action === "profile_change_password" ? "change_password" : action;
    const body = endpoint === "/api/profile" ? { action: apiAction, ...payload } : { action: apiAction, payload };
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Action failed.");
    return result;
  }, []);

  const handleForm = (action: string) => async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const values = Object.fromEntries(formData.entries()) as Record<string, unknown>;
    if (action === "team_invite" || action === "team_update_member" || action === "team_update_roles") {
      values.accessRoles = formData.getAll("accessRoles");
      if (action !== "team_update_roles") values.jobTitle = formData.getAll("productionRoles").filter((value): value is string => typeof value === "string" && (payload?.data.categories?.productionRoles ?? productionPositions).includes(value)).join(" · ");
    }
        if (action === "create_event" || action === "update_event") {
      values.assignedUserIds = formData.getAll("assignedUserIds");
      for (const key of ["startTime", "endTime", "setupTime"]) values[key] = normalizeEventTimeInput(values[key]);
    }
    if (action === "create_checklist_template" || action === "update_checklist_template" || action === "quick_assign_checklist") {
      try { values.tasks = JSON.parse(String(formData.get("tasks") ?? "[]")); }
      catch { setNotice({ text: "Check the task list and try again.", error: true }); return; }
    }
    if (["create_equipment_template", "update_equipment_template", "quick_assign_equipment"].includes(action)) {
      try { values.items = JSON.parse(String(formData.get("items") ?? "[]")); }
      catch { setNotice({ text: "Check the equipment list and try again.", error: true }); return; }
    }
    if (["report_incident", "update_incident", "complete_own_incident"].includes(action)) values.photos = formData.getAll("photos").filter((value): value is string => typeof value === "string" && value.startsWith("data:image/"));
    if (action === "create_sop" || action === "update_sop_audience" || action === "save_rich_sop") values.assignedUserIds = formData.getAll("assignedUserIds");
    if (action === "save_rich_sop") {
      try { values.content = JSON.parse(String(formData.get("richContent") ?? "[]")); }
      catch { setNotice({ text: "Review the procedure content and try again.", error: true }); return; }
      if (modal?.type === "edit-sop") values.sopId = modal.id;
    }
    if (action === "create_event") values.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    if (action === "update_event") values.timeZone = data.events.find((item) => item.id === String(values.eventId))?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    if ((action === "create_event" || action === "update_event") && values.leadId === "none") values.leadId = "";
    if (action === "issue_equipment") values.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    if (action === "quick_assign_equipment") values.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    for (const key of ["livestream", "recording", "photography", "reviewConfirmed", "active", "availableToAll"]) values[key] = form.querySelector<HTMLInputElement>(`[name="${key}"]`)?.checked ?? false;
    if (action === "create_checklist_item" || action === "update_checklist_item") values.required = form.querySelector<HTMLInputElement>('[name="required"]')?.checked ?? false;
    for (const key of ["eventId", "assetId", "backupUserId"]) if (values[key] === "") delete values[key];
    if (modal?.type === "flag-check") { values.itemId = modal.id; values.status = "Needs attention"; }
    if (modal?.type === "resolve-incident") { values.incidentId = modal.id; }
    if (modal?.type === "edit-incident") { values.incidentId = modal.id; }
    if (modal?.type === "edit-checklist-item" || modal?.type === "delete-checklist-item") values.itemId = modal.id;
    if (modal?.type === "checkout-equipment") values.assetId = modal.id;
    if (modal?.type === "edit-asset") values.assetId = modal.id;
    if (modal?.type === "return-equipment") values.loanId = modal.id;
    if (modal?.type === "publish-sop") { values.sopId = modal.id; values.reviewConfirmed = values.reviewConfirmed === true; }
    try {
      const result = await run(action, values);
      if (action === "quick_assign_checklist" && typeof values.userId === "string") window.localStorage.setItem(`iac-last-checklist-person-${payload?.context?.user.id ?? "default"}`, values.userId);
      if (action === "quick_assign_equipment" && typeof values.borrowerId === "string" && typeof values.templateId === "string") {
        try { window.localStorage.setItem(`iac-last-equipment-person-${payload?.context?.user.id ?? "default"}-${values.templateId}`, values.borrowerId); } catch { /* Remembered selection is optional if browser storage is unavailable. */ }
      }
      if (!(["add_category", "delete_category", "reorder_categories"].includes(action))) setModal(null);
      if (action.startsWith("team_")) setTeamRefresh((value) => value + 1);
      if (result.temporaryPassword) setModal({ type: "credential-reveal", username: String(result.username ?? ""), secret: String(result.temporaryPassword) });
      const sheetSyncNotReady = action === "create_asset" && result.sheetSynced === false;
      setNotice({ text: result.temporaryPassword ? "Save these sign-in details and give them to the account owner." : sheetSyncNotReady ? "Equipment was added in the app, but not copied to the Google Sheet. Set up the server-side Sheets connection before adding items you need synced." : actionSuccess(action), error: sheetSyncNotReady });
      await load();
    } catch (error) { setNotice({ text: error instanceof Error ? error.message : "The action could not be completed.", error: true }); }
  };

  const doAction = async (action: string, values: Record<string, unknown> = {}) => {
    try { const result = await run(action, values); const sheetSyncNotReady = action === "create_asset" && result.sheetSynced === false; setNotice({ text: result.temporaryPassword ? "Save the new password and give it to the account owner." : sheetSyncNotReady ? "Equipment was added in the app, but not copied to the Google Sheet. Set up the server-side Sheets connection before adding items you need synced." : actionSuccess(action), error: sheetSyncNotReady }); if (result.temporaryPassword) setModal({ type: "credential-reveal", username: String(result.username ?? ""), secret: String(result.temporaryPassword) }); if (action.startsWith("team_")) setTeamRefresh((value) => value + 1); await load(); }
    catch (error) { setNotice({ text: error instanceof Error ? error.message : "The action could not be completed.", error: true }); }
  };

  const deleteEquipment = async (assetId: string) => {
    try {
      await run("delete_asset", { assetId });
      setNotice({ text: actionSuccess("delete_asset") });
      await load();
      return true;
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "The equipment could not be deleted.", error: true });
      return false;
    }
  };

  const signOut = async () => {
    await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "logout" }) });
    seenNotificationIds.current = null; notificationUserId.current = null; setChatUnread({ userId: null, count: 0 }); setNotificationAlert(null); setPage("dashboard"); setPayload(null); await load();
  };

  const context = payload?.context;
  const data = payload?.data ?? emptyData;
  const visibleNotificationAlert = notificationAlert?.alarmId && payload && !data.timeAlarms.some((entry) => entry.id === notificationAlert.alarmId && !entry.completedAt && !entry.cancelledAt)
    ? null
    : notificationAlert;
  const allowedNav = useMemo(() => navItems.filter((item) => !item.needs || context?.capabilities.includes(item.needs)), [context]);
  const navCounts = useMemo(() => {
    const user = context?.user;
    if (!user) return { chat: 0, checklists: 0, notifications: 0 };
    const managerView = hasManagerAccess(user.accessRoles, user.role);
    const cutoff = currentTime - 24 * 60 * 60 * 1000;
    return {
      chat: chatUnread.userId === user.id ? chatUnread.count : 0,
      checklists: data.checklistItems.filter((item) => (managerView || item.userId === user.id) && (!managerView || !item.clearedFromChecklist) && item.status !== "Complete").length,
      notifications: data.notifications.filter((item) => item.userId === user.id && !item.read && (!managerView || Date.parse(item.date) >= cutoff)).length,
    };
  }, [context, data, chatUnread, currentTime]);
  useEffect(() => {
    const userId = context?.user.id;
    if (!userId) { priorNavCounts.current = null; return; }
    const previous = priorNavCounts.current;
    priorNavCounts.current = { userId, ...navCounts };
    if (!previous || previous.userId !== userId) return;
    const arrived: PageKey[] = [];
    if (navCounts.chat > previous.chat) arrived.push("chat");
    if (navCounts.checklists > previous.checklists) arrived.push("checklists");
    if (navCounts.notifications > previous.notifications) arrived.push("notifications");
    if (!arrived.length) return;
    const frame = window.requestAnimationFrame(() => {
      setAnimatedNavItems(arrived);
      if (navAnimationTimer.current !== null) window.clearTimeout(navAnimationTimer.current);
      navAnimationTimer.current = window.setTimeout(() => setAnimatedNavItems([]), 1_250);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (navAnimationTimer.current !== null) {
        window.clearTimeout(navAnimationTimer.current);
        navAnimationTimer.current = null;
      }
    };
  }, [context?.user.id, navCounts]);

  if (loading && !authSettings) return <div className="boot-screen"><BrandMark large /><span className="boot-pulse" />Preparing media operations</div>;
  if (!context) return <SignInScreen settings={authSettings} loading={loginBusy} error={loginError} onDemoAccount={signInDemoAccount} onSupabase={signInSupabase} darkMode={darkMode} onToggleTheme={() => setDarkMode((value) => !value)} />;

  const user = context.user;
  const manager = hasManagerAccess(user.accessRoles, user.role);
  const nextPersonalAlarm = data.timeAlarms.filter((alarm) => alarm.userId === user.id && !alarm.cancelledAt && !alarm.completedAt).sort((a, b) => a.fireAt.localeCompare(b.fireAt))[0];
  const personalAlarmOverdue = Boolean(nextPersonalAlarm && (nextPersonalAlarm.triggeredAt || Date.parse(nextPersonalAlarm.fireAt) <= alarmDisplayNow));
  const personalAlarmRemainingMs = nextPersonalAlarm ? Date.parse(nextPersonalAlarm.fireAt) - alarmDisplayNow : Number.POSITIVE_INFINITY;
  const personalAlarmNearDue = Boolean(nextPersonalAlarm && !personalAlarmOverdue && personalAlarmRemainingMs > 0 && personalAlarmRemainingMs <= 5 * 60_000);
  const personalAlarmCritical = personalAlarmNearDue && personalAlarmRemainingMs <= 60_000;
  const notificationCutoff = currentTime - 24 * 60 * 60 * 1000;
  const unreadCount = data.notifications.filter((item) => item.userId === user.id && !item.read && (!manager || Date.parse(item.date) >= notificationCutoff)).length;
  const openIncidentCount = data.incidents.filter((item) => !["Resolved", "Closed"].includes(item.status)).length;
  const filteredSearch = search.trim().toLowerCase();
  const searchMatch = (text: string) => !filteredSearch || text.toLowerCase().includes(filteredSearch);

  const renderPage = () => {
    switch (page) {
      case "dashboard": return <Dashboard data={data} user={user} setPage={setPage} currentTime={currentTime} />;
      case "time": return <TimePage data={data} user={user} run={doAction} />;
      case "chat": return <CrewChatPage user={user} mode={context.mode} />;
      case "events": return <EventsPage data={data} user={user} searchMatch={searchMatch} openModal={setModal} run={doAction} />;
      case "equipment": return <EquipmentPage data={data} user={user} searchMatch={searchMatch} openModal={setModal} run={doAction} />;
      case "checklists": return <ChecklistsPage data={data} user={user} openModal={setModal} run={doAction} />;
      case "sops": return <SopPage data={data} user={user} searchMatch={searchMatch} openModal={setModal} run={doAction} />;
      case "incidents": return <IncidentsPage data={data} user={user} openModal={setModal} run={doAction} />;
      case "reports": return <ReportsPage data={data} user={user} run={doAction} />;
      case "notifications": return <NotificationsPage data={data} user={user} run={doAction} currentTime={currentTime} />;
      case "settings": return <SettingsPage data={data} context={context} openModal={setModal} refreshKey={teamRefresh} />;
      default: return null;
    }
  };

  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? "is-open" : ""}`}>
      <div className="brand-lockup"><BrandMark /><div><strong>Media Operations</strong><span>IMAM ALI CENTER</span></div><button className="icon-button mobile-close" onClick={() => setMobileNav(false)} aria-label="Close menu"><X size={18} /></button></div>
      <div className="workspace-label">WORKSPACE</div>
      <nav className="primary-nav" aria-label="Main navigation">
        {allowedNav.map(({ key, label, icon: Icon }) => {
          const count = key === "chat" ? navCounts.chat : key === "checklists" ? navCounts.checklists : key === "notifications" ? unreadCount : 0;
          const countLabel = key === "chat" ? "unread messages" : key === "checklists" ? "unfinished checklist items" : "unread notifications";
          const isArriving = animatedNavItems.includes(key);
          return <button key={key} title={count > 0 ? `${label} · ${count} ${countLabel}` : label} aria-label={count > 0 ? `${label}, ${count} ${countLabel}` : label} className={`nav-link ${page === key ? "active" : ""} ${isArriving ? "is-arriving" : ""}`} onClick={() => { setPage(key); setMobileNav(false); }}><Icon size={18} strokeWidth={2} /><span>{label}</span>{count > 0 && <b className={`nav-count ${isArriving ? "is-arriving" : ""}`}>{count > 99 ? "99+" : count}</b>}{key === "incidents" && openIncidentCount > 0 && <b className="nav-count incident-nav-count" aria-label={`${openIncidentCount} open incidents`}>{openIncidentCount}</b>}</button>;
        })}
      </nav>
      <div className="sidebar-bottom"><div className={`connection ${context.mode === "demo" ? "demo-connection" : ""}`}><span className="connection-dot" /><span>{context.mode === "demo" ? "Local accounts" : "Supabase connected"}</span></div><div className="sidebar-user"><ProfileAvatar name={user.fullName} src={user.avatarUrl} className="avatar" /><div className="user-lines"><strong>{user.fullName}</strong><span>{user.role}</span></div><button className="icon-button signout" title="Sign out" onClick={signOut} aria-label="Sign out"><LogOut size={16} /></button></div></div>
    </aside>
    {mobileNav && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
    <div className="main-column">
      <header className="topbar"><div className="topbar-left"><button className="icon-button menu-toggle" aria-label="Open menu" onClick={() => setMobileNav(true)}><Menu size={20} /></button><span className="breadcrumb">IAC <span>/</span> {pageTitles[page]}</span></div><div className="topbar-right"><label className="global-search"><Search size={16} /><input aria-label="Search visible records" placeholder="Search visible records" value={search} onChange={(event) => setSearch(event.target.value)} /><kbd>⌘ K</kbd></label><ThemeToggle darkMode={darkMode} onToggle={() => setDarkMode((value) => !value)} /><button className={`icon-button notification-button ${visibleNotificationAlert ? "is-alerting" : ""}`} onClick={() => setPage("notifications")} title="Notifications" aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ""}`}><Bell size={18} />{unreadCount > 0 && <b className="top-notification-count">{unreadCount > 99 ? "99+" : unreadCount}</b>}</button><button type="button" className="top-profile-button" title="My profile" aria-label="Open my profile" onClick={() => setModal({ type: "profile" })}><ProfileAvatar name={user.fullName} src={user.avatarUrl} className="top-avatar" /></button></div></header>
      <main key={page} className="main-content page-transition"><div className="page-heading"><div><div className="hero-badge page-heading-badge"><Sparkles size={12} /> OPERATIONS HUB — IN SYNC</div><div className="eyebrow">IMAM ALI CENTER · MEDIA TEAM</div><h1>{pageTitles[page]}</h1></div><div className="page-heading-meta"><span className="today-label">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</span>{page === "events" && can(user.accessRoles ?? user.role, "manage_events") && <button className="button button-primary" onClick={() => setModal({ type: "create-event" })}><Plus size={16} />Create event</button>}{page === "checklists" && hasManagerAccess(user.accessRoles, user.role) && <button className="button button-primary" onClick={() => setModal({ type: "create-checklist-item" })}><Plus size={16} />Add checklist item</button>}{page === "equipment" && can(user.accessRoles ?? user.role, "manage_equipment") && <button className="button button-primary" onClick={() => setModal({ type: "create-asset" })}><Plus size={16} />Add asset</button>}{page === "incidents" && can(user.accessRoles ?? user.role, "report_incidents") && <button className="button button-primary" onClick={() => setModal({ type: "report-incident" })}><AlertTriangle size={15} />Report issue</button>}{page === "sops" && can(user.accessRoles ?? user.role, "manage_sops") && <button className="button button-primary" onClick={() => setModal({ type: "create-sop" })}><Plus size={16} />New SOP</button>}</div></div>

        {loading && <div className="refresh-line"><span />Refreshing records…</div>}
        {search.trim() ? <GlobalSearchResults data={data} query={search.trim()} setPage={setPage} clear={() => setSearch("")} /> : renderPage()}
      </main>
    </div>
    {nextPersonalAlarm && alarmDisplayNow > 0 && <button type="button" className={`alarm-countdown-widget ${page === "chat" ? "is-over-chat" : ""} ${personalAlarmOverdue ? "is-overdue" : ""} ${personalAlarmNearDue ? "is-near-due" : ""} ${personalAlarmCritical ? "is-critical" : ""}`} style={{ "--alarm-hue": alarmCountdownHue(personalAlarmRemainingMs), ...(alarmWidgetPosition ? { left: alarmWidgetPosition.left, top: alarmWidgetPosition.top, right: "auto", bottom: "auto" } : {}) } as CSSProperties} onPointerDown={startAlarmWidgetDrag} onPointerMove={moveAlarmWidget} onPointerUp={endAlarmWidgetDrag} onPointerCancel={endAlarmWidgetDrag} onClick={() => { if (alarmClickSuppressed.current) return; setPage("time"); }} aria-label={`${personalAlarmOverdue ? "Overdue alarm" : "Alarm countdown"}: ${nextPersonalAlarm.description}. Drag to move.`}>
      <span className="alarm-countdown-widget-icon"><AlarmClock size={19} /></span>
      <span className="alarm-countdown-widget-copy"><small>{personalAlarmOverdue ? "ALARM OVERDUE" : "TIME REMAINING"}</small><strong>{nextPersonalAlarm.description}</strong><em style={{ "--alarm-hue": alarmCountdownHue(personalAlarmRemainingMs) } as CSSProperties}>{personalAlarmOverdue ? "Task needs completion" : formatAlarmCountdown(nextPersonalAlarm.fireAt, alarmDisplayNow)}</em></span>
      <span className="alarm-drag-handle" aria-hidden="true"><GripHorizontal size={14} /><small>Move</small></span>
      <ArrowRight size={16} />
    </button>}
    {visibleNotificationAlert?.alarmId ? <div key={visibleNotificationAlert.id} className="notification-arrival alarm-notification-arrival" role="status"><span className="notification-arrival-icon"><AlarmClock size={25} /></span><span><strong>Alarm is due</strong><small>{visibleNotificationAlert.detail} · Complete the task to stop reminders.</small></span><button className="button button-primary alarm-arrival-complete" type="button" onClick={() => { setNotificationAlert(null); void doAction("complete_time_alarm", { alarmId: visibleNotificationAlert.alarmId }); }}>Task completed</button></div> : visibleNotificationAlert && <button type="button" key={visibleNotificationAlert.id} className="notification-arrival" role="status" onClick={() => { setPage("notifications"); setNotificationAlert(null); }}><span className="notification-arrival-icon"><Bell size={24} /></span><span><strong>New notification</strong><small>{visibleNotificationAlert.title} · {visibleNotificationAlert.detail}</small></span><span className="notification-arrival-action">View</span></button>}
    {modal && <Modal state={modal} data={data} user={user} context={context} onClose={() => setModal(null)} openModal={setModal} onSubmit={handleForm} run={doAction} onDeleteAsset={deleteEquipment} />}
    {notice && <div role="status" className={`toast ${notice.error ? "toast-error" : ""}`}><span>{notice.error ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />}</span>{notice.text}<button className="icon-button" onClick={() => setNotice(null)} aria-label="Dismiss"><X size={15} /></button></div>}
  </div>;
}

function actionSuccess(action: string) {
  const messages: Record<string, string> = {
    create_event: "Event saved as a draft.", update_event: "Event updated.", publish_event: "Schedule published.", delete_event: "Event deleted.", set_event_response: "Your event response was saved.", set_event_program_phase: "Program phase updated.", complete_checklist_item: "Checklist updated.", create_checklist_item: "Checklist item added for the selected member.", update_checklist_item: "Checklist item updated.", delete_checklist_item: "Checklist item removed.", clear_completed_checklists: "Completed items were cleared from the checklist view. Reports are unchanged.", create_checklist_template: "Checklist template saved.", update_checklist_template: "Checklist template updated.", duplicate_checklist_template: "Checklist template duplicated.", delete_checklist_template: "Checklist template deleted.", quick_assign_checklist: "Checklist assigned to the selected member.", create_equipment_template: "Equipment template saved.", update_equipment_template: "Equipment template updated.", duplicate_equipment_template: "Equipment template duplicated.", delete_equipment_template: "Equipment template deleted.", quick_assign_equipment: "Equipment handoff recorded from the saved template.", profile_update: "Your profile was updated.", profile_change_password: "Your password was changed.", create_asset: "Equipment added to inventory.", update_asset: "Equipment record updated.", delete_asset: "Equipment deleted.", delete_equipment_history: "Equipment handoff history deleted.", issue_equipment: "Equipment handoff recorded.", return_equipment: "Equipment return recorded.", report_incident: "Incident report sent to the administrator.", resolve_incident: "Incident resolution recorded.", complete_own_incident: "Incident job marked complete.", update_incident: "Incident record updated.", delete_incident: "Incident deleted.", add_category: "Category added.", delete_category: "Category removed.", reorder_categories: "Category order updated.", create_sop: "SOP draft saved for review.", update_sop_audience: "SOP visibility updated.", publish_sop: "Reviewed procedure published.", mark_notification_read: "Notification marked read.", complete_time_alarm: "Alarm marked complete. Reminders have stopped.", hide_service_history: "That service entry was removed from the report view. Its record is preserved.", reset_member_service_history: "That person's service history was cleared from recognition reports. Original records are preserved.", team_invite: "Invitation sent with a secure password setup link.", team_update_member: "Team account updated.", team_reset_password: "Password setup link sent.", team_set_password: "Password updated. Share it privately; the member can change it after signing in.",
  };
  return messages[action] ?? "Changes saved.";
}

function GlobalSearchResults({ data, query, setPage, clear }: { data: AppData; query: string; setPage: (page: PageKey) => void; clear: () => void }) {
  const needle = query.toLowerCase();
  const results: { page: PageKey; section: string; title: string; detail: string }[] = [
    ...data.events.filter((item) => `${item.title} ${item.category} ${item.venue} ${item.date}`.toLowerCase().includes(needle)).map((item) => ({ page: "events" as const, section: "Event", title: item.title, detail: `${displayDate(item.date)} · ${item.venue} · ${item.category}` })),
    ...data.profiles.filter((item) => `${item.fullName} ${item.role} ${item.jobTitle ?? ""} ${(item.accessRoles ?? []).join(" ")}`.toLowerCase().includes(needle)).map((item) => ({ page: "settings" as const, section: "Team member", title: item.fullName, detail: `${(item.accessRoles ?? [item.role]).join(" · ")} · ${item.jobTitle || "Team account"}` })),
    ...data.assets.filter((item) => `${item.assetCode} ${item.name} ${item.category} ${item.location} ${item.status}`.toLowerCase().includes(needle)).map((item) => ({ page: "equipment" as const, section: "Equipment", title: item.name, detail: `${item.assetCode} · ${item.category} · ${item.quantity ?? 1} total · ${item.status}` })),
    ...data.sops.filter((item) => `${item.title} ${item.category} ${item.summary}`.toLowerCase().includes(needle)).map((item) => ({ page: "sops" as const, section: "Procedure", title: item.title, detail: `${item.category} · ${item.status} · version ${item.version}` })),
    ...data.checklistItems.filter((item) => `${item.label} ${item.status} ${item.note ?? ""}`.toLowerCase().includes(needle)).map((item) => ({ page: "checklists" as const, section: "Checklist", title: item.label, detail: `${data.events.find((event) => event.id === item.eventId)?.title ?? "Event"} · ${item.status}` })),
    ...data.incidents.filter((item) => `${item.category} ${item.severity} ${item.description} ${item.status}`.toLowerCase().includes(needle)).map((item) => ({ page: "incidents" as const, section: "Incident", title: item.category, detail: `${item.severity} · ${item.status} · ${item.description}` })),
    ...data.notifications.filter((item) => `${item.title} ${item.detail}`.toLowerCase().includes(needle)).map((item) => ({ page: "notifications" as const, section: "Notification", title: item.title, detail: item.detail })),
  ].slice(0, 30);
  return <><PageIntro title={`Search results for “${query}”`} detail="Results only include records your current role is allowed to access." /><div className="search-results-summary"><Search size={15} />{results.length} matching record{results.length === 1 ? "" : "s"}<button className="text-button" onClick={clear}>Clear search <X size={13} /></button></div>{results.length ? <div className="global-results-list">{results.map((result, index) => <button className="global-result" key={`${result.page}-${result.title}-${index}`} onClick={() => { setPage(result.page); clear(); }}><span className="global-result-icon">{result.section === "Equipment" ? <HardDrive size={16} /> : result.section === "Procedure" ? <BookOpen size={16} /> : result.section === "Team member" ? <Users size={16} /> : result.section === "Incident" ? <AlertTriangle size={16} /> : result.section === "Checklist" ? <ClipboardCheck size={16} /> : result.section === "Notification" ? <Bell size={16} /> : <CalendarDays size={16} />}</span><span className="global-result-copy"><small>{result.section}</small><strong>{result.title}</strong><span>{result.detail}</span></span><ArrowRight size={15} /></button>)}</div> : <EmptyState icon={Search} title="No matching records" detail="Try another name, event, asset ID, procedure, or status." />}</>;
}

function ThemeToggle({ darkMode, onToggle }: { darkMode: boolean; onToggle: () => void }) {
  const label = darkMode ? "Switch to light mode" : "Switch to dark mode";
  return <button className="icon-button theme-toggle" type="button" onClick={onToggle} aria-label={label} title={label}>{darkMode ? <Sun size={18} /> : <Moon size={18} />}</button>;
}

function SignInScreen({ settings, loading, error, onDemoAccount, onSupabase, darkMode, onToggleTheme }: { settings: { demoAvailable: boolean; supabaseConfigured: boolean } | null; loading: boolean; error: string; onDemoAccount: (event: FormEvent<HTMLFormElement>) => void; onSupabase: (event: FormEvent<HTMLFormElement>) => void; darkMode: boolean; onToggleTheme: () => void }) {
  return <div className="login-screen"><ThemeToggle darkMode={darkMode} onToggle={onToggleTheme} /><div className="login-panel"><div className="login-brand"><BrandMark large /><div className="hero-badge"><Sparkles size={12} /> IAC MEDIA OPS — BUILT TO FLOW</div><div className="eyebrow">IMAM ALI CENTER · MEDIA TEAM</div><h1 className="gradient-heading">Media Operations</h1><p className="login-subtitle">One connected workspace — from prep to final cue.</p></div>
    {settings?.demoAvailable && <><div className="demo-login-note"><Activity size={17} /><span><strong>Team sign in</strong><br />Use the username and password given to you by the administrator.</span></div><form className="login-form" onSubmit={onDemoAccount}><label>Username<input name="username" autoComplete="username" required /></label><label>Password<input name="password" type="password" autoComplete="current-password" required /></label><button className="button button-primary full-button" disabled={loading}>{loading ? "Signing in…" : "Sign in"}</button></form></>}
    {settings?.supabaseConfigured && <form className="login-form" onSubmit={onSupabase}><label>Username or sign-in email<input name="identifier" autoComplete="username" required /></label><label>Password<input name="password" type="password" autoComplete="current-password" required /></label><button className="button button-primary full-button" disabled={loading}>{loading ? "Signing in…" : "Sign in securely"}</button></form>}
    {error && <p className="login-error" role="alert">{error}</p>}
    {!settings?.demoAvailable && !settings?.supabaseConfigured && <EmptyState title="Sign-in is not configured" detail="Set Supabase credentials or start the development server with local demo mode enabled." />}
    <div className="login-footer"><ShieldCheck size={15} /> Role permissions are enforced by server actions and database policies.</div>
  </div><div className="login-side"><div className="login-side-mark"><Radio size={21} /> IAC MEDIA TEAM</div><div className="login-side-content"><div className="hero-badge hero-badge-dark"><Sparkles size={12} /> PRODUCTION, ORCHESTRATED — FOR IAC</div><div className="live-indicator"><span /> OPERATIONS DESK</div><h2>Move every moment — <em>in sync</em>.</h2><p>Leverage one seamless workflow — align the crew, elevate every program, and keep production moving.</p><div className="hero-icon-row"><div className="hero-icon-box"><span><CalendarDays size={17} /></span><strong>Align</strong><small>People + programs</small></div><div className="hero-icon-box"><span><Headphones size={17} /></span><strong>Amplify</strong><small>Audio + visuals</small></div><div className="hero-icon-box"><span><Radio size={17} /></span><strong>Activate</strong><small>Production flow</small></div></div><div className="signal-bars"><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /></div></div><div className="login-side-foot">LOCAL TIMEZONE — {Intl.DateTimeFormat().resolvedOptions().timeZone}</div></div></div>;
}

function PageIntro({ title, detail, children }: { title: string; detail: string; children?: ReactNode }) { return <div className="section-intro"><div><h2>{title}</h2><p>{detail}</p></div>{children}</div>; }

function TimePage({ data, user, run }: { data: AppData; user: Profile; run: (action: string, values?: Record<string, unknown>) => Promise<void> }) {
  const [clockMs, setClockMs] = useState(0);
  const [clockSynced, setClockSynced] = useState(false);
  const [scheduleMode, setScheduleMode] = useState<"countdown" | "clock">("countdown");
  const [phoneAlertPermission, setPhoneAlertPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  const clockOffset = useRef(0);
  const manager = hasManagerAccess(user.accessRoles, user.role);
  const administrator = hasAccessRole(user.accessRoles, user.role, "Administrator");
  const center = clockMs ? centerTimeParts(clockMs) : null;
  const alarms = [...(data.timeAlarms ?? [])].sort((a, b) => Number(Boolean(a.cancelledAt || a.triggeredAt)) - Number(Boolean(b.cancelledAt || b.triggeredAt)) || a.fireAt.localeCompare(b.fireAt));
  const activePeople = data.profiles.filter((profile) => profile.active !== false).sort((a, b) => a.fullName.localeCompare(b.fullName));

  useEffect(() => {
    let mounted = true;
    const synchronize = async () => {
      const requestStarted = Date.now();
      try {
        const response = await fetch("/api/time", { cache: "no-store" });
        if (!response.ok) return;
        const body = await response.json() as { epochMs: number };
        const responseReceived = Date.now();
        if (!mounted || !Number.isFinite(body.epochMs)) return;
        clockOffset.current = body.epochMs - (requestStarted + responseReceived) / 2;
        setClockMs(responseReceived + clockOffset.current);
        setClockSynced(true);
      } catch { /* Keep displaying the device clock if the brief sync request is unavailable. */ }
    };
    void synchronize();
    const timer = window.setInterval(() => void synchronize(), 30_000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClockMs(Date.now() + clockOffset.current), 25);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setPhoneAlertPermission("Notification" in window ? window.Notification.permission : "unsupported");
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const enablePhoneAlerts = async () => {
    if (!("Notification" in window)) { setPhoneAlertPermission("unsupported"); return; }
    try { setPhoneAlertPermission(await window.Notification.requestPermission()); }
    catch { setPhoneAlertPermission("denied"); }
  };

  const createAlarm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form).entries()) as Record<string, unknown>;
    values.scheduleMode = scheduleMode;
    await run("create_time_alarm", values);
    form.reset();
  };

  return <>
    <PageIntro title="Shared timecode" detail="The same center time is shown on every phone and computer, synchronized with the app server.">{administrator && alarms.some((alarm) => !alarm.cancelledAt && !alarm.completedAt) && <button className="button button-small button-quiet danger-text" type="button" onClick={() => { if (window.confirm("Clear every active team alarm and stop its reminders? Completed alarms and their history will remain unchanged.")) void run("admin_clear_active_time_alarms"); }}><Trash2 size={14} />Clear all active alarms</button>}</PageIntro>
    <section className="time-clock-panel" aria-label="Shared center time">
      <div className="time-clock-topline"><span className="time-clock-indicator" /><span>IMAM ALI CENTER · EASTERN TIME</span><span className={`time-sync-state ${clockSynced ? "is-synced" : ""}`}>{clockSynced ? "Synced" : "Syncing"}</span></div>
      <output className="timecode-display" aria-label={`Current time ${center?.display ?? "syncing"}`}>{center?.display ?? "--:--:--.---"}</output>
      <div className="time-clock-bottom"><span>{center?.date ?? "Synchronizing center time…"}</span><span>HH : MM : SS . milliseconds</span></div>
    </section>

    <div className="time-content-grid">
      <section className="panel time-alarm-panel">
        <div className="panel-heading"><div><span className="eyebrow">SCHEDULE</span><h3>Set an alarm</h3></div><AlarmClock size={18} /></div>
        <form className="time-alarm-form" onSubmit={createAlarm}>
          {manager && <label className="form-field"><span>Who should get this alarm?</span><select name="userId" defaultValue="" required><option value="" disabled>Choose a team member</option><option value={user.id}>Me · {user.fullName}</option>{activePeople.filter((profile) => profile.id !== user.id).map((profile) => <option key={profile.id} value={profile.id}>{profile.fullName} · {profile.role}</option>)}</select></label>}
          <div className="time-alarm-mode" role="group" aria-label="Choose when the alarm should go off">
            <button className={scheduleMode === "countdown" ? "is-selected" : ""} type="button" aria-pressed={scheduleMode === "countdown"} onClick={() => setScheduleMode("countdown")}>In minutes</button>
            <button className={scheduleMode === "clock" ? "is-selected" : ""} type="button" aria-pressed={scheduleMode === "clock"} onClick={() => setScheduleMode("clock")}>At a time</button>
          </div>
          {scheduleMode === "countdown" ? <label className="form-field"><span>Minutes from now</span><input name="minutes" type="number" min={1} max={10080} step={1} defaultValue={20} required /></label> : <div className="time-alarm-input-row"><label className="form-field"><span>Date · Eastern time</span><input name="date" type="date" required min={center?.inputDate} defaultValue={center?.inputDate} /></label><label className="form-field"><span>Time · Eastern time</span><input name="time" type="time" required /></label></div>}
          <label className="form-field"><span>Alarm description</span><input name="description" maxLength={180} placeholder="For example, camera check in 10 minutes" required /></label>
          <p className="time-alarm-help">The recipient sees a live countdown. At zero, their phone can vibrate and show an alert. Reminders repeat every minute until they complete the task while the app is open.</p>
          {phoneAlertPermission === "granted" ? <p className="time-alert-permission is-enabled"><CheckCircle2 size={13} />Phone alerts are enabled on this device.</p> : phoneAlertPermission === "unsupported" ? <p className="time-alert-permission">This browser does not support phone notifications.</p> : phoneAlertPermission === "denied" ? <p className="time-alert-permission">Phone alerts are blocked. Enable notifications for this app in your device settings.</p> : <button className="button button-small button-quiet time-alert-enable" type="button" onClick={() => void enablePhoneAlerts()}><Bell size={13} />Enable phone alerts</button>}
          <button className="button button-primary" type="submit"><AlarmClock size={15} />Set alarm</button>
        </form>
      </section>

      <section className="panel time-alarm-panel">
        <div className="panel-heading"><div><span className="eyebrow">ALARM LIST</span><h3>{manager ? "Team alarms" : "My alarms"}</h3></div><span className="time-alarm-count">{alarms.filter((alarm) => !alarm.cancelledAt && !alarm.triggeredAt).length} active</span></div>
        {alarms.length ? <div className="time-alarm-list">{alarms.map((alarm) => {
          const recipient = data.profiles.find((profile) => profile.id === alarm.userId);
          const status = alarm.completedAt ? "Task completed" : alarm.cancelledAt ? "Cancelled" : alarm.triggeredAt ? "Due · needs completion" : "Scheduled";
          const remainingMs = Date.parse(alarm.fireAt) - clockMs;
          const nearDue = clockMs > 0 && !alarm.triggeredAt && !alarm.cancelledAt && !alarm.completedAt && remainingMs > 0 && remainingMs <= 5 * 60_000;
          const critical = nearDue && remainingMs <= 60_000;
          return <article key={alarm.id} className={`time-alarm-card ${alarm.cancelledAt ? "is-cancelled" : ""} ${alarm.completedAt ? "is-completed" : ""} ${alarm.triggeredAt && !alarm.completedAt && !alarm.cancelledAt ? "is-due" : ""} ${nearDue ? "is-near-due" : ""} ${critical ? "is-critical" : ""}`} style={{ "--alarm-hue": alarmCountdownHue(remainingMs) } as CSSProperties}>
            <span className="time-alarm-card-icon"><AlarmClock size={16} /></span>
            <div className="time-alarm-card-copy"><strong>{alarm.description}</strong><span>{new Intl.DateTimeFormat(undefined, { timeZone: sharedTimeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(alarm.fireAt))} · Eastern time</span>{manager && <small>For {recipient?.fullName ?? "Team member"}</small>}{!alarm.cancelledAt && !alarm.triggeredAt && !alarm.completedAt && <span className={`time-alarm-countdown ${nearDue ? "is-near-due" : ""}`} style={{ "--alarm-hue": alarmCountdownHue(remainingMs) } as CSSProperties}>{clockMs ? formatAlarmCountdown(alarm.fireAt, clockMs) : "Syncing countdown…"}</span>}{alarm.triggeredAt && !alarm.completedAt && !alarm.cancelledAt && <strong className="time-alarm-needs-completion">Press “Task completed” when you finish.</strong>}</div>
            <span className={`time-alarm-status ${alarm.triggeredAt && !alarm.completedAt ? "is-triggered" : ""} ${alarm.completedAt ? "is-completed" : ""}`}>{status}</span>
            {alarm.triggeredAt && !alarm.completedAt && !alarm.cancelledAt && alarm.userId === user.id && <button className="button button-small button-primary time-alarm-complete" type="button" onClick={() => void run("complete_time_alarm", { alarmId: alarm.id })}><CheckCircle2 size={14} />Task completed</button>}
            {!alarm.cancelledAt && !alarm.triggeredAt && (manager || alarm.userId === user.id) && <button className="icon-button" type="button" aria-label={`Cancel alarm: ${alarm.description}`} title="Cancel alarm" onClick={() => void run("cancel_time_alarm", { alarmId: alarm.id })}><X size={15} /></button>}
          </article>;
        })}</div> : <EmptyState icon={AlarmClock} title="No alarms scheduled" detail="Set an alarm for yourself or, as an administrator or director, a team member." />}
      </section>
    </div>
  </>;
}

type ChatMember = Pick<Profile, "id" | "fullName" | "avatarUrl" | "role" | "jobTitle">;
function chatFileUrl(path: string) { return `/api/chat/media?path=${encodeURIComponent(path)}`; }
function isChatImageAttachment(name: string, path: string, type: string) {
  const imageFileName = /\.(?:jpe?g|png|webp|gif)$/i;
  return type.startsWith("image/") || imageFileName.test(name) || imageFileName.test(path);
}
function ChatAttachmentPreview({ attachment, onOpenImage }: { attachment: ChatAttachment; onOpenImage: (src: string, name: string) => void }) {
  if (!attachment || typeof attachment !== "object") return null;
  const type = typeof attachment.type === "string" ? attachment.type.toLowerCase() : "";
  const name = typeof attachment.name === "string" && attachment.name.trim() ? attachment.name : "Attached file";
  const size = typeof attachment.size === "number" && Number.isFinite(attachment.size) && attachment.size > 0 ? attachment.size : 0;
  const dataUrl = typeof attachment.dataUrl === "string" ? attachment.dataUrl : "";
  const path = typeof attachment.path === "string" ? attachment.path : "";
  const source = dataUrl || (path ? chatFileUrl(path) : "");
  if (!source) return null;
  if (isChatImageAttachment(name, path, type)) return <button type="button" className="chat-attachment-image-button" aria-label={`View ${name} larger`} onClick={() => onOpenImage(source, name)}><NextImage unoptimized src={source} alt={name} width={280} height={220} className="chat-attachment-image" /></button>;
  if (type.startsWith("video/")) return <video className="chat-attachment-video" controls preload="metadata" src={source}>{name}</video>;
  if (type.startsWith("audio/")) return <audio className="chat-attachment-audio" controls preload="metadata" src={source}>{name}</audio>;
  return <a className="chat-attachment-file" href={source} target="_blank" rel="noreferrer"><FileText size={17} /><span><strong>{name}</strong><small>{size ? formatFileSize(size) : "File attachment"}</small></span><ArrowDownToLine size={14} /></a>;
}

function decodePushKey(key: string) {
  const normalized = key.replace(/-/g, "+").replace(/_/g, "/");
  const binary = window.atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function ChatMessageText({ body, members }: { body: string; members: ChatMember[] }) {
  const names = members.map((member) => member.fullName).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length) return <p>{body}</p>;
  const pattern = new RegExp(`(@(?:${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b)`, "g");
  return <p>{body.split(pattern).map((part, index) => part.startsWith("@") ? <strong className="chat-mention-text" key={`${index}-${part}`}>{part}</strong> : part)}</p>;
}

function CrewChatPage({ user, mode }: { user: Profile; mode: SessionContext["mode"] }) {
  const [conversationType, setConversationType] = useState<"all" | "direct">("all");
  const [recipientId, setRecipientId] = useState("");
  const [members, setMembers] = useState<ChatMember[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [imagePreview, setImagePreview] = useState<{ src: string; name: string } | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [unreadCounts, setUnreadCounts] = useState<{ all: number; direct: Record<string, number> }>({ all: 0, direct: {} });
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [pushAvailable, setPushAvailable] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMessage, setPushMessage] = useState("");
  const sendingRef = useRef(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const imagePreviewCloseRef = useRef<HTMLButtonElement>(null);
  const imagePreviewReturnFocusRef = useRef<HTMLElement | null>(null);
  const shouldScrollToBottom = useRef(true);
  const isAtBottom = useRef(true);
  const knownMessageIds = useRef<Set<string> | null>(null);
  const [freshMessageIds, setFreshMessageIds] = useState<Set<string>>(() => new Set());
  const freshMessageTimer = useRef<number | null>(null);
  const recipient = members.find((member) => member.id === recipientId);
  const mentionCandidates = members.filter((member) => (!mentionQuery || member.fullName.toLocaleLowerCase().includes(mentionQuery.toLocaleLowerCase())) && (conversationType !== "direct" || member.id === recipientId)).slice(0, 6);
  const replyAuthor = replyTo ? replyTo.senderId === user.id ? "You" : members.find((member) => member.id === replyTo.senderId)?.fullName ?? "Team member" : "";

  const openImagePreview = (src: string, name: string) => {
    imagePreviewReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setImagePreview({ src, name });
  };

  useEffect(() => {
    if (!imagePreview) return;
    const previousOverflow = document.body.style.overflow;
    const returnFocus = imagePreviewReturnFocusRef.current;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setImagePreview(null);
      if (event.key === "Tab") {
        event.preventDefault();
        imagePreviewCloseRef.current?.focus();
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    imagePreviewCloseRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      returnFocus?.focus();
      imagePreviewReturnFocusRef.current = null;
    };
  }, [imagePreview]);

  useEffect(() => {
    if (conversationType === "direct" && !recipientId) return;
    let active = true;
    let firstLoad = true;
    let refreshing = false;
    knownMessageIds.current = null;
    shouldScrollToBottom.current = true;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      if (firstLoad) setLoading(true);
      const params = new URLSearchParams({ conversationType });
      if (conversationType === "direct") params.set("recipientId", recipientId);
      try {
        const response = await fetch(`/api/chat?${params.toString()}`, { cache: "no-store" });
        const body = await response.json() as { members?: ChatMember[]; messages?: ChatMessage[]; error?: string };
        if (!response.ok) throw new Error(body.error || "Chat could not be loaded.");
        if (!active) return;
        const nextMessages = body.messages ?? [];
        const previousIds = knownMessageIds.current;
        const hasNewMessages = previousIds !== null && nextMessages.some((message) => !previousIds.has(message.id));
        const messagesChanged = previousIds === null || nextMessages.length !== previousIds.size || hasNewMessages;
        if (previousIds) {
          const arrivals = nextMessages.filter((message) => !previousIds.has(message.id)).map((message) => message.id);
          if (arrivals.length) {
            setFreshMessageIds((current) => new Set([...current, ...arrivals]));
            if (freshMessageTimer.current !== null) window.clearTimeout(freshMessageTimer.current);
            freshMessageTimer.current = window.setTimeout(() => setFreshMessageIds(new Set()), 900);
          }
        }
        knownMessageIds.current = new Set(nextMessages.map((message) => message.id));
        setMembers(body.members ?? []);
        if (messagesChanged) {
          const shouldFollow = previousIds === null || isAtBottom.current;
          if (shouldFollow) shouldScrollToBottom.current = true;
          setMessages(nextMessages);
        }
        setError("");
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Chat could not be loaded.");
      } finally {
        refreshing = false;
        if (firstLoad) { firstLoad = false; if (active) setLoading(false); }
      }
    };
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 3_000);
    return () => { active = false; window.clearInterval(timer); if (freshMessageTimer.current !== null) window.clearTimeout(freshMessageTimer.current); };
  }, [conversationType, recipientId]);

  useEffect(() => {
    let active = true;
    const refreshUnread = async () => {
      try {
        const response = await fetch("/api/chat?summary=1&unread=1", { cache: "no-store" });
        if (!response.ok) return;
        const result = await response.json() as { all?: number; direct?: Record<string, number> };
        if (active) setUnreadCounts({ all: result.all ?? 0, direct: result.direct ?? {} });
      } catch { /* The current conversation remains usable while unread counts refresh. */ }
    };
    void refreshUnread();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refreshUnread(); }, 3_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [user.id]);

  useEffect(() => {
    let active = true;
    const checkPush = async () => {
      if (mode !== "supabase" || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
      try {
        const response = await fetch("/api/chat/push", { cache: "no-store" });
        const result = await response.json() as { available?: boolean };
        if (!active) return;
        setPushAvailable(Boolean(result.available));
        if (result.available) {
          const registration = await navigator.serviceWorker.ready;
          setPushEnabled(Boolean(await registration.pushManager.getSubscription()));
        }
      } catch { /* Phone push remains optional if this device or server cannot register it. */ }
    };
    void checkPush();
    return () => { active = false; };
  }, [mode]);

  useEffect(() => {
    if (!shouldScrollToBottom.current) return;
    shouldScrollToBottom.current = false;
    const container = messagesRef.current;
    if (container) requestAnimationFrame(() => container.scrollTo({ top: container.scrollHeight, behavior: "smooth" }));
  }, [messages]);

  const updateScrollPosition = () => {
    const container = messagesRef.current;
    if (!container) return;
    isAtBottom.current = container.scrollHeight - container.clientHeight - container.scrollTop < 72;
  };

  const updateMentionQuery = (value: string, cursor: number) => {
    const before = value.slice(0, cursor);
    const trigger = before.match(/(?:^|\s)@([\p{L}\p{N} .'-]*)$/u);
    setMentionQuery(trigger ? trigger[1].trimStart() : null);
  };

  const insertMention = (member: ChatMember) => {
    const input = messageInputRef.current;
    const cursor = input?.selectionStart ?? draft.length;
    const before = draft.slice(0, cursor);
    const match = before.match(/(?:^|\s)@([\p{L}\p{N} .'-]*)$/u);
    if (!match) return;
    const start = before.length - match[0].length + match[0].lastIndexOf("@");
    const value = `${draft.slice(0, start)}@${member.fullName} ${draft.slice(cursor)}`;
    setDraft(value);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      const nextCursor = start + member.fullName.length + 2;
      messageInputRef.current?.focus();
      messageInputRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const saveMessageEdit = async (event: FormEvent<HTMLFormElement>, messageId: string) => {
    event.preventDefault();
    const body = editDraft.trim();
    if (!body) return;
    try {
      const response = await fetch("/api/chat", { method: "PATCH", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messageId, body }) });
      const result = await response.json() as { message?: ChatMessage; error?: string; warning?: string };
      if (!response.ok || !result.message) throw new Error(result.error || "Message could not be edited.");
      setMessages((current) => current.map((message) => message.id === messageId ? { ...result.message!, receipts: message.receipts } : message));
      setEditingMessageId(null);
      setEditDraft("");
      if (result.warning) setError(result.warning);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Message could not be edited."); }
  };

  const enablePhoneAlerts = async () => {
    setPushBusy(true); setPushMessage("");
    try {
      if (Notification.permission === "denied") throw new Error("Notifications are blocked in this device’s browser settings.");
      const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Allow notifications to receive @mention alerts on this device.");
      const keyResponse = await fetch("/api/chat/push", { cache: "no-store" });
      const keyResult = await keyResponse.json() as { publicKey?: string; available?: boolean };
      if (!keyResponse.ok || !keyResult.publicKey) throw new Error("Phone alerts are not configured on the app yet.");
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodePushKey(keyResult.publicKey) });
      const response = await fetch("/api/chat/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(subscription.toJSON()) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "This device could not be registered.");
      setPushEnabled(true); setPushMessage("This device will show @mention alerts when the app is closed.");
    } catch (cause) { setPushMessage(cause instanceof Error ? cause.message : "Phone alerts could not be enabled."); }
    finally { setPushBusy(false); }
  };

  const disablePhoneAlerts = async () => {
    setPushBusy(true); setPushMessage("");
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await fetch("/api/chat/push", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: subscription.endpoint }) });
        await subscription.unsubscribe();
      }
      setPushEnabled(false);
    } catch (cause) { setPushMessage(cause instanceof Error ? cause.message : "Phone alerts could not be disabled."); }
    finally { setPushBusy(false); }
  };

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = draft.trim();
    if ((!body && !pendingAttachments.length) || sendingRef.current || uploadingFiles || (conversationType === "direct" && !recipientId)) return;
    sendingRef.current = true;
    setSending(true);
    setError("");
    try {
      const response = await fetch("/api/chat", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationType, recipientId: conversationType === "direct" ? recipientId : undefined, body, replyToId: replyTo?.id, attachments: pendingAttachments }) });
      const result = await response.json() as { message?: ChatMessage; error?: string; warning?: string };
      if (!response.ok || !result.message) throw new Error(result.error || "Message could not be sent.");
      knownMessageIds.current?.add(result.message.id);
      setFreshMessageIds((current) => new Set([...current, result.message!.id]));
      if (freshMessageTimer.current !== null) window.clearTimeout(freshMessageTimer.current);
      freshMessageTimer.current = window.setTimeout(() => setFreshMessageIds(new Set()), 900);
      shouldScrollToBottom.current = true;
      isAtBottom.current = true;
      setMessages((current) => current.some((message) => message.id === result.message!.id) ? current : [...current, result.message!]);
      setDraft("");
      setPendingAttachments([]);
      setReplyTo(null);
      setMentionQuery(null);
      if (result.warning) setError(result.warning);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Message could not be sent."); }
    finally { sendingRef.current = false; setSending(false); }
  };

  const attachFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (!files.length) return;
    setUploadingFiles(true); setError("");
    try {
      const next: ChatAttachment[] = [];
      for (const original of files) {
        const file = await prepareChatFile(original);
        if (mode === "demo") {
          if (file.size > 2_000_000) throw new Error("Local demo attachments must be 2 MB or smaller. Use the connected app for larger files.");
          next.push({ dataUrl: await fileAsDataUrl(file), name: file.name, type: file.type, size: file.size });
        } else {
          const form = new FormData(); form.append("file", file);
          const response = await fetch("/api/chat/media", { method: "POST", body: form, cache: "no-store" });
          const result = await response.json() as { attachment?: ChatAttachment; error?: string };
          if (!response.ok || !result.attachment) throw new Error(result.error ?? `Could not upload ${file.name}.`);
          next.push(result.attachment);
        }
      }
      setPendingAttachments((current) => [...current, ...next]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Files could not be attached."); }
    finally { setUploadingFiles(false); }
  };

  return <>
    <section className="panel crew-chat-panel">
      <div className="crew-chat-toolbar"><div className="crew-chat-rooms" role="tablist" aria-label="Chat conversations">
        <button type="button" role="tab" aria-selected={conversationType === "all"} className={`crew-chat-room-button ${conversationType === "all" ? "is-active" : ""}`} onClick={() => { setMessages([]); setFreshMessageIds(new Set()); setLoading(true); setConversationType("all"); setRecipientId(""); setReplyTo(null); }}><Users size={16} /><span><strong>All chat</strong><small>Everyone on the crew</small></span>{unreadCounts.all > 0 && <b className="chat-unread-count">{unreadCounts.all > 99 ? "99+" : unreadCounts.all}</b>}</button>
        {members.map((member) => { const unread = unreadCounts.direct[member.id] ?? 0; const active = conversationType === "direct" && recipientId === member.id; return <button type="button" role="tab" aria-selected={active} className={`crew-chat-room-button crew-chat-person-room ${active ? "is-active" : ""}`} key={member.id} onClick={() => { setMessages([]); setFreshMessageIds(new Set()); setLoading(true); setRecipientId(member.id); setConversationType("direct"); setReplyTo(null); }}><ProfileAvatar name={member.fullName} src={member.avatarUrl} className="chat-room-avatar" /><span><strong>{member.fullName}</strong><small>{member.jobTitle || member.role}</small></span>{unread > 0 && <b className="chat-unread-count">{unread > 99 ? "99+" : unread}</b>}</button>; })}
      </div></div>
      {mode === "supabase" && <div className="chat-alert-settings"><div><strong>Phone and device alerts</strong><small>{pushEnabled ? "This device is registered for new @mentions." : "Get a device notification when someone @mentions you, even when the app is closed."}</small></div>{pushAvailable && <button type="button" className="button button-small button-quiet" disabled={pushBusy} onClick={() => void (pushEnabled ? disablePhoneAlerts() : enablePhoneAlerts())}>{pushBusy ? "Saving…" : pushEnabled ? "Turn off" : "Enable phone alerts"}</button>}</div>}{pushMessage && <p className="chat-push-status" role="status">{pushMessage}</p>}
      <div className="crew-chat-heading"><div>{conversationType === "all" ? <><span className="eyebrow">TEAM ROOM</span><h3>All chat</h3></> : <><ProfileAvatar name={recipient?.fullName ?? "Team member"} src={recipient?.avatarUrl} className="chat-heading-avatar" /><span><h3>{recipient?.fullName ?? "Direct chat"}</h3><small>{recipient?.jobTitle || recipient?.role || "Team member"}</small></span></>}</div><span className="chat-live-indicator"><i />Updates automatically</span></div>
      <div ref={messagesRef} onScroll={updateScrollPosition} className="crew-chat-messages" aria-live="polite" aria-label={conversationType === "all" ? "All crew messages" : `Messages with ${recipient?.fullName ?? "team member"}`}>
        {conversationType === "direct" && !recipientId ? <div className="crew-chat-empty">Choose a team member to start a direct chat.</div> : loading ? <div className="crew-chat-empty">Loading messages…</div> : messages.length ? messages.map((message) => {
          const isOwn = message.senderId === user.id;
          const author = isOwn ? user : members.find((member) => member.id === message.senderId);
          const receiptAudience = conversationType === "direct" ? members.filter((member) => member.id === recipientId) : members;
          const readIds = new Set((message.receipts ?? []).map((receipt) => receipt.userId));
          const seenMembers = receiptAudience.filter((member) => readIds.has(member.id));
          const unseenMembers = receiptAudience.filter((member) => !readIds.has(member.id));
          return <article key={message.id} className={`chat-message-row ${isOwn ? "is-own" : ""} ${freshMessageIds.has(message.id) ? "is-new-arrival" : ""}`}>
            <ProfileAvatar name={author?.fullName ?? "Team member"} src={author?.avatarUrl} className="chat-avatar" />
             <div className="chat-message-content"><div className="chat-message-meta"><strong>{isOwn ? "You" : author?.fullName ?? "Team member"}</strong><time dateTime={message.createdAt}>{formatStamp(message.createdAt)}</time></div>
               {message.reply && <div className="chat-reply-quote"><strong>{message.reply.senderId === user.id ? "You" : members.find((member) => member.id === message.reply?.senderId)?.fullName ?? "Team member"}</strong><span>{message.reply.body || "Attachment"}</span></div>}
                {message.body && (editingMessageId === message.id ? <form className="chat-message-edit-form" onSubmit={(event) => void saveMessageEdit(event, message.id)}><textarea aria-label="Edit message" maxLength={2000} value={editDraft} onChange={(event) => setEditDraft(event.currentTarget.value)} autoFocus /><div><button type="button" className="button button-small button-quiet" onClick={() => { setEditingMessageId(null); setEditDraft(""); }}>Cancel</button><button type="submit" className="button button-small button-primary" disabled={!editDraft.trim()}>Save edit</button></div></form> : <ChatMessageText body={message.body} members={members} />)}
               {message.attachments?.length ? <div className="chat-attachment-list">{message.attachments.map((attachment, index) => <ChatAttachmentPreview attachment={attachment} onOpenImage={openImagePreview} key={`${message.id}-file-${index}`} />)}</div> : null}
                <div className="chat-message-footer"><button type="button" className="chat-reply-button" onClick={() => setReplyTo(message)}><Reply size={13} />Reply</button>{message.editedAt && <small className="chat-edited-label">Edited</small>}{isOwn && <><details className="chat-message-menu"><summary className="icon-button" aria-label="Message options"><MoreVertical size={15} /></summary><div><button type="button" onClick={(event) => { const menu = event.currentTarget.closest("details"); if (menu) menu.open = false; setEditingMessageId(message.id); setEditDraft(message.body); }}>Edit message</button></div></details><details className="chat-reader-details"><summary className="chat-readers" aria-label={`${seenMembers.length} seen, ${unseenMembers.length} not seen`}>{seenMembers.slice(0, 3).map((reader) => <ProfileAvatar key={reader.id} name={reader.fullName} src={reader.avatarUrl} className="chat-reader-avatar" />)}{seenMembers.length > 3 && <span className="chat-reader-overflow">+{seenMembers.length - 3}</span>}<small>{seenMembers.length ? `${seenMembers.length} seen` : "Sent"}</small></summary><div className="chat-reader-popover"><div><strong>Seen</strong><span>{seenMembers.map((reader) => reader.fullName).join(", ") || "No one yet"}</span></div><div><strong>Not seen</strong><span>{unseenMembers.map((reader) => reader.fullName).join(", ") || "Everyone has seen it"}</span></div></div></details></>}</div>
             </div>
          </article>;
        }) : <div className="crew-chat-empty"><MessageCircle size={22} /><strong>{conversationType === "all" ? "Start the crew conversation" : "No messages yet"}<small>Send a message to get the conversation started.</small></strong></div>}
      </div>
      {error && <p className="crew-chat-error" role="alert">{error}</p>}
      {replyTo && <div className="chat-reply-composer"><span><strong>Replying to {replyAuthor}</strong><small>{replyTo.body || "Attachment"}</small></span><button type="button" className="icon-button" onClick={() => setReplyTo(null)} aria-label="Cancel reply"><X size={15} /></button></div>}
      {pendingAttachments.length > 0 && <div className="chat-pending-files">{pendingAttachments.map((attachment, index) => <div className="chat-pending-file" key={`${attachment.name}-${index}`}><span>{attachment.name} · {formatFileSize(attachment.size)}</span><button type="button" className="icon-button" aria-label={`Remove ${attachment.name}`} onClick={() => setPendingAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={14} /></button></div>)}</div>}
      <form className="crew-chat-composer" onSubmit={sendMessage}><label className="chat-attach-button" title="Attach photos, videos, audio, or files"><Paperclip size={18} /><input aria-label="Attach photos, videos, audio, or files" type="file" multiple accept=".jpg,.jpeg,.png,.webp,.gif,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/mp4,.m4a,.mp3,.pdf,.heic,.heif" onChange={attachFiles} /></label><div className="chat-composer-textarea-wrap">{mentionQuery !== null && mentionCandidates.length > 0 && <div className="chat-mention-menu" role="listbox" aria-label="Mention a crew member">{mentionCandidates.map((member) => <button type="button" role="option" aria-selected="false" key={member.id} onMouseDown={(event) => event.preventDefault()} onClick={() => insertMention(member)}><ProfileAvatar name={member.fullName} src={member.avatarUrl} className="chat-room-avatar" /><span><strong>{member.fullName}</strong><small>{member.jobTitle || member.role}</small></span></button>)}</div>}<textarea ref={messageInputRef} aria-label="Write a message" maxLength={2000} placeholder={conversationType === "direct" && !recipientId ? "Choose a team member first" : "Write a message… use @name to notify someone"} value={draft} onChange={(event) => { setDraft(event.currentTarget.value); updateMentionQuery(event.currentTarget.value, event.currentTarget.selectionStart); }} onClick={(event) => updateMentionQuery(event.currentTarget.value, event.currentTarget.selectionStart)} disabled={conversationType === "direct" && !recipientId} /></div><button className="button button-primary" type="submit" disabled={sending || uploadingFiles || (!draft.trim() && !pendingAttachments.length) || (conversationType === "direct" && !recipientId)}><Send size={15} />{uploadingFiles ? "Uploading…" : sending ? "Sending…" : "Send"}</button></form>
    </section>
    {imagePreview && <div className="chat-image-lightbox" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setImagePreview(null); }}><section className="chat-image-lightbox-dialog" role="dialog" aria-modal="true" aria-label={`Image preview: ${imagePreview.name}`}><button ref={imagePreviewCloseRef} type="button" className="icon-button chat-image-lightbox-close" aria-label="Close image preview" onClick={() => setImagePreview(null)}><X size={20} /></button><div className="chat-image-lightbox-frame"><NextImage unoptimized fill sizes="92vw" src={imagePreview.src} alt={imagePreview.name} className="chat-image-lightbox-image" /></div><p className="chat-image-lightbox-name">{imagePreview.name}</p></section></div>}
  </>;
}

function Dashboard({ data, user, setPage, currentTime }: { data: AppData; user: Profile; setPage: (page: PageKey) => void; currentTime: number }) {
  const manager = hasManagerAccess(user.accessRoles, user.role);
  const checklistItems = data.checklistItems.filter((item) => manager || item.userId === user.id);
  const openChecks = checklistItems.filter((item) => item.status !== "Complete");
  const requiredChecks = checklistItems.filter((item) => item.required);
  const completedChecks = requiredChecks.filter((item) => item.status === "Complete").length;
  const attentionEvents = data.events.filter((event) => ["Planning", "Published"].includes(event.status)).map((event) => ({ event, readiness: eventReadiness(event, data.checklistItems) })).filter(({ readiness }) => readiness.label === "Needs attention");
  const events = [...data.events].filter((event) => event.status !== "Cancelled" && event.date >= new Date().toISOString().slice(0, 10)).sort((a, b) => a.date.localeCompare(b.date));
  const overdue = data.loans.filter((item) => !item.returnAt && item.dueDate && new Date(`${item.dueDate}T23:59:59`) < new Date()).length;
  const openIncidents = data.incidents.filter((item) => !["Resolved", "Closed"].includes(item.status));
  const notificationCutoff = currentTime - 24 * 60 * 60 * 1000;
  const unread = data.notifications.filter((item) => item.userId === user.id && !item.read && (!manager || Date.parse(item.date) >= notificationCutoff));
  const myTasks = data.checklistItems.filter((item) => item.userId === user.id);
  const myServiceTasks = myTasks.filter((item) => !item.serviceHistoryHidden);
  const myAssignments = data.assignments.filter((item) => item.userId === user.id && !item.serviceHistoryHidden);
  const eventsServed = new Set(myAssignments.flatMap((assignment) => {
    const event = data.events.find((item) => item.id === assignment.eventId);
    return event && (event.status === "Completed" || event.date < localCalendarDate()) ? [event.id] : [];
  })).size;
  const personalTaskRate = myServiceTasks.length ? Math.round(myServiceTasks.filter((item) => item.status === "Complete").length / myServiceTasks.length * 100) : 0;
  const personalIncidentCount = data.incidents.filter((item) => item.reportedBy === user.id).length;
  return <>
    <div className="welcome-line"><div><h2>{manager ? "Good to see you" : `Welcome, ${user.fullName.split(" ")[0]}`}</h2><p>{manager ? "Align the crew and keep every upcoming program in flow — all in one command center." : "Your next steps, surfaced — so the team keeps moving in sync."}</p></div><span className="today-chip"><Clock3 size={14} /> {new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span></div>
    <div className="metric-grid">
      <Metric label="Upcoming events" value={events.length} icon={CalendarDays} trend="Scheduled programs" tone="blue" />
      <Metric label={manager ? "Open checklist items" : "My open checklist items"} value={openChecks.length} icon={CheckCircle2} trend="Assigned directly to each person" tone="green" />
      <Metric label="Checklists completed" value={checklistItems.filter((item) => item.status === "Complete").length} icon={ClipboardCheck} trend="Completed tasks on record" tone="amber" />
      <Metric label="Open incidents" value={openIncidents.length} icon={Activity} trend={overdue ? `${overdue} overdue equipment return${overdue > 1 ? "s" : ""}` : "No overdue returns"} tone="rose" />
    </div>
    <div className="dashboard-grid">
      <section className="panel dashboard-events"><div className="panel-heading"><div><span className="eyebrow">PRODUCTION SCHEDULE</span><h3>Upcoming events</h3></div><button className="text-button" onClick={() => setPage("events")}>View schedule <ArrowRight size={14} /></button></div>
        {events.length ? <div className="compact-event-list">{events.slice(0, 4).map((event) => <EventRow key={event.id} event={event} data={data} onClick={() => setPage("events")} />)}</div> : <EmptyState icon={CalendarDays} title="No upcoming events" detail="Scheduled programs will appear here." />}
      </section>
      <section className="panel attention-panel"><div className="panel-heading"><div><span className="eyebrow">YOUR CHECKLIST</span><h3>{manager ? "Team checklist" : "My checklist"}</h3></div><button className="text-button" onClick={() => setPage("checklists")}>Open checklists <ArrowRight size={14} /></button></div>
        {openChecks.length ? <div className="attention-list">{openChecks.slice(0, 5).map((item) => <button key={item.id} className="attention-item" onClick={() => setPage("checklists")}><span className="attention-icon"><ClipboardCheck size={16} /></span><span><strong>{item.label}</strong><small>{data.events.find((event) => event.id === item.eventId)?.title ?? "Checklist"}{manager ? ` · ${data.profiles.find((person) => person.id === item.userId)?.fullName ?? "Team member"}` : ""}</small></span><ArrowRight size={14} /></button>)}</div> : <EmptyState icon={CheckCircle2} title="All clear" detail="No open checklist items." />}
      </section>
    </div>
    <div className="dashboard-grid lower-grid">
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">READINESS</span><h3>Checklist completion</h3></div><button className="text-button" onClick={() => setPage("checklists")}>Open checklists <ArrowRight size={14} /></button></div><div className="progress-summary"><div className="progress-number">{completedChecks}<span> / {requiredChecks.length}</span></div><span>required checks complete</span></div><div className="progress-track"><span style={{ width: `${requiredChecks.length ? Math.round(completedChecks / requiredChecks.length * 100) : 0}%` }} /></div><div className="submetric-row"><span>Unread notices</span><strong>{unread.length}</strong></div></section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">MEDIA KIT</span><h3>Equipment status</h3></div><button className="text-button" onClick={() => setPage("equipment")}>Inventory <ArrowRight size={14} /></button></div><div className="equipment-summary"><div><span className="equipment-dot available" />Available<strong>{data.assets.filter((item) => item.status === "Available").length}</strong></div><div><span className="equipment-dot attention" />Attention<strong>{data.assets.filter((item) => ["Under maintenance", "Damaged", "Missing"].includes(item.status)).length}</strong></div><div><span className="equipment-dot checked" />Checked out<strong>{data.assets.filter((item) => item.status === "Checked out").length}</strong></div></div><div className="submetric-row"><span>Overdue returns</span><strong className={overdue ? "danger-text" : ""}>{overdue}</strong></div></section>
    </div>
    {attentionEvents.length > 0 && <section className="panel attention-panel dashboard-attention"><div className="panel-heading"><div><span className="eyebrow">FOLLOW UP</span><h3>Events needing attention</h3></div><StatusPill tone="warning">{attentionEvents.length} open</StatusPill></div><div className="attention-list">{attentionEvents.slice(0, 4).map(({ event, readiness }) => <button key={event.id} className="attention-item" onClick={() => setPage("events")}><span className="attention-icon"><AlertTriangle size={16} /></span><span><strong>{event.title}</strong><small>{displayDate(event.date)} · {readiness.reasons[0] ?? readiness.label}</small></span><ArrowRight size={14} /></button>)}</div></section>}
    <section className="panel personal-report-panel"><div className="panel-heading"><div><span className="eyebrow">YOUR ACTIVITY</span><h3>Your service history</h3></div><span className="today-chip">All time</span></div><div className="personal-report-grid"><div><span>Events served</span><strong>{eventsServed}</strong></div><div><span>Tasks completed</span><strong>{myServiceTasks.filter((item) => item.status === "Complete").length}</strong><small>{myServiceTasks.length} assigned total</small></div><div><span>Checklist completion</span><strong>{personalTaskRate}%</strong></div><div><span>Incident reports</span><strong>{personalIncidentCount}</strong></div></div><p className="personal-report-note">Totals use the event, checklist, and incident records currently saved in the app.</p></section>
  </>;
}

function Metric({ label, value, icon: Icon, trend, tone }: { label: string; value: ReactNode; icon: typeof Activity; trend: string; tone: string }) { return <div className="metric-card"><div className={`metric-icon icon-${tone}`}><Icon size={18} /></div><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong><small>{trend}</small></div>; }

function EventRow({ event, data, onClick }: { event: MediaEvent; data: AppData; onClick: () => void }) {
  const count = data.checklistItems.filter((item) => item.eventId === event.id).length;
  const statusTone = event.status === "Published" ? "success" : event.status === "Completed" ? "neutral" : event.status === "Cancelled" ? "danger" : "warning";
  return <button className="compact-event" onClick={onClick}><span className="event-date"><strong>{new Date(`${event.date}T12:00:00`).toLocaleDateString(undefined, { day: "2-digit" })}</strong><small>{new Date(`${event.date}T12:00:00`).toLocaleDateString(undefined, { month: "short" }).toUpperCase()}</small></span><span className="compact-event-main"><strong>{event.title}</strong><small>{event.category} · {event.venue} · {eventTimeRange(event)} · {event.programPhase ?? phaseOptions(data)[0]}</small></span><span className="compact-event-side"><StatusPill tone={statusTone}>{event.status}</StatusPill><small><ClipboardCheck size={12} />{count} checklist items</small></span><ArrowRight size={15} className="row-arrow" /></button>;
}

function EventsPage({ data, user, searchMatch, openModal, run }: { data: AppData; user: Profile; searchMatch: (value: string) => boolean; openModal: (state: ModalState) => void; run: (action: string, payload?: Record<string, unknown>) => Promise<void> }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "calendar">("list");
  const [visibleEventCount, setVisibleEventCount] = useState(6);
  const [month, setMonth] = useState(() => { const date = new Date(); return new Date(date.getFullYear(), date.getMonth(), 1); });
  const events = [...data.events].filter((event) => searchMatch(`${event.title} ${event.category} ${event.venue} ${event.date}`)).sort((a, b) => a.date.localeCompare(b.date));
  const visibleEvents = events.slice(0, visibleEventCount);
  const manage = can(user.accessRoles ?? user.role, "manage_events");
  const admin = hasManagerAccess(user.accessRoles, user.role);
  const canEditCategories = admin || hasAccessRole(user.accessRoles, user.role, "Equipment Manager");
  return <>
    <PageIntro title="Production schedule" detail="Event times use the local timezone for each venue. Open an event to review the program details and checklist readiness." />
    <div className="filter-row"><div className="segmented-control"><button className={view === "list" ? "selected" : ""} onClick={() => setView("list")}><CalendarDays size={15} />List</button><button className={view === "calendar" ? "selected" : ""} onClick={() => setView("calendar")}><CalendarDays size={15} />Calendar</button></div><div className="filter-note"><span className="equipment-dot available" />{events.length} event{events.length === 1 ? "" : "s"} in view</div>{canEditCategories && <CategoryManagerButton kind="events" openModal={openModal} />}</div>
    {view === "calendar" ? <section className="panel event-calendar"><div className="calendar-heading"><button className="button button-small button-quiet" onClick={() => setMonth((value) => new Date(value.getFullYear(), value.getMonth() - 1, 1))}>Previous</button><h3>{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h3><button className="button button-small button-quiet" onClick={() => setMonth((value) => new Date(value.getFullYear(), value.getMonth() + 1, 1))}>Next</button></div><div className="calendar-grid">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <span className="calendar-weekday" key={day}>{day}</span>)}{Array.from({ length: 42 }, (_, index) => { const date = new Date(month.getFullYear(), month.getMonth(), 1 - month.getDay() + index); const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; const dayEvents = events.filter((event) => event.date === dateKey); return <div className={`calendar-day ${date.getMonth() !== month.getMonth() ? "outside-month" : ""}`} key={dateKey}><span>{date.getDate()}</span>{dayEvents.map((event) => <button key={event.id} title={`${event.title} · ${event.category}`} onClick={() => openModal({ type: "show-event", id: event.id })}>{event.title}</button>)}</div>; })}</div></section> : events.length ? <><div className="event-list-view">{visibleEvents.map((event) => {
      const open = selected === event.id;
      const checklistCount = data.checklistItems.filter((item) => item.eventId === event.id).length;
      const readiness = eventReadiness(event, data.checklistItems);
      const eventLead = data.profiles.find((person) => person.id === event.leadId);
      const eventCrew = data.assignments.filter((assignment) => assignment.eventId === event.id);
      const myAssignment = eventCrew.find((assignment) => assignment.userId === user.id);
      
      return <section className={`event-card ${open ? "event-card-open" : ""}`} key={event.id}>
        <button className="event-card-main" onClick={() => setSelected(open ? null : event.id)} aria-expanded={open}>
          <span className="event-date-large"><strong>{new Date(`${event.date}T12:00:00`).toLocaleDateString(undefined, { day: "2-digit" })}</strong><small>{new Date(`${event.date}T12:00:00`).toLocaleDateString(undefined, { month: "short" }).toUpperCase()}</small></span>
          <span className="event-title-block"><span className="event-title-line"><strong>{event.title}</strong><StatusPill tone={event.status === "Published" ? "success" : event.status === "Completed" ? "neutral" : "warning"}>{event.status}</StatusPill><span className="program-phase-badge"><Clock3 size={12} />{event.programPhase ?? phaseOptions(data)[0]}</span></span><span>{event.category} <i>·</i> {event.venue} <i>·</i> {eventTimeRange(event)} · {event.timeZone}</span></span>
          <span className="event-badges">{event.livestream && <span title="Livestream required"><Radio size={15} /></span>}{event.recording && <span title="Recording required"><Video size={15} /></span>}{event.photography && <span title="Photography required"><CameraIcon /></span>}</span>
          <span className="event-count"><ClipboardCheck size={15} />{checklistCount} checks</span><StatusPill tone={readiness.tone}>{readiness.label}</StatusPill><ChevronDown size={17} className={`expand-chevron ${open ? "rotated" : ""}`} />
        </button>
        {open && (
          <div className="event-expanded">
            <div className="event-description">
              <p>{event.description || event.publicInfo || "No description has been added."}</p>
              <div className="event-details-grid">
                <span><small>SETUP · {event.timeZone}</small><strong>{displayTime(event.setupTime)}</strong></span>
                <span><small>EVENT LEAD</small><strong>{eventLead?.fullName ?? "Unassigned"}</strong></span>
                <span><small>PRODUCTION</small><strong>{[event.livestream && "Livestream", event.recording && "Recording", event.photography && "Photography"].filter(Boolean).join(" · ") || "Standard coverage"}</strong></span>
                 <span><small>CURRENT PROGRAM PHASE</small><strong>{event.programPhase ?? phaseOptions(data)[0]}</strong></span>
                 <span><small>PROGRAM STATUS</small><strong>{event.startedAt ? `Started ${formatStamp(event.startedAt)}` : "Not started"}{event.endedAt ? ` · Ended ${formatStamp(event.endedAt)}` : ""}</strong></span>
                {manage && <div className="program-phase-picker-field"><span>Change program phase</span><ProgramPhaseButtons data={data} event={event} onSelect={(phase) => void run("set_event_program_phase", { eventId: event.id, programPhase: phase })} /><small>Required checklist tasks from earlier phases become urgent.</small></div>}
                <div className="event-crew-assignment">
                  <small>CREW ATTENDANCE · {eventCrew.filter((assignment) => assignment.response === "Accepted").length} attending · {eventCrew.filter((assignment) => assignment.response === "Declined").length} not attending · {eventCrew.filter((assignment) => assignment.response === "Pending").length} awaiting</small>
                  {eventCrew.length ? <div className="event-crew-list">{eventCrew.map((assignment) => {
                    const person = data.profiles.find((item) => item.id === assignment.userId);
                    return <div className="event-crew-line" key={assignment.id}>
                      <span>{person?.fullName ?? assignment.roleName}<small>{assignment.roleName}</small></span>
                      {<StatusPill tone={assignment.response === "Accepted" ? "success" : assignment.response === "Declined" ? "danger" : "warning"}>{assignment.response === "Accepted" ? "Attending" : assignment.response === "Declined" ? "Not attending" : "No response"}</StatusPill>}
                    </div>;
                  })}</div> : <span className="subtle-empty">No crew selected</span>}
                </div>
              </div>
              {event.privateNotes && isStaff(user.role) && <div className="private-note"><ShieldCheck size={15} /><span><small>INTERNAL NOTE</small>{event.privateNotes}</span></div>}
              {event.publicInfo && !isStaff(user.role) && <div className="public-note">{event.publicInfo}</div>}
            </div>
            <div className="event-actions">
              {myAssignment && event.status === "Published" && <div className="rsvp-actions">
                <span>{myAssignment.response === "Accepted" ? "You’re attending" : myAssignment.response === "Declined" ? "You can’t attend" : "Can you attend?"}</span>
                <div className="rsvp-buttons">
                  <button className={"button button-small " + (myAssignment.response === "Accepted" ? "button-primary" : "button-quiet")} onClick={() => void run("set_event_response", { assignmentId: myAssignment.id, response: "Accepted" })}>I can attend</button>
                  <button className={"button button-small " + (myAssignment.response === "Declined" ? "button-danger" : "button-quiet")} onClick={() => void run("set_event_response", { assignmentId: myAssignment.id, response: "Declined" })}>I can’t attend</button>
                </div>
              </div>}
              <div className="event-management-actions">
                {manage && event.status === "Published" && !event.startedAt && <button className="button button-small button-primary event-action-button" onClick={() => void run("start_event_program", { eventId: event.id })}>Start program</button>}
                {manage && event.status === "Published" && event.startedAt && !event.endedAt && <button className="button button-small button-danger event-action-button" onClick={() => { if (window.confirm(`End the program “${event.title}” and notify its crew?`)) void run("end_event_program", { eventId: event.id }); }}>End program</button>}
                {admin && <button className="button button-small button-quiet event-action-button" onClick={() => openModal({ type: "event-report", id: event.id })}>Event report</button>}
                {manage && event.status !== "Completed" && <button className="button button-small button-quiet event-action-button" onClick={() => openModal({ type: "edit-event", id: event.id })}>Edit</button>}
                {manage && event.status === "Planning" && <button className="button button-small button-primary event-action-button" onClick={() => void run("publish_event", { eventId: event.id })}>Publish</button>}
                {admin && <button className="button button-small button-danger event-action-button" onClick={() => { if (window.confirm('Delete “' + event.title + '”? Its checklist items will be removed. Incident reports will be kept.')) void run("delete_event", { eventId: event.id }); }}>Delete</button>}
                <button className="button button-small button-quiet event-action-button" onClick={() => setSelected(null)}>Close</button>
              </div>
            </div>
          </div>
        )}
      </section>;
    })}</div>{visibleEvents.length < events.length && <div className="event-show-more"><button className="button button-small button-quiet" onClick={() => setVisibleEventCount((count) => count + 6)}>View more events</button></div>}</> : events.length === 0 ? <EmptyState icon={CalendarDays} title="No matching events" detail="Create a production event or adjust the search." /> : null}
  </>;
}

function CameraIcon() { return <Video size={15} />; }

function TeamPage({ data, user, context, openModal, refreshKey }: { data: AppData; user: Profile; context: SessionContext; openModal: (state: ModalState) => void; refreshKey: number }) {
  const [accounts, setAccounts] = useState<TeamAccount[]>([]);
  const [accountsReady, setAccountsReady] = useState(false);
  const [accountError, setAccountError] = useState("");
  const canManageAccounts = hasManagerAccess(user.accessRoles, user.role);
  const administrator = hasAccessRole(user.accessRoles, user.role, "Administrator");
  useEffect(() => {
    if (!canManageAccounts) return;
    let current = true;
    const loadAccounts = async () => {
      setAccountError("");
      try {
        const response = await fetch("/api/admin/team", { cache: "no-store" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Accounts could not be loaded.");
        if (!current) return;
        setAccountsReady(Boolean(result.ready));
        setAccounts(Array.isArray(result.members) ? result.members as TeamAccount[] : []);
      } catch (error) {
        if (current) setAccountError(error instanceof Error ? error.message : "Accounts could not be loaded.");
      }
    };
    void loadAccounts();
    return () => { current = false; };
  }, [canManageAccounts, context.mode, refreshKey]);
  const roleCounts = new Map<string, number>();
  data.profiles.forEach((profile) => (profile.accessRoles ?? [profile.role]).forEach((role) => roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1)));
  const memberRows: TeamAccount[] = accountsReady ? accounts : data.profiles.map((profile) => ({ id: profile.id, fullName: profile.fullName, email: profile.email, username: profile.username ?? "", jobTitle: profile.jobTitle ?? "", avatarUrl: profile.avatarUrl, role: profile.role, accessRoles: profile.accessRoles ?? [profile.role], active: profile.active ?? true, qualification: profile.qualification, lastSignInAt: null }));
  return <><PageIntro title="Team member accounts" detail="Manage team accounts and access roles. Saved passwords are private; administrators can set a new one, and members can change their own." />
    {canManageAccounts && <div className="team-admin-toolbar"><div><strong>Team accounts</strong><span>{accountsReady ? `${accounts.length} sign-in accounts` : "Account setup"}</span></div><div className="team-admin-toolbar-actions">{administrator && <CategoryManagerButton kind="production_roles" openModal={openModal} />}<button className="button button-primary" disabled={!accountsReady} title={!accountsReady ? "Connect the account service to invite team members." : undefined} onClick={() => openModal({ type: "invite-member" })}><Plus size={15} />Add member</button></div></div>}
    {canManageAccounts && !accountsReady && <div className="sop-notice team-account-notice"><ShieldCheck size={17} /><span><strong>Account management is not connected.</strong> Add the server-side account key and apply the team account migration to enable username sign-in and account changes.</span></div>}
    {accountError && <div className="sop-notice team-account-notice"><AlertTriangle size={17} /><span>{accountError}</span></div>}
    <div className="team-role-strip">{accessRoles.map((role) => <div className="team-role-chip" key={role}><strong>{accountsReady ? accounts.filter((item) => (item.accessRoles ?? [item.role]).includes(role)).length : roleCounts.get(role) ?? 0}</strong><span>{role}</span></div>)}</div>
     {memberRows.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>TEAM MEMBER</th><th>PRODUCTION ROLE</th><th>USERNAME</th><th>APP ACCESS ROLES</th>{accountsReady && <><th>PASSWORD / SIGN-IN</th><th>ACTIONS</th></>}</tr></thead><tbody>{memberRows.map((profile) => { const accountState = !profile.active ? "Disabled" : context.mode === "demo" ? "Password set" : profile.lastSignInAt ? "Account active" : "Invitation pending"; const protectedAdministrator = !administrator && (profile.accessRoles ?? [profile.role]).includes("Administrator"); const protectedTitle = protectedAdministrator ? "Only an administrator can change this account." : undefined; return <tr key={profile.id}><td><div className="table-person"><ProfileAvatar name={profile.fullName} src={profile.avatarUrl} className="avatar table-avatar" /><span><strong>{profile.fullName}</strong>{protectedAdministrator && <small className="table-subline">Administrator account · protected</small>}</span></div></td><td>{profile.jobTitle || "—"}</td><td>{profile.username || "—"}</td><td><span className="role-chip">{(profile.accessRoles ?? [profile.role]).join(" · ")}</span>{canManageAccounts && <button className="button button-small button-quiet role-edit-button" disabled={protectedAdministrator} title={protectedTitle} onClick={() => openModal({ type: "edit-member-roles", id: profile.id, member: profile })}>Edit roles</button>}</td>{accountsReady && <><td><StatusPill tone={!profile.active ? "neutral" : profile.lastSignInAt || context.mode === "demo" ? "success" : "warning"}>{accountState}</StatusPill></td><td><div className="team-account-actions"><button className="button button-small button-quiet" disabled={protectedAdministrator} title={protectedTitle} onClick={() => openModal({ type: "edit-member", id: profile.id, member: profile })}>Edit</button>{administrator && <button className="button button-small button-quiet" disabled={!profile.active} onClick={() => openModal({ type: "set-member-password", member: profile })}>Set password</button>}</div></td></>}</tr>; })}</tbody></table></div> : <EmptyState icon={Users} title={canManageAccounts && accountsReady ? "No team accounts yet" : "Team details are restricted"} detail="Add a member with a username and one or more app access roles." />}
  </>;
}

function EquipmentPage({ data, user, searchMatch, openModal, run }: { data: AppData; user: Profile; searchMatch: (value: string) => boolean; openModal: (state: ModalState) => void; run: (action: string, payload?: Record<string, unknown>) => Promise<void> }) {
  const [selectedCategory, setSelectedCategory] = useState("All");
  const equipmentCategories = [...new Set([...(data.categories?.equipment ?? []), ...data.assets.map((asset) => asset.category)])]
    .filter((category) => data.assets.some((asset) => asset.category === category));
  const assets = data.assets.filter((asset) => (selectedCategory === "All" || asset.category === selectedCategory) && searchMatch([asset.assetCode, asset.name, asset.category, asset.location, asset.status].join(" ")));
  const manage = can(user.accessRoles ?? user.role, "manage_equipment");
  const admin = hasManagerAccess(user.accessRoles, user.role) || hasAccessRole(user.accessRoles, user.role, "Equipment Manager");
  const isAdministrator = hasAccessRole(user.accessRoles, user.role, "Administrator");
  const activeLoans = data.loans.filter((item) => !item.returnAt);
  const borrowedUnits = activeLoans.reduce((sum, item) => sum + (item.quantity ?? 1), 0);
  const availableUnits = data.assets.reduce((sum, item) => {
    const borrowed = activeLoans.filter((loanItem) => loanItem.assetId === item.id).reduce((count, loanItem) => count + (loanItem.quantity ?? 1), 0);
    return sum + (item.condition === "Good" && ["Available", "Checked out"].includes(item.status) ? Math.max(0, (item.quantity ?? 1) - borrowed) : 0);
  }, 0);
  return <><PageIntro title="Equipment & inventory" detail="The checkout crew records who is borrowing each item before handing it over, then logs its condition when it comes back." />
    {manage && <section className="panel checklist-template-panel equipment-template-panel"><div className="panel-heading"><div><span className="eyebrow">REUSABLE EQUIPMENT BUNDLES</span><h3>Templates & quick assign</h3></div><button className="button button-primary button-small" disabled={!data.assets.length} onClick={() => openModal({ type: "create-equipment-template" })}><Plus size={14} />New template</button></div>
      {data.equipmentTemplates.length ? <div className="checklist-template-list">{data.equipmentTemplates.map((template) => <article className="checklist-template-row" key={template.id}><div className="checklist-template-copy"><strong>{template.name}</strong><small>{template.items.map((item) => { const asset = data.assets.find((row) => row.id === item.assetId); return `${item.quantity} × ${asset?.name ?? "Removed equipment"}`; }).join(" · ")} · updated {formatStamp(template.updatedAt)}</small></div><div className="checklist-template-actions"><button className="button button-small button-primary" onClick={() => openModal({ type: "quick-assign-equipment", id: template.id })}>Quick assign</button><button className="button button-small button-quiet" onClick={() => openModal({ type: "edit-equipment-template", id: template.id })}>Edit</button><button className="button button-small button-quiet" onClick={() => void run("duplicate_equipment_template", { templateId: template.id })}>Duplicate</button><button className="button button-small button-quiet" onClick={() => { if (window.confirm(`Delete the “${template.name}” template? Existing handoff records will stay unchanged.`)) void run("delete_equipment_template", { templateId: template.id }); }}>Delete</button></div></article>)}</div> : <div className="checklist-template-empty"><HardDrive size={17} /><span><strong>No equipment templates yet</strong><small>Save a reusable group of inventory items and quantities for a quick handoff.</small></span></div>}
      {!data.assets.length && <div className="modal-help">Add equipment to the inventory before creating a template.</div>}
    </section>}
    <div className="inventory-summary"><div className="inventory-summary-card"><span className="equipment-dot available" /><span>Available stock units</span><strong>{availableUnits}</strong></div><div className="inventory-summary-card"><span className="equipment-dot checked" /><span>Inventory records</span><strong>{data.assets.length}</strong></div><div className="inventory-summary-card"><span className="equipment-dot checked" /><span>Borrowed units</span><strong>{borrowedUnits}</strong></div><div className="inventory-summary-card"><span className="equipment-dot attention" /><span>Attention</span><strong>{data.assets.filter((item) => ["Under maintenance", "Damaged", "Missing"].includes(item.status)).length}</strong></div></div>
    <div className="filter-row equipment-category-filter"><div className="category-tabs" aria-label="Filter equipment by category"><button type="button" className={selectedCategory === "All" ? "active" : ""} aria-pressed={selectedCategory === "All"} onClick={() => setSelectedCategory("All")}>All ({data.assets.length})</button>{equipmentCategories.map((category) => <button type="button" className={selectedCategory === category ? "active" : ""} aria-pressed={selectedCategory === category} key={category} onClick={() => setSelectedCategory(category)}>{category} ({data.assets.filter((asset) => asset.category === category).length})</button>)}</div></div>
    <div className="section-divider-title"><span>Asset register</span><small>{assets.length} records</small>{manage && <CategoryManagerButton kind="equipment" openModal={openModal} />}</div>
    {assets.length ? <ShowMoreList items={assets} className="asset-grid" initialCount={10} renderItem={(asset) => {
      const assetLoans = data.loans.filter((item) => item.assetId === asset.id);
      const activeAssetLoans = assetLoans.filter((item) => !item.returnAt);
      const activeBorrowers = activeAssetLoans.map((activeLoan) => ({ loan: activeLoan, profile: data.profiles.find((item) => item.id === activeLoan.borrowerId) }));
      const totalQuantity = asset.quantity ?? 1;
      const borrowedQuantity = activeAssetLoans.reduce((sum, item) => sum + (item.quantity ?? 1), 0);
      const availableQuantity = asset.condition === "Good" && ["Available", "Checked out"].includes(asset.status) ? Math.max(0, totalQuantity - borrowedQuantity) : 0;
      const hasActiveAssetLoan = activeAssetLoans.length > 0;
      const displayStatus = asset.status === "Under maintenance" || asset.status === "Damaged" || asset.status === "Missing" || asset.status === "Retired" ? asset.status : availableQuantity === 0 && borrowedQuantity > 0 ? "Borrowed" : borrowedQuantity > 0 ? "Partially borrowed" : asset.status;
      return <section className="asset-card" key={asset.id}><div className="asset-card-head"><span className="asset-category-icon">{asset.category.toLowerCase().includes("audio") || asset.category.toLowerCase().includes("microphone") ? <Headphones size={19} /> : asset.category.toLowerCase().includes("cable") ? <Wrench size={19} /> : <Video size={19} />}</span><StatusPill tone={displayStatus === "Available" ? "success" : ["Under maintenance", "Damaged", "Missing"].includes(displayStatus) ? "danger" : borrowedQuantity > 0 ? "warning" : "neutral"}>{displayStatus}</StatusPill></div><span className="asset-code">{asset.assetCode} · {asset.category}</span><h3>{asset.name}</h3><div className="asset-spec-row"><span><small>LOCATION</small>{asset.location || "Not recorded"}</span><span><small>CONDITION</small>{asset.condition}</span><span><small>STOCK</small>{totalQuantity} total · {borrowedQuantity} borrowed · {availableQuantity} available</span></div>{asset.model && <p className="asset-notes">{asset.model}{asset.notes ? " · " + asset.notes : ""}</p>}{activeBorrowers.length > 0 && <div className="asset-borrowers"><div className="asset-borrowers-heading"><Users size={14} /><strong>Checked out by</strong></div>{activeBorrowers.map(({ loan: activeLoan, profile }) => <div className="asset-borrower" key={activeLoan.id}><span><strong>{profile?.fullName ?? "Team member"}</strong><small>{activeLoan.quantity ?? 1} unit{(activeLoan.quantity ?? 1) === 1 ? "" : "s"} · {formatStamp(activeLoan.issuedAt)}</small>{activeLoan.checkoutNotes && <small>Handoff details: {activeLoan.checkoutNotes}</small>}</span></div>)}</div>}
        {(manage || admin || (isAdministrator && assetLoans.length > 0)) && <div className="asset-actions">{manage && availableQuantity > 0 && <button className="button button-small button-primary" onClick={() => openModal({ type: "checkout-equipment", id: asset.id })}><ArrowDownToLine size={14} />Log handoff</button>}{manage && activeAssetLoans.map((activeLoan) => { const borrowerName = data.profiles.find((person) => person.id === activeLoan.borrowerId)?.fullName ?? "team member"; return <button key={activeLoan.id} className="button button-small button-quiet" title={`Record return for ${borrowerName}`} onClick={() => openModal({ type: "return-equipment", id: activeLoan.id })}>Return · {borrowerName}</button>; })}{admin && <button className="button button-small button-quiet" onClick={() => openModal({ type: "edit-asset", id: asset.id })}>Edit asset</button>}{isAdministrator && assetLoans.length > 0 && <button className="button button-small button-quiet danger-text" disabled={hasActiveAssetLoan} title={hasActiveAssetLoan ? "Return all current loans before deleting history" : "Delete all borrowing history for this item"} onClick={() => { if (window.confirm(`Delete all ${assetLoans.length} borrowing history record${assetLoans.length === 1 ? "" : "s"} for ${asset.name}? This cannot be undone.`)) void run("delete_equipment_history", { assetId: asset.id }); }}>Delete all history</button>}</div>}
      </section>;
    }} /> : <EmptyState icon={HardDrive} title={selectedCategory === "All" ? "No equipment to show" : `No ${selectedCategory} equipment to show`} detail={manage ? "Add inventory records or adjust your search." : "No equipment loans are linked to your account yet."} />}
    <div className="section-divider-title loan-history-title"><span>Borrowing history</span><small>Person, handoff, and return records</small></div>
    {data.loans.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>ASSET</th><th>QUANTITY</th><th>BORROWER</th><th>ISSUED BY</th><th>HANDOFF / DUE</th><th>RETURN INSPECTION</th><th>STATE</th>{isAdministrator && <th>ADMIN ACTIONS</th>}</tr></thead><tbody>{[...data.loans].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)).map((item) => { const asset = data.assets.find((row) => row.id === item.assetId); const borrower = data.profiles.find((row) => row.id === item.borrowerId); const issuer = data.profiles.find((row) => row.id === item.issuedBy); return <tr key={item.id}><td><strong>{asset?.name ?? "Equipment"}</strong><small className="table-subline">{asset?.assetCode}</small></td><td>{item.quantity ?? 1}</td><td>{borrower?.fullName ?? "Team member"}<small className="table-subline">{borrower?.role}</small></td><td>{issuer?.fullName ?? "Checkout crew"}</td><td>{formatStamp(item.issuedAt)}<small className="table-subline">{item.dueDate ? "Due " + displayDate(item.dueDate) : "No due date"}</small><small className="table-subline">{item.checkoutNotes || "No handoff notes"}</small></td><td>{item.returnAt ? formatStamp(item.returnAt) + " · " + item.returnCondition : "Not returned"}<small className="table-subline">{item.returnNotes ?? ""}</small></td><td><StatusPill tone={item.returnAt ? "success" : "warning"}>{item.returnAt ? "Returned" : "Borrowed"}</StatusPill></td>{isAdministrator && <td><button className="button button-small button-quiet danger-text" disabled={!item.returnAt} title={!item.returnAt ? "Record the equipment return before deleting its history" : "Delete this borrowing history record"} aria-label={`Delete history for ${asset?.name ?? "equipment"} borrowed by ${borrower?.fullName ?? "team member"}`} onClick={() => { if (window.confirm(`Delete the borrowing history for ${asset?.name ?? "this equipment"} borrowed by ${borrower?.fullName ?? "this team member"}? This cannot be undone.`)) void run("delete_equipment_history", { assetId: item.assetId, loanId: item.id }); }}>Delete record</button></td>}</tr>; })}</tbody></table></div> : <div className="subtle-empty">No equipment has been handed out yet.</div>}
  </>;
}
function ChecklistsPage({ data, user, openModal, run }: { data: AppData; user: Profile; openModal: (state: ModalState) => void; run: (action: string, payload?: Record<string, unknown>) => Promise<void> }) {
  const isAdmin = hasManagerAccess(user.accessRoles, user.role);
  const canManageTemplates = can(user.accessRoles ?? user.role, "manage_checklists");
  const items = data.checklistItems.filter((item) => (isAdmin || item.userId === user.id) && (!isAdmin || !item.clearedFromChecklist));
  const activeItems = isAdmin ? items : items.filter((item) => item.status !== "Complete");
  const groupKeys = [...new Set(activeItems.map((item) => `${item.eventId}:${item.userId}`))];
  const [templateCategory, setTemplateCategory] = useState(categoryDefaults.checklists[0]);
  const templateCategories = phaseOptions(data);
  const templates = data.checklistTemplates.filter((template) => (template.category ?? categoryDefaults.checklists[0]) === templateCategory);
  return <><PageIntro title="Production checklists" detail="Each person sees their own checklist. Administrators and the director can reuse templates to assign a ready-made set of tasks.">{hasAccessRole(user.accessRoles, user.role, "Equipment Manager") && !canManageTemplates && <CategoryManagerButton kind="checklists" openModal={openModal} />}</PageIntro>
    {canManageTemplates && <section className="panel checklist-template-panel"><div className="panel-heading"><div><span className="eyebrow">REUSABLE CHECKLISTS</span><h3>Templates & quick assign</h3></div><button className="button button-primary button-small" onClick={() => openModal({ type: "create-checklist-template" })}><Plus size={14} />New template</button></div>
      <p className="checklist-phase-help">Choose a program phase to see its saved checklists. Send a checklist to the selected event and team member.</p><div className="filter-row"><div className="category-tabs">{templateCategories.map((category) => <button className={templateCategory === category ? "active" : ""} key={category} onClick={() => setTemplateCategory(category)}>{category}</button>)}</div><CategoryManagerButton kind="checklists" openModal={openModal} /></div>
      {templates.length ? <div className="checklist-template-list">{templates.map((template) => <article className="checklist-template-row" key={template.id}><div className="checklist-template-copy"><strong>{template.name}</strong><small>{template.tasks.length} task{template.tasks.length === 1 ? "" : "s"} · updated {formatStamp(template.updatedAt)}</small></div><div className="checklist-template-actions"><button className="button button-small button-primary" onClick={() => openModal({ type: "quick-assign-checklist", id: template.id })}>Send checklist</button><button className="button button-small button-quiet" onClick={() => openModal({ type: "edit-checklist-template", id: template.id })}>Edit</button><button className="button button-small button-quiet" onClick={() => void run("duplicate_checklist_template", { templateId: template.id })}>Duplicate</button><button className="button button-small button-quiet" onClick={() => { if (window.confirm(`Delete the “${template.name}” template? Existing checklists assigned from it will stay unchanged.`)) void run("delete_checklist_template", { templateId: template.id }); }}>Delete</button></div></article>)}</div> : <div className="checklist-template-empty"><ClipboardCheck size={17} /><span><strong>No {templateCategory.toLowerCase()} templates yet</strong><small>Create a checklist template and choose this category to organize it here.</small></span></div>}
    </section>}
    <div className="checklist-overview"><div><strong>{items.filter((item) => item.status === "Complete").length}<small> / {items.length}</small></strong><span>checks complete</span></div><div className="progress-track"><span style={{ width: `${items.length ? Math.round(items.filter((item) => item.status === "Complete").length / items.length * 100) : 0}%` }} /></div><span className="checklist-overview-right">{items.filter((item) => item.status === "Needs attention").length} need attention</span></div>
    {isAdmin && data.checklistItems.some((item) => item.status === "Complete" && !item.clearedFromChecklist) && <div className="checklist-clear-toolbar"><span>Completed items stay in Reports after they are cleared here.</span><button className="button button-small button-quiet" onClick={() => { if (window.confirm("Clear all completed checklist items from this page? Their report history will stay saved.")) void run("clear_completed_checklists"); }}>Clear completed checklists</button></div>}
    {groupKeys.length ? <div className="checklist-groups">{groupKeys.map((key) => {
      const groupItems = activeItems.filter((item) => `${item.eventId}:${item.userId}` === key);
      const first = groupItems[0]; const event = data.events.find((row) => row.id === first.eventId); const person = data.profiles.find((row) => row.id === first.userId);
      if (!event) return null;
      const complete = groupItems.filter((item) => item.status === "Complete").length;
      const phases = phaseOptions(data);
      const overdueCount = groupItems.filter((item) => isRequiredPhaseOverdue(item, event, phases)).length;
      return <section className="checklist-card" key={key}>
        <div className="checklist-card-head"><ProfileAvatar name={person?.fullName ?? "Team member"} src={person?.avatarUrl} className="checklist-event-avatar" /><div className="checklist-card-title"><h3>{event.title}</h3><span>{person?.fullName ?? "Team member"} · {person?.jobTitle ?? person?.role ?? "Production role"} · {displayDate(event.date)} · Now: {event.programPhase ?? phases[0]}</span></div><StatusPill tone={overdueCount ? "danger" : complete === groupItems.length ? "success" : groupItems.some((item) => item.status === "Needs attention") ? "danger" : "warning"}>{overdueCount ? `${overdueCount} finish now` : `${complete}/${groupItems.length} complete`}</StatusPill></div>
        <div className="checklist-items">{groupItems.map((item) => {
          const phaseOverdue = isRequiredPhaseOverdue(item, event, phases);
          const itemPhase = item.programPhase ?? phases[0];
          return <div className={`checklist-item ${item.status === "Needs attention" ? "item-attention" : ""} ${phaseOverdue ? "item-phase-overdue" : ""}`} key={item.id}>
            <span className={`check-state-icon ${item.status === "Complete" ? "done" : item.status === "Needs attention" ? "failed" : ""}`}>{item.status === "Complete" ? <Check size={14} /> : item.status === "Needs attention" || phaseOverdue ? <AlertTriangle size={14} /> : null}</span>
            <span className="checklist-item-copy"><strong>{item.label}</strong><small>{item.required ? "Required" : "Optional"} · {itemPhase} phase{item.note && ` · ${item.note}`}</small></span>
            {item.status === "Complete" ? <span className="completed-by">{item.completedAt ? formatStamp(item.completedAt) : "Complete"}</span> : <div className="checklist-actions">{phaseOverdue && <StatusPill tone="danger">Must be done immediately</StatusPill>}{item.status === "Needs attention" && <StatusPill tone="danger">Needs attention</StatusPill>}{(item.userId === user.id || isAdmin) && <><button className={`button button-small ${phaseOverdue ? "button-danger" : "button-quiet"}`} onClick={() => void run("complete_checklist_item", { itemId: item.id, status: "Complete" })}><Check size={14} />{item.status === "Needs attention" ? "Resolve & complete" : "Complete"}</button>{item.status === "Outstanding" && <button className="icon-button issue-button" title="Report a failed check" onClick={() => openModal({ type: "flag-check", id: item.id })}><AlertTriangle size={15} /></button>}</>}</div>}
            {isAdmin && <div className="checklist-actions checklist-admin-actions"><button type="button" className="icon-button checklist-admin-button" title="Edit" aria-label="Edit checklist item" onClick={() => openModal({ type: "edit-checklist-item", id: item.id })}><Pencil size={14} /></button><button type="button" className="icon-button checklist-admin-button" title={`Remove ${item.label}`} aria-label={`Remove ${item.label}`} onClick={() => openModal({ type: "delete-checklist-item", id: item.id })}><Trash2 size={14} /></button></div>}
          </div>;
        })}</div>
      </section>;
    })}</div> : <EmptyState icon={ClipboardCheck} title={items.some((item) => item.status === "Complete") ? "All assigned checklists are complete" : "No checklist items yet"} detail={isAdmin ? "Add a checklist item and choose its team member and event." : "Completed tasks remain in Reports. New checklist items assigned to you will appear here."} />}
  </>;
}

function defaultSopContent(sop?: AppData["sops"][number]): SopContentBlock[] {
  if (sop?.contentBlocks?.length) return sop.contentBlocks;
  const blocks: SopContentBlock[] = [];
  if (sop?.summary) blocks.push({ kind: "body", text: sop.summary, fontSize: 16 });
  for (const step of sop?.steps ?? []) blocks.push({ kind: "body", text: step, fontSize: 16 });
  return blocks;
}
function sopImageSource(block: Extract<SopContentBlock, { kind: "image" }>, sopId: string) {
  return block.dataUrl ?? (block.path ? `/api/sops/media?path=${encodeURIComponent(block.path)}&sopId=${encodeURIComponent(sopId)}` : "");
}
function escapeEditorMarkup(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}
function sopBlocksToEditorHtml(blocks: SopContentBlock[], sopId: string) {
  return blocks.map((block) => {
    if (block.kind === "image") {
      const src = escapeEditorMarkup(sopImageSource(block, sopId));
      return `<p><img data-iac-sop-image="true" data-sop-path="${escapeEditorMarkup(block.path ?? "")}" data-sop-data-url="${escapeEditorMarkup(block.dataUrl ?? "")}" alt="${escapeEditorMarkup(block.alt)}" src="${src}" /></p>`;
    }
    const tag = block.kind === "title" ? "h1" : block.kind === "heading" ? "h2" : block.kind === "subheading" ? "h3" : "p";
    const fontSize = Math.min(48, Math.max(10, block.fontSize));
    return `<${tag} style="font-size:${fontSize}px">${escapeEditorMarkup(block.text)}</${tag}>`;
  }).join("") || "<p><br></p>";
}
function sopEditorHtmlToBlocks(root: HTMLDivElement): SopContentBlock[] {
  const blocks: SopContentBlock[] = [];
  const defaults = { title: 32, heading: 24, subheading: 19, body: 16 };
  const appendText = (text: string, kind: "title" | "heading" | "subheading" | "body", fontSize: number) => {
    if (!text) return;
    const previous = blocks.at(-1);
    if (previous && previous.kind !== "image" && previous.kind === kind && previous.fontSize === fontSize) previous.text += text;
    else blocks.push({ kind, text, fontSize });
  };
  const walk = (node: Node, kind: "title" | "heading" | "subheading" | "body", fontSize: number) => {
    if (node.nodeType === Node.TEXT_NODE) { appendText(node.textContent ?? "", kind, fontSize); return; }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === "IMG" && node.dataset.iacSopImage === "true") {
      const image = node as HTMLImageElement;
      const path = node.dataset.sopPath ?? "";
      const dataUrl = node.dataset.sopDataUrl ?? "";
      if (Boolean(path) !== Boolean(dataUrl)) blocks.push({ kind: "image", ...(path ? { path } : { dataUrl }), alt: image.alt });
      return;
    }
    if (node.tagName === "BR") { appendText("\n", kind, fontSize); return; }
    const nextKind = node.tagName === "H1" ? "title" : node.tagName === "H2" ? "heading" : node.tagName === "H3" ? "subheading" : kind;
    const parsedSize = Number.parseFloat(node.style.fontSize);
    const nextSize = Number.isFinite(parsedSize) ? Math.min(48, Math.max(10, Math.round(parsedSize))) : node.tagName.startsWith("H") ? defaults[nextKind] : fontSize;
    if (["P", "DIV", "H1", "H2", "H3", "LI"].includes(node.tagName) && blocks.length && blocks.at(-1)?.kind !== "image") appendText("\n", nextKind, nextSize);
    for (const child of Array.from(node.childNodes)) walk(child, nextKind, nextSize);
  };
  for (const child of Array.from(root.childNodes)) walk(child, "body", 16);
  return blocks.filter((block) => block.kind === "image" || Boolean(block.text.trim()));
}
function RichSopEditor({ mode, sopId, initialBlocks }: { mode: SessionContext["mode"]; sopId?: string; initialBlocks: SopContentBlock[] }) {
  const [blocks, setBlocks] = useState<SopContentBlock[]>(initialBlocks);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const editorRef = useRef<HTMLDivElement>(null);
  const savedSelection = useRef<Range | null>(null);
  const [initialHtml] = useState(() => sopBlocksToEditorHtml(initialBlocks, sopId ?? "draft"));
  const syncEditor = () => { if (editorRef.current) setBlocks(sopEditorHtmlToBlocks(editorRef.current)); };
  const rememberSelection = () => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (editor && selection?.rangeCount && editor.contains(selection.anchorNode)) savedSelection.current = selection.getRangeAt(0).cloneRange();
  };
  const applyBlockFormat = (tag: "h1" | "h2" | "h3" | "p") => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    document.execCommand("formatBlock", false, tag);
    syncEditor();
  };
  const applyFontSize = (event: ChangeEvent<HTMLSelectElement>) => {
    const editor = editorRef.current;
    const range = savedSelection.current;
    const size = Number(event.currentTarget.value);
    if (!editor || !range || !editor.contains(range.commonAncestorContainer) || range.collapsed) { setError("Select the text you want to resize, then choose a font size."); return; }
    editor.focus();
    const selection = window.getSelection();
    if (selection) { selection.removeAllRanges(); selection.addRange(range); }
    const span = document.createElement("span"); span.style.fontSize = `${size}px`;
    try { range.surroundContents(span); }
    catch { span.append(range.extractContents()); range.insertNode(span); }
    syncEditor();
    rememberSelection();
  };
  const uploadImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
    if (!file) return;
    setUploading(true); setError("");
    try {
      if (!file.type.startsWith("image/") || file.size > 15 * 1024 * 1024) throw new Error("Choose a JPG, PNG, WebP, or GIF image under 15 MB.");
      if (mode === "demo") {
        if (file.size > 2_000_000) throw new Error("Local demo SOP images must be 2 MB or smaller.");
        const dataUrl = await fileAsDataUrl(file);
        insertEditorImage({ kind: "image", dataUrl, alt: file.name });
      } else {
        const form = new FormData(); form.append("file", file); form.append("sopId", sopId ?? "draft");
        const response = await fetch("/api/sops/media", { method: "POST", cache: "no-store", body: form });
        const result = await response.json() as { path?: string; error?: string };
        if (!response.ok || !result.path) throw new Error(result.error ?? "SOP image upload failed.");
        insertEditorImage({ kind: "image", path: result.path, alt: file.name });
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "This image could not be added."); }
    finally { setUploading(false); }
  };
  const insertEditorImage = (block: Extract<SopContentBlock, { kind: "image" }>) => {
    const editor = editorRef.current;
    if (!editor) return;
    const image = document.createElement("img");
    image.dataset.iacSopImage = "true"; image.dataset.sopPath = block.path ?? ""; image.dataset.sopDataUrl = block.dataUrl ?? "";
    image.src = sopImageSource(block, sopId ?? "draft"); image.alt = block.alt || "Procedure image"; image.contentEditable = "false";
    image.className = "rich-sop-inline-image";
    const range = savedSelection.current;
    if (range && editor.contains(range.commonAncestorContainer)) {
      range.deleteContents(); range.insertNode(image);
      const spacer = document.createTextNode("\u00a0"); range.setStartAfter(image); range.insertNode(spacer); range.setStartAfter(spacer); range.collapse(true);
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    } else {
      const paragraph = document.createElement("p"); paragraph.append(image, document.createTextNode("\u00a0")); editor.append(paragraph);
    }
    editor.focus(); syncEditor();
  };
  const onEditorPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
    syncEditor();
  };
  return <section className="rich-sop-editor"><div className="rich-sop-toolbar" aria-label="Format procedure text"><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyBlockFormat("h1")}>Title</button><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyBlockFormat("h2")}>Heading</button><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyBlockFormat("h3")}>Subheading</button><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyBlockFormat("p")}>Body text</button><label className="rich-sop-font-size"><span>Font size</span><select aria-label="Font size" defaultValue="16" onMouseDown={rememberSelection} onChange={applyFontSize}>{[10,12,14,16,18,20,24,28,32,40,48].map((size) => <option value={size} key={size}>{size} px</option>)}</select></label><label className="rich-sop-image-button" onMouseDown={rememberSelection}><ImagePlus size={15} />{uploading ? "Uploading…" : "Insert image"}<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" onClick={rememberSelection} onChange={uploadImage} disabled={uploading} /></label></div>
    <div ref={editorRef} className="rich-sop-canvas" contentEditable suppressContentEditableWarning role="textbox" aria-label="Full SOP procedure editor" aria-multiline="true" dangerouslySetInnerHTML={{ __html: initialHtml }} onInput={() => { setError(""); syncEditor(); }} onMouseUp={rememberSelection} onKeyUp={rememberSelection} onPaste={onEditorPaste} />
    <p className="rich-sop-editor-help">Write the entire procedure in one editor. Select text to resize it. Use the toolbar for titles and headings; insert images at the current cursor. Select an image and press Backspace to remove it.</p>
    <input type="hidden" name="richContent" value={JSON.stringify(blocks)} />
    {error && <small role="alert" className="rich-sop-error">{error}</small>}
    {!blocks.length && <div className="rich-sop-empty">Write instructions or insert an image in the procedure editor.</div>}</section>;
}
function SopRichContentView({ sop }: { sop: AppData["sops"][number] }) {
  const [expanded, setExpanded] = useState(false);
  const blocks = defaultSopContent(sop);
  const visible = expanded ? blocks : blocks.slice(0, 6);
  return <><div className="sop-rich-reader">{visible.map((block, index) => block.kind === "image" ? <div className="sop-rich-reader-image" key={`sop-image-${index}`}><NextImage unoptimized src={sopImageSource(block, sop.id)} alt={block.alt || "Procedure image"} width={920} height={560} /></div> : <div className={`sop-rich-reader-text sop-rich-${block.kind}`} style={{ fontSize: `${block.fontSize}px` }} key={`sop-text-${index}`}>{block.text}</div>)}</div>{blocks.length > 6 && <button type="button" className="button button-small button-quiet sop-show-more" onClick={() => setExpanded((value) => !value)}>{expanded ? "Show less" : `Show more (${blocks.length - 6} sections)`}</button>}</>;
}

function SopPage({ data, user, searchMatch, openModal, run }: { data: AppData; user: Profile; searchMatch: (value: string) => boolean; openModal: (state: ModalState) => void; run: (action: string, payload?: Record<string, unknown>) => Promise<void> }) {
  const [category, setCategory] = useState("All procedures");
  const [showAll, setShowAll] = useState(false);
  const manager = hasManagerAccess(user.accessRoles, user.role);
  const categoryValues = data.categories ? data.categories.sops : [...new Set([...categoryDefaults.sops, ...data.sops.map((sop) => sop.category)])];
  const categories = ["All procedures", ...categoryValues];
  const canEditCategories = manager || hasAccessRole(user.accessRoles, user.role, "Equipment Manager");
  const sops = data.sops.filter((sop) => (manager || showAll || (sop.assignedUserIds?.includes(user.id) ?? false) || sop.availableToAll !== false) && (category === "All procedures" || sop.category === category) && searchMatch(`${sop.title} ${sop.category} ${sop.summary}`)).sort((a, b) => a.title.localeCompare(b.title));
  return <><PageIntro title="Standard operating procedures" detail="Published procedures are available to the team. Draft technical templates require review before use." />
    <div className="sop-notice"><ShieldCheck size={18} /><span><strong>Technical details require local verification.</strong> This library contains development templates only. Do not assume a device configuration, wiring path, address, or credential from an unreviewed draft.</span></div>
    <div className="filter-row"><div className="category-tabs">{categories.map((item) => <button className={category === item ? "active" : ""} key={item} onClick={() => setCategory(item)}>{item}</button>)}</div><div className="filter-note"><BookOpen size={14} />{data.sops.filter((item) => item.status === "Published").length} published</div>{canEditCategories && <CategoryManagerButton kind="sops" openModal={openModal} />}{!manager && <button className={`button button-small ${showAll ? "button-primary" : "button-quiet"}`} onClick={() => setShowAll((value) => !value)}>{showAll ? "Show assigned SOPs" : "See all SOPs"}</button>}</div>
     {sops.length ? <div className="sop-grid">{sops.map((sop) => <article className="sop-card" key={sop.id}><button type="button" className="sop-card-open" onClick={() => openModal({ type: "read-sop", id: sop.id })}><div className="sop-card-top"><span className="sop-card-icon"><BookOpen size={18} /></span><StatusPill tone={sop.status === "Published" ? "success" : "warning"}>{sop.status}</StatusPill></div><span className="asset-code">{sop.category.toUpperCase()} · VERSION {sop.version}</span><h3>{sop.title}</h3><p>{sop.summary}</p><div className="sop-card-foot"><span>{sop.contentBlocks?.length ?? sop.steps.length} sections</span><span>{sop.reviewRequired ? "Review required" : `Updated ${formatStamp(sop.updatedAt)}`}<ArrowRight size={14} /></span></div></button>{manager && <div className="sop-manager-actions"><button type="button" className="button button-small button-quiet sop-audience-button" onClick={() => openModal({ type: "edit-sop-audience", id: sop.id })}>Choose crew visibility</button><button type="button" className="button button-small button-quiet" onClick={() => openModal({ type: "edit-sop", id: sop.id })}>Edit</button><button type="button" className="button button-small button-quiet danger-text" onClick={() => { if (window.confirm(`Delete “${sop.title}” and its saved versions? This cannot be undone.`)) void run("delete_sop", { sopId: sop.id }); }}>Delete</button></div>}</article>)}</div> : <EmptyState icon={BookOpen} title="No procedures match" detail="Try a different category or search phrase." />}
  </>;
}

function IncidentPhotosField({ initialValue = [] }: { initialValue?: string[] }) {
  const [photos, setPhotos] = useState<string[]>(initialValue);
  const [error, setError] = useState("");
  const addPhotos = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (photos.length + files.length > 5) { setError("Add up to five photos per incident."); return; }
    const converted: string[] = [];
    for (const file of files) {
      if (!file.type.startsWith("image/") || file.size > 15 * 1024 * 1024) { setError("Choose image files smaller than 15 MB each."); continue; }
      try {
        const url = URL.createObjectURL(file);
        const data = await new Promise<string>((resolve, reject) => {
          const image = new Image();
          image.onload = () => {
            const scale = Math.min(1, 1200 / Math.max(image.naturalWidth, image.naturalHeight));
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
            canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(url);
            resolve(canvas.toDataURL("image/jpeg", 0.65));
          };
          image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("A photo could not be opened.")); };
          image.src = url;
        });
        if (data.length > 480_000) { setError("One photo is too large after compression. Choose a smaller image."); continue; }
        converted.push(data);
      } catch { setError("A photo could not be opened. Try another image."); }
    }
    setPhotos((current) => [...current, ...converted].slice(0, 5));
    if (converted.length) setError("");
  };
  return <div className="incident-photo-field"><label className="button button-small button-quiet"><Plus size={14} />Add photos<input type="file" accept="image/*" multiple onChange={(event) => void addPhotos(event)} /></label><span className="form-hint">Up to 5 photos. Photos are resized before saving.</span>{error && <span className="field-error">{error}</span>}<div className="incident-photo-previews">{photos.map((photo, index) => <div className="incident-photo-preview" key={`${index}-${photo.slice(-12)}`}><NextImage unoptimized src={photo} alt={`Incident attachment ${index + 1}`} width={76} height={64} /><button type="button" className="icon-button" aria-label="Remove photo" title="Remove photo" onClick={() => setPhotos((current) => current.filter((_, photoIndex) => photoIndex !== index))}><X size={13} /></button><input type="hidden" name="photos" value={photo} /></div>)}</div></div>;
}

function CategoryManagerButton({ kind, openModal }: { kind: "equipment" | "sops" | "incidents" | "checklists" | "events" | "production_roles"; openModal: (state: ModalState) => void }) {
  return <button type="button" className="button button-small button-quiet category-manage-button" onClick={() => openModal({ type: "manage-categories", id: kind })}>{kind === "checklists" ? "Order phases" : kind === "production_roles" ? "Manage production roles" : "Edit categories"}</button>;
}

function ShowMoreList<T>({ items, initialCount = 8, className, renderItem }: { items: T[]; initialCount?: number; className: string; renderItem: (item: T, index: number) => ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, initialCount);
  return <><div className={className}>{visible.map(renderItem)}</div>{items.length > initialCount && <button type="button" className="button button-small button-quiet show-more-list-button" onClick={() => setExpanded((value) => !value)}>{expanded ? "Show less" : `Show more (${items.length - initialCount})`}</button>}</>;
}

function IncidentsPage({ data, user, openModal, run }: { data: AppData; user: Profile; openModal: (state: ModalState) => void; run: (action: string, payload?: Record<string, unknown>) => Promise<void> }) {
  const canReport = can(user.accessRoles ?? user.role, "report_incidents");
  const isAdmin = hasManagerAccess(user.accessRoles, user.role);
  const isAdministrator = hasAccessRole(user.accessRoles, user.role, "Administrator");
  const canEditCategories = isAdmin || hasAccessRole(user.accessRoles, user.role, "Equipment Manager");
  const incidents = [...data.incidents].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return <><PageIntro title="Incident log" detail="Record equipment faults, production interruptions, and follow-up actions. Urgent issues are surfaced to media leads." />
    <div className="incident-summary"><div><span>Open</span><strong>{incidents.filter((item) => ["Open", "Acknowledged", "In progress"].includes(item.status)).length}</strong></div><div><span>High severity</span><strong className="danger-text">{incidents.filter((item) => ["High", "Critical"].includes(item.severity) && !["Resolved", "Closed"].includes(item.status)).length}</strong></div><div><span>Resolved</span><strong>{incidents.filter((item) => item.status === "Resolved").length}</strong></div></div>
    {canReport && <div className="incident-toolbar">{canEditCategories && <CategoryManagerButton kind="incidents" openModal={openModal} />}<button className="button button-primary button-small" onClick={() => openModal({ type: "report-incident" })}><Plus size={14} />Report issue</button></div>}
    {incidents.length ? <ShowMoreList items={incidents} className="incident-list" initialCount={8} renderItem={(incident) => { const reporter = data.profiles.find((item) => item.id === incident.reportedBy); const event = data.events.find((item) => item.id === incident.eventId); const asset = data.assets.find((item) => item.id === incident.assetId); const severityTone = ["Critical", "High"].includes(incident.severity) ? "danger" : incident.severity === "Medium" ? "warning" : "neutral"; const ownIncident = incident.reportedBy === user.id; return <article className="incident-card" key={incident.id}><span className={`incident-icon incident-${severityTone}`}><AlertTriangle size={18} /></span><div className="incident-main"><div className="incident-title-row"><div><span className="eyebrow">{incident.category} · {formatStamp(incident.createdAt)}</span><h3>{incident.description}</h3></div><StatusPill tone={severityTone}>{incident.severity}</StatusPill></div><div className="incident-meta"><span>Reported by <strong>{reporter?.fullName ?? "Team member"}</strong></span>{event && <span><CalendarDays size={13} />{event.title}</span>}{asset && <span><HardDrive size={13} />{asset.assetCode} · {asset.name}</span>}<StatusPill tone={incident.status === "Resolved" || incident.status === "Closed" ? "success" : incident.status === "Open" ? "warning" : "neutral"}>{incident.status}</StatusPill></div><p className="incident-full-description">{incident.description}</p>{incident.immediateAction && <div className="resolution-note"><Wrench size={14} /><strong>Action taken:</strong> {incident.immediateAction}</div>}{incident.photos?.length ? <div className="incident-attachments">{incident.photos.map((photo, index) => <a href={photo} target="_blank" rel="noreferrer" key={`${incident.id}-photo-${index}`}><NextImage unoptimized src={photo} alt={`Incident evidence ${index + 1}`} width={140} height={100} /></a>)}</div> : null}{incident.resolution && <div className="resolution-note"><CheckCircle2 size={14} /><strong>Job completed:</strong> {incident.resolution}</div>}{ownIncident && !["Resolved", "Closed"].includes(incident.status) && <button className="button button-small button-quiet incident-resolve" onClick={() => openModal({ type: "complete-own-incident", id: incident.id })}>Mark job completed</button>}{isAdmin && !["Resolved", "Closed"].includes(incident.status) && <button className="button button-small button-quiet incident-resolve" onClick={() => openModal({ type: "resolve-incident", id: incident.id })}>Record resolution</button>}{isAdmin && <button className="button button-small button-quiet incident-resolve" onClick={() => openModal({ type: "edit-incident", id: incident.id })}>Edit incident</button>}{isAdministrator && <button className="button button-small button-quiet danger-text incident-resolve" title="Permanently delete this incident" onClick={() => { if (window.confirm(`Delete this incident reported by ${reporter?.fullName ?? "a team member"}? This cannot be undone.`)) void run("delete_incident", { incidentId: incident.id }); }}><Trash2 size={13} />Delete incident</button>}</div></article>; }} /> : <EmptyState icon={CheckCircle2} title="No incidents reported" detail="When a fault or interruption occurs, record it so the team can follow through." action={canReport && <button className="button button-primary" onClick={() => openModal({ type: "report-incident" })}><Plus size={15} />Report issue</button>} />}
  </>;
}

function ReportsPage({ data, user, run }: { data: AppData; user: Profile; run: (action: string, payload?: Record<string, unknown>) => Promise<void> }) {
  const [range, setRange] = useState("All time");
  const [search, setSearch] = useState("");
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [showPreviousEvents, setShowPreviousEvents] = useState(false);
  const [showMoreEvents, setShowMoreEvents] = useState(false);
  const canManageHistory = hasManagerAccess(user.accessRoles, user.role);
  const [today] = useState(() => new Date().toISOString().slice(0, 10));
  const cutoff = range === "30 days" ? new Date(new Date(`${today}T12:00:00`).getTime() - 30 * 86400000).toISOString().slice(0, 10) : range === "90 days" ? new Date(new Date(`${today}T12:00:00`).getTime() - 90 * 86400000).toISOString().slice(0, 10) : "0000-00-00";
  const matchingEvents = data.events.filter((event) => event.date >= cutoff && `${event.title} ${event.category}`.toLowerCase().includes(search.toLowerCase()));
  const upcomingEvents = matchingEvents.filter((event) => event.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const previousEvents = matchingEvents.filter((event) => event.date < today).sort((a, b) => b.date.localeCompare(a.date));
  const events = [...upcomingEvents, ...(showPreviousEvents ? previousEvents : [])];
  const visibleEvents = showMoreEvents ? events : events.slice(0, 6);
  const eventIds = new Set(events.map((event) => event.id));
  const checklists = data.checklistItems.filter((item) => eventIds.has(item.eventId) && item.required);
  const incidents = data.incidents.filter((item) => !item.eventId || eventIds.has(item.eventId));
  const checklistRate = checklists.length ? Math.round(checklists.filter((item) => item.status === "Complete").length / checklists.length * 100) : 0;
  const teamHistory = [...data.profiles].sort((a, b) => a.fullName.localeCompare(b.fullName)).map((person) => {
    const pastAssignments = data.assignments.flatMap((assignment) => {
      if (assignment.userId !== person.id || assignment.serviceHistoryHidden) return [];
      const event = data.events.find((item) => item.id === assignment.eventId);
      return event && event.status !== "Cancelled" && (event.status === "Completed" || event.date < today) ? [{ assignment, event }] : [];
    }).sort((a, b) => b.event.date.localeCompare(a.event.date));
    const servedEvents = [...new Map(pastAssignments.map((item) => [item.event.id, item])).values()];
    const tasks = data.checklistItems.filter((item) => item.userId === person.id && !item.serviceHistoryHidden);
    const completedTasks = tasks.filter((item) => item.status === "Complete").sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
    return { person, assignments: pastAssignments, events: servedEvents, tasks, completedTasks };
  });
  const selectedHistory = teamHistory.find((item) => item.person.id === selectedPersonId) ?? null;
  const download = () => {
    const rows = [["Event", "Date", "Status", "Checklist complete", "Incidents"], ...events.map((event) => { const eventChecks = checklists.filter((item) => item.eventId === event.id); return [event.title, event.date, event.status, `${eventChecks.filter((item) => item.status === "Complete").length}/${eventChecks.length}`, String(incidents.filter((item) => item.eventId === event.id).length)]; })];
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "iac-media-event-report.csv"; anchor.click(); URL.revokeObjectURL(url);
  };
  return <><PageIntro title="Operations reports" detail="Metrics below are calculated from records visible to your account. Choose a period and export the event summary." /><div className="report-toolbar"><label className="report-search"><Search size={15} /><input placeholder="Filter events" value={search} onChange={(event) => setSearch(event.target.value)} /></label><select aria-label="Report date range" value={range} onChange={(event) => setRange(event.target.value)}><option>All time</option><option>30 days</option><option>90 days</option></select><button className="button button-quiet" onClick={download}><ArrowDownToLine size={15} />Export CSV</button></div>
    <div className="metric-grid report-metrics"><Metric label="Events" value={events.length} icon={CalendarDays} trend={`${range} · visible records`} tone="blue" /><Metric label="Checklist completion" value={`${checklistRate}%`} icon={ClipboardCheck} trend={`${checklists.filter((item) => item.status === "Complete").length} complete`} tone="green" /><Metric label="Required checklist items" value={checklists.length} icon={CheckCircle2} trend="Across visible events" tone="amber" /><Metric label="Open incidents" value={incidents.filter((item) => !["Resolved", "Closed"].includes(item.status)).length} icon={Activity} trend={`${incidents.length} total in view`} tone="rose" /></div>
    {events.length ? <><div className="table-wrap"><table className="data-table report-table"><thead><tr><th>EVENT</th><th>DATE</th><th>STATUS</th><th>CHECKLIST</th><th>INCIDENTS</th></tr></thead><tbody>{visibleEvents.map((event) => { const checks = checklists.filter((item) => item.eventId === event.id); return <tr key={event.id}><td><strong>{event.title}</strong><small className="table-subline">{event.category}</small></td><td>{displayDate(event.date)}</td><td><StatusPill tone={event.status === "Published" ? "success" : "warning"}>{event.status}</StatusPill></td><td>{checks.filter((item) => item.status === "Complete").length} / {checks.length}</td><td>{incidents.filter((item) => item.eventId === event.id).length}</td></tr>; })}</tbody></table></div><div className="report-event-controls">{visibleEvents.length < events.length && <button className="button button-small button-quiet" onClick={() => setShowMoreEvents(true)}>View more events</button>}{previousEvents.length > 0 && <button className="button button-small button-quiet" onClick={() => { setShowPreviousEvents((value) => !value); setShowMoreEvents(false); }}>{showPreviousEvents ? "Hide previous events" : `Show previous events (${previousEvents.length})`}</button>}</div></> : <EmptyState icon={Activity} title="No report records for this filter" detail="Try another date range or remove the event search." />}
    <section className="panel team-history-panel"><div className="panel-heading"><div><span className="eyebrow">ALL TIME · CREW RECOGNITION</span><h3>Team service history</h3></div><span className="today-chip">{teamHistory.length} members</span></div><p className="team-history-note">Review each person’s past and completed event assignments and checklist work. Event attendance is not recorded separately, so service totals use assigned events that have passed or are marked completed.</p>
      {teamHistory.length ? <div className="table-wrap"><table className="data-table team-history-table"><thead><tr><th>TEAM MEMBER</th><th>PRODUCTION ROLE</th><th>EVENTS SERVED</th><th>TASKS COMPLETED</th><th>CHECKLIST RATE</th><th></th></tr></thead><tbody>{teamHistory.map(({ person, events: servedEvents, tasks, completedTasks }) => <tr key={person.id} className={selectedPersonId === person.id ? "team-history-selected" : ""}><td><strong>{person.fullName}</strong></td><td>{person.jobTitle || person.role}</td><td>{servedEvents.length}</td><td>{completedTasks.length} / {tasks.length}</td><td>{tasks.length ? `${Math.round(completedTasks.length / tasks.length * 100)}%` : "—"}</td><td><div className="team-history-actions"><button className="button button-small button-quiet" onClick={() => setSelectedPersonId(selectedPersonId === person.id ? null : person.id)}>{selectedPersonId === person.id ? "Close history" : "View history"}</button>{canManageHistory && <button className="button button-small button-quiet" onClick={() => { if (window.confirm(`Reset ${person.fullName}'s service history? Past event assignments and completed checklist work will be cleared from recognition reports. The original event and checklist records will remain saved.`)) void run("reset_member_service_history", { userId: person.id }); }}>Reset history</button>}</div></td></tr>)}</tbody></table></div> : <EmptyState icon={Users} title="No team history yet" detail="Team event and checklist records will appear here as work is assigned and completed." />}
      {selectedHistory && <div className="member-history-detail"><div className="panel-heading"><div><span className="eyebrow">INDIVIDUAL HISTORY</span><h3>{selectedHistory.person.fullName}</h3></div><span className="role-chip">{selectedHistory.person.jobTitle || selectedHistory.person.role}</span></div><div className="member-history-columns"><section><div className="member-history-subhead"><h4>Past event assignments</h4><strong>{selectedHistory.events.length}</strong></div>{selectedHistory.assignments.length ? <div className="member-history-list">{selectedHistory.assignments.map(({ assignment, event }) => <article className="member-history-item" key={assignment.id}><div><strong>{event.title}</strong><small>{displayDate(event.date)} · {event.category} · {assignment.roleName}</small></div><StatusPill tone={event.status === "Completed" ? "success" : "neutral"}>{event.status === "Completed" ? "Completed" : "Past"}</StatusPill>{canManageHistory && <button type="button" className="icon-button history-delete-button" title="Remove this entry from service history" aria-label={`Remove ${selectedHistory.person.fullName}'s ${event.title} service history entry`} onClick={() => { if (window.confirm(`Remove this assignment from ${selectedHistory.person.fullName}'s service history? The saved event record will stay intact.`)) void run("hide_service_history", { assignmentId: assignment.id }); }}><Trash2 size={14} /></button>}</article>)}</div> : <div className="subtle-empty">No past event assignments yet.</div>}</section><section><div className="member-history-subhead"><h4>Completed checklist tasks</h4><strong>{selectedHistory.completedTasks.length} / {selectedHistory.tasks.length}</strong></div>{selectedHistory.completedTasks.length ? <div className="member-history-list">{selectedHistory.completedTasks.map((task) => { const event = data.events.find((item) => item.id === task.eventId); return <article className="member-history-item" key={task.id}><div><strong>{task.label}</strong><small>{event?.title ?? "Checklist"}{task.completedAt ? ` · ${formatStamp(task.completedAt)}` : ""}</small></div><CheckCircle2 size={16} className="member-history-check" /></article>; })}</div> : <div className="subtle-empty">No completed checklist tasks yet.</div>}</section></div></div>}
    </section>
  </>;
}

function NotificationsPage({ data, user, run, currentTime }: { data: AppData; user: Profile; run: (action: string, payload?: Record<string, unknown>) => Promise<void>; currentTime: number }) {
  const manager = hasManagerAccess(user.accessRoles, user.role);
  const [showAll, setShowAll] = useState(false);
  const [managerView, setManagerView] = useState<"received" | "sent">("received");
  const managerCutoff = currentTime - 24 * 60 * 60 * 1000;
  const readCutoff = currentTime - 30 * 60 * 1000;
  const notifications = data.notifications.filter((item) => {
    if (manager && Date.parse(item.date) < managerCutoff) return false;
    if (manager) {
      if (managerView === "sent" ? item.senderId !== user.id || item.userId === user.id : item.userId !== user.id) return false;
    } else if (item.userId !== user.id) return false;
    if (item.read && Date.parse(item.readAt ?? item.date) < readCutoff) return false;
    return manager && managerView === "received" ? showAll || !item.read : true;
  }).sort((a, b) => b.date.localeCompare(a.date));
  const viewTitle = manager ? managerView === "sent" ? "Notifications sent" : "Notifications received" : "Team notifications";
  const viewDetail = manager
    ? managerView === "sent" ? "Updates you sent to team members, with their recent read status." : "Updates sent to you, including new incidents and completed checklist work."
    : "Notifications stay visible for 30 minutes after you read them. Unread updates remain here until you read them.";
  return <>
    <PageIntro title={viewTitle} detail={viewDetail} />
    {manager && <div className="filter-row notification-page-tabs"><div className="segmented-control" role="tablist" aria-label="Notification inbox">
      <button type="button" className={managerView === "received" ? "selected" : ""} role="tab" aria-selected={managerView === "received"} onClick={() => { setManagerView("received"); setShowAll(false); }}>Received</button>
      <button type="button" className={managerView === "sent" ? "selected" : ""} role="tab" aria-selected={managerView === "sent"} onClick={() => { setManagerView("sent"); setShowAll(false); }}>Sent</button>
    </div>{managerView === "received" && <button className={`button button-small ${showAll ? "button-primary" : "button-quiet"}`} onClick={() => setShowAll((value) => !value)}>{showAll ? "Show unread only" : "Read receipts"}</button>}</div>}
    {notifications.length ? <ShowMoreList items={notifications} className="notification-list" initialCount={8} renderItem={(item) => {
      const recipient = data.profiles.find((profile) => profile.id === item.userId);
      const alarmId = item.href.startsWith("time-alarm:") ? item.href.slice("time-alarm:".length) : "";
      const alarm = alarmId ? data.timeAlarms.find((entry) => entry.id === alarmId) : undefined;
      const canCompleteAlarm = Boolean(alarm && alarm.userId === user.id && alarm.triggeredAt && !alarm.completedAt && !alarm.cancelledAt);
      const canMarkRead = item.userId === user.id && !item.read && !alarmId;
      return <article className={`notification-card ${item.read ? "read" : "unread"}`} key={item.id}>
        <span className="notification-symbol"><Bell size={17} /></span>
        <span className="notification-copy"><strong>{item.title}</strong><small>{item.detail}</small><em>{formatStamp(item.date)}</em>
          {manager && managerView === "sent" && <small className="notification-read-status">To {recipient?.fullName ?? "Team member"} · {item.read ? `Read${item.readAt ? ` ${formatStamp(item.readAt)}` : ""}` : "Unread"}</small>}
          {manager && managerView === "received" && showAll && <small className="notification-read-status">You · {item.read ? `Read${item.readAt ? ` ${formatStamp(item.readAt)}` : ""}` : "Unread"}</small>}
        </span>
        {canCompleteAlarm ? <button type="button" className="button button-small button-primary" onClick={() => void run("complete_time_alarm", { alarmId })}>Task completed</button> : canMarkRead ? <button type="button" className="button button-small button-quiet" onClick={() => void run("mark_notification_read", { notificationId: item.id })}>Mark read</button> : item.read ? <CheckCircle2 size={15} aria-label="Read" /> : <span className="notification-unread-dot" />}
      </article>;
    }} /> : <EmptyState icon={Bell} title={manager ? managerView === "sent" ? "No notifications sent" : showAll ? "No notifications received" : "You're all caught up" : "You're all caught up"} detail={manager && managerView === "sent" ? "Notifications created by your team actions will appear here." : manager && showAll ? "New incidents, completed checklist work, and other updates sent to you will appear here." : "New event, checklist, incident, and equipment updates will appear here."} />}
  </>;
}

function SettingsPage({ data, context, openModal, refreshKey }: { data: AppData; context: SessionContext; openModal: (state: ModalState) => void; refreshKey: number }) {
  const [pinSecurity, setPinSecurity] = useState<{ pinConfigured: boolean; failedAttempts: { createdAt: string; device: string }[] } | null>(null);
  const [pinUnlocked, setPinUnlocked] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState("");
  const [pinSuccess, setPinSuccess] = useState("");
  const [changingPin, setChangingPin] = useState(false);
  useEffect(() => {
    let active = true;
    void fetch("/api/settings-pin", { cache: "no-store" }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not load settings security.");
      if (active) setPinSecurity(body);
    }).catch((error) => { if (active) setPinError(error instanceof Error ? error.message : "Could not load settings security."); });
    return () => { active = false; };
  }, []);
  const submitSettingsPin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setPinBusy(true); setPinError("");
    const form = new FormData(event.currentTarget);
    const pin = String(form.get("pin") ?? "");
    const action = pinSecurity?.pinConfigured ? "verify_pin" : "set_pin";
    const body: Record<string, unknown> = { action, pin, device: "This computer" };
    if (action === "set_pin") body.confirmPin = form.get("confirmPin");
    try {
      const response = await fetch("/api/settings-pin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) {
        if (Array.isArray(result.failedAttempts)) setPinSecurity((current) => current ? { ...current, failedAttempts: result.failedAttempts } : current);
        throw new Error(result.error ?? "The settings PIN was not accepted.");
      }
      setPinSecurity({ pinConfigured: true, failedAttempts: result.failedAttempts ?? pinSecurity?.failedAttempts ?? [] });
      setPinUnlocked(true);
    } catch (error) { setPinError(error instanceof Error ? error.message : "The settings PIN was not accepted."); }
    finally { setPinBusy(false); }
  };
  const updateSettingsPin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setPinBusy(true); setPinError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/settings-pin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "set_pin", currentPin: form.get("currentPin"), pin: form.get("newPin"), confirmPin: form.get("confirmPin"), device: "This computer" }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "The settings PIN could not be changed.");
      setPinSecurity((current) => current ? { ...current, pinConfigured: true } : current);
      setChangingPin(false); setPinSuccess("Settings PIN changed.");
    } catch (error) { setPinError(error instanceof Error ? error.message : "The settings PIN could not be changed."); }
    finally { setPinBusy(false); }
  };
  const roleDescriptions: Record<AppRole, string> = {
    Administrator: "Full control of the app, team accounts, checklists, equipment records, and incidents.",
    Director: "The administrator's operational access, including reports and team accounts. Administrator accounts stay protected.",
    Videographer: "Assigned checklists, camera coverage, equipment viewing, and content workflow.",
    "Video Switcher Operator": "Assigned checklists, video switching workflow, and equipment viewing.",
    "Camera Operator": "Assigned checklists, camera coverage, and equipment viewing.",
    "PTZ Camera Operator": "Assigned checklists, PTZ camera coverage, and equipment viewing.",
    "Audio Operator": "Assigned checklists, audio coverage, and equipment checkout and return.",
    "Equipment Manager": "Full equipment inventory, checkout, return, and loan history access.",
    "Video Operator": "Assigned checklists, video operation, and equipment viewing.",
    Photography: "Assigned checklists, photo coverage, and equipment viewing.",
  };
  const canManageWorkspace = hasManagerAccess(context.user.accessRoles, context.user.role);
  if (!pinUnlocked) return <section className="panel settings-pin-gate"><div className="settings-pin-icon"><ShieldCheck size={23} /></div><span className="eyebrow">PRIVATE ADMINISTRATION</span><h2>{pinSecurity?.pinConfigured ? "Enter your settings PIN" : "Create a settings PIN"}</h2><p>{pinSecurity?.pinConfigured ? "Enter your PIN each time you open Administration." : "Choose a 4–12 digit PIN to protect the settings page."}</p>{pinSecurity?.failedAttempts.length ? <div className="settings-pin-alert"><AlertTriangle size={16} /><span><strong>{pinSecurity.failedAttempts.length} unsuccessful settings attempt{pinSecurity.failedAttempts.length === 1 ? "" : "s"} recorded.</strong>{pinSecurity.failedAttempts.slice(-3).reverse().map((attempt, index) => <small key={`${attempt.createdAt}-${index}`}>{attempt.device} · {formatStamp(attempt.createdAt)}</small>)}</span></div> : null}<form className="settings-pin-form" onSubmit={submitSettingsPin}><label className="form-field"><span>{pinSecurity?.pinConfigured ? "Settings PIN" : "New PIN"}</span><input name="pin" type="password" inputMode="numeric" pattern="[0-9]{4,12}" minLength={4} maxLength={12} required autoComplete="off" /></label>{!pinSecurity?.pinConfigured && <label className="form-field"><span>Confirm PIN</span><input name="confirmPin" type="password" inputMode="numeric" pattern="[0-9]{4,12}" minLength={4} maxLength={12} required autoComplete="off" /></label>}{pinError && <p className="field-error" role="alert">{pinError}</p>}<button className="button button-primary full-button" disabled={pinBusy || !pinSecurity}>{pinBusy ? "Checking…" : pinSecurity?.pinConfigured ? "Unlock settings" : "Save PIN and open settings"}</button></form></section>;
  return <><PageIntro title="Workspace settings" detail="Organization controls and current connection status." />
    {pinSecurity?.failedAttempts.length ? <div className="settings-pin-alert settings-pin-alert-inline"><AlertTriangle size={16} /><span><strong>Unsuccessful settings access was recorded.</strong>{pinSecurity.failedAttempts.slice(-3).reverse().map((attempt, index) => <small key={`${attempt.createdAt}-${index}`}>{attempt.device} · {formatStamp(attempt.createdAt)}</small>)}</span></div> : null}
    {pinSuccess && <div className="settings-pin-success" role="status">{pinSuccess}<button type="button" className="icon-button" onClick={() => setPinSuccess("")} aria-label="Dismiss">×</button></div>}
    <div className="settings-pin-toolbar"><span>Settings are protected with your PIN for this visit.</span><button className="button button-small button-quiet" onClick={() => { setChangingPin((value) => !value); setPinError(""); }}>{changingPin ? "Cancel PIN change" : "Change settings PIN"}</button></div>
    {changingPin && <form className="panel settings-pin-change" onSubmit={updateSettingsPin}><Field label="Current PIN" name="currentPin" type="password" required minLength={4} /><div className="form-grid"><Field label="New PIN" name="newPin" type="password" required minLength={4} /><Field label="Confirm new PIN" name="confirmPin" type="password" required minLength={4} /></div>{pinError && <p className="field-error" role="alert">{pinError}</p>}<button className="button button-primary button-small" disabled={pinBusy}>Save PIN</button></form>}
    <div className="settings-grid"><section className="panel settings-panel"><div className="panel-heading"><div><span className="eyebrow">ORGANIZATION</span><h3>Imam Ali Center</h3></div><span className="settings-logo" aria-label="IAC logo"><BrandMark /></span></div><div className="settings-row"><span>Organization name</span><strong>Imam Ali Center (IAC)</strong></div><div className="settings-row"><span>Logo</span><strong className="settings-logo-label">IAC Logo</strong></div><div className="settings-row"><span>Event timezone</span><strong>{Intl.DateTimeFormat().resolvedOptions().timeZone}</strong></div><div className="settings-row"><span>Application mode</span><StatusPill tone={context.mode === "demo" ? "warning" : "success"}>{context.mode === "demo" ? "Local account storage" : "Supabase + RLS"}</StatusPill></div><div className="settings-note">Event dates use the local timezone. In connected mode, checklist access and database reads are restricted by Supabase policies.</div></section>
      <section className="panel settings-panel"><div className="panel-heading"><div><span className="eyebrow">ACCESS MODEL</span><h3>Role permissions</h3></div><ShieldCheck size={18} /></div><div className="permission-list">{Object.entries(roleDescriptions).map(([role, detail]) => <div className="permission-row" key={role}><span className="role-chip">{role}</span><p>{detail}</p></div>)}</div></section></div>
    {canManageWorkspace && <><div className="section-divider-title"><span>ADMINISTRATION</span><small>Accounts and access</small></div><TeamPage data={data} user={context.user} context={context} openModal={openModal} refreshKey={refreshKey} /></>}
    {canManageWorkspace && <><div className="section-divider-title"><span>Recent audit history</span><small>{data.audit.length} records</small></div>{data.audit.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>TIME</th><th>USER</th><th>ACTION</th><th>RECORD</th></tr></thead><tbody>{data.audit.slice(0, 20).map((entry) => <tr key={entry.id}><td>{formatStamp(entry.createdAt)}</td><td>{data.profiles.find((item) => item.id === entry.actorId)?.fullName ?? "System user"}</td><td>{entry.action}</td><td>{entry.target}</td></tr>)}</tbody></table></div> : <div className="subtle-empty">Activity is recorded here when changes are made.</div>}</>}
    <div className="sop-notice settings-notice"><Settings2 size={17} /><span>{data.events.length} event records · {data.profiles.length} visible team profiles · {data.assets.length} equipment records. Additional configuration areas are introduced in later releases.</span></div>
  </>;
}

function Modal({ state, data, user, context, onClose, openModal, onSubmit, run, onDeleteAsset }: { state: Exclude<ModalState, null>; data: AppData; user: Profile; context: SessionContext; onClose: () => void; openModal: (state: ModalState) => void; onSubmit: (action: string) => (event: FormEvent<HTMLFormElement>) => void; run: (action: string, payload?: Record<string, unknown>) => Promise<void>; onDeleteAsset: (assetId: string) => Promise<boolean> }) {
  const member = state.member;
  const event = data.events.find((item) => item.id === state.id);
  const eventAssignment = event && data.assignments.find((assignment) => assignment.eventId === event.id && assignment.userId === user.id);
  const eventCrew = event ? data.assignments.filter((assignment) => assignment.eventId === event.id) : [];
  const eventChecklistItems = event ? data.checklistItems.filter((item) => item.eventId === event.id) : [];
  const eventIncidents = event ? data.incidents.filter((item) => item.eventId === event.id) : [];
  const eventTimeline = event ? [...(data.eventActivity ?? []).filter((item) => item.eventId === event.id)].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)) : [];
  
  const asset = data.assets.find((item) => item.id === state.id);
  const assetActiveLoans = data.loans.filter((item) => item.assetId === asset?.id && !item.returnAt);
  const assetAvailableQuantity = asset?.condition === "Good" && ["Available", "Checked out"].includes(asset.status) ? Math.max(0, (asset.quantity ?? 1) - assetActiveLoans.reduce((sum, item) => sum + (item.quantity ?? 1), 0)) : 0;
  const incident = data.incidents.find((item) => item.id === state.id);
  const checklistItem = data.checklistItems.find((item) => item.id === state.id);
  const checklistTemplate = data.checklistTemplates.find((item) => item.id === state.id);
  const equipmentTemplate = data.equipmentTemplates.find((item) => item.id === state.id);
  const checklistEvent = data.events.find((item) => item.id === checklistItem?.eventId);
  const checklistPerson = data.profiles.find((item) => item.id === checklistItem?.userId);
  const sop = data.sops.find((item) => item.id === state.id);
  const loan = data.loans.find((item) => item.id === state.id);
  const loanAsset = loan && data.assets.find((item) => item.id === loan.assetId);
  const loanBorrower = loan && data.profiles.find((item) => item.id === loan.borrowerId);
  const actorIsAdministrator = hasAccessRole(context.user.accessRoles, context.user.role, "Administrator");
  const title: Record<string, string> = {
     "create-event": "Create an event", "edit-event": "Edit event", "create-asset": "Add equipment asset", "edit-asset": "Edit equipment asset", "checkout-equipment": "Log equipment handoff", "report-incident": "Report an issue", "edit-incident": "Edit incident record", "flag-check": "Report a failed check", "resolve-incident": "Record incident resolution", "complete-own-incident": "Complete incident job", "manage-categories": `Manage ${state.id ?? "record"} categories`, "create-sop": "Create an SOP", "edit-sop": `Edit ${sop?.title ?? "SOP"}`, "edit-sop-audience": `Choose who can see ${sop?.title ?? "this SOP"}`, "read-sop": sop?.title ?? "Procedure", "publish-sop": "Publish reviewed procedure", "return-equipment": "Inspect and return equipment", "show-event": event?.title ?? "Event details", "event-report": `Program report · ${event?.title ?? "Event"}`,
    profile: "My profile", "create-checklist-item": "Add an item to a member’s checklist", "edit-checklist-item": "Edit checklist item", "delete-checklist-item": "Remove checklist item", "create-checklist-template": "Create checklist template", "edit-checklist-template": `Edit ${checklistTemplate?.name ?? "checklist template"}`, "quick-assign-checklist": `Send ${checklistTemplate?.name ?? "checklist template"}`, "create-equipment-template": "Create equipment template", "edit-equipment-template": `Edit ${equipmentTemplate?.name ?? "equipment template"}`, "quick-assign-equipment": `Assign ${equipmentTemplate?.name ?? "equipment template"}`,
    "invite-member": "Add a team account", "edit-member": `Edit ${member?.fullName ?? "team member"}`, "edit-member-roles": `Edit app access roles · ${member?.fullName ?? "team member"}`, "set-member-password": `Set password for ${member?.fullName ?? "team member"}`, "credential-reveal": "Temporary sign-in details",
  };
  const people = data.profiles.filter((item) => item.active !== false);
  const borrowers = people;
  const eventOptions = data.events.filter((item) => !["Completed", "Cancelled"].includes(item.status));
  const rememberedPersonId = typeof window === "undefined" ? "" : window.localStorage.getItem(`iac-last-checklist-person-${user.id}`) ?? "";
  const rememberedEquipmentPersonId = (() => {
    if (typeof window === "undefined" || !equipmentTemplate) return "";
    try { return window.localStorage.getItem(`iac-last-equipment-person-${user.id}-${equipmentTemplate.id}`) ?? ""; } catch { return ""; }
  })();
  const categoryKind = state.id as keyof NonNullable<AppData["categories"]>;
  const categoryOptions = categoryKind === "checklists" ? phaseOptions(data) : data.categories?.[categoryKind] ?? categoryDefaults[categoryKind] ?? [];
  const fixedChecklistPhases = categoryKind === "checklists";
   return <div className={`modal-backdrop ${state.type === "event-report" ? "event-report-backdrop" : ""}`} onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><section className={`modal-dialog ${state.type === "read-sop" ? "modal-sop-reading" : ""} ${state.type === "event-report" ? "modal-event-report" : ""}`} role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-head"><div><span className="eyebrow">IAC MEDIA OPERATIONS</span><h2 id="modal-title">{title[state.type] ?? "Details"}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={19} /></button></div>
    {state.type === "profile" && <div className="profile-modal-content"><div className="profile-identity"><ProfileAvatar name={user.fullName} src={user.avatarUrl} className="avatar profile-dialog-avatar" /><span><strong>{user.fullName}</strong><small>{user.role} · {user.email || "Local account"}</small></span></div><form onSubmit={onSubmit("profile_update")} className="modal-form profile-modal-form"><Field label="Username" name="username" required defaultValue={user.username ?? ""} /><ProfilePhotoField name="avatarUrl" personName={user.fullName} initialValue={user.avatarUrl} /><div className="modal-help">You can update your username and profile picture here. Your name and team role are managed by the administrator.</div><ModalActions onClose={onClose} primary="Save profile" /></form><div className="profile-password-heading"><strong>Change password</strong><small>Your current password is never shown to the administrator or stored as readable text.</small></div><form onSubmit={onSubmit("profile_change_password")} className="modal-form profile-modal-form"><Field label="Current password" name="currentPassword" type="password" autoComplete="current-password" required /><div className="form-grid"><Field label="New password" name="newPassword" type="password" autoComplete="new-password" required minLength={4} /><Field label="Confirm new password" name="confirmPassword" type="password" autoComplete="new-password" required minLength={4} /></div><div className="modal-help">Use at least 4 characters. If you do not know your current password, ask the administrator to set a replacement first.</div><ModalActions onClose={onClose} primary="Change password" /></form></div>}
    {state.type === "manage-categories" && <div className="modal-form">{!fixedChecklistPhases && <form onSubmit={onSubmit("add_category")}><input type="hidden" name="categoryType" value={state.id ?? ""} /><Field label="Add a category" name="category" required minLength={2} placeholder="Category name" /><ModalActions onClose={onClose} primary="Add category" /></form>}{fixedChecklistPhases && <div className="modal-help">The five program phases are fixed. Use the arrows to choose their order.</div>}<div className="category-admin-list">{categoryOptions.map((category, index) => <div className="category-admin-row" key={category}><span>{category}</span><div className="category-admin-actions"><button className="icon-button" type="button" title="Move up" aria-label={`Move ${category} up`} disabled={index === 0} onClick={() => void run("reorder_categories", { categoryType: state.id, categories: categoryOptions.map((item, itemIndex) => itemIndex === index ? categoryOptions[index - 1] : itemIndex === index - 1 ? category : item) })}><ChevronDown className="category-move-up" size={14} /></button><button className="icon-button" type="button" title="Move down" aria-label={`Move ${category} down`} disabled={index === categoryOptions.length - 1} onClick={() => void run("reorder_categories", { categoryType: state.id, categories: categoryOptions.map((item, itemIndex) => itemIndex === index ? categoryOptions[index + 1] : itemIndex === index + 1 ? category : item) })}><ChevronDown size={14} /></button>{!fixedChecklistPhases && <form onSubmit={onSubmit("delete_category")}><input type="hidden" name="categoryType" value={state.id ?? ""} /><input type="hidden" name="category" value={category} /><button className="button button-small button-quiet" type="submit" title="Remove category" aria-label={`Remove ${category}`}><Trash2 size={14} />Remove</button></form>}</div></div>)}</div>{!fixedChecklistPhases && <div className="modal-help">Use the arrows to set the order. Removing a category keeps existing records unchanged; it only removes the option for new records.</div>}<div className="modal-actions"><button type="button" className="button button-quiet" onClick={onClose}>Done</button></div></div>}
    {state.type === "create-checklist-template" && <form onSubmit={onSubmit("create_checklist_template")} className="modal-form"><div className="form-grid"><Field label="Template name" name="name" required minLength={2} placeholder="e.g. Standard camera setup" /><Field label="Checklist stage" name="category" as="select" options={phaseOptions(data).map((item) => ({ value: item, label: item }))} defaultValue={phaseOptions(data)[0]} /></div><ChecklistTaskListEditor name="tasks" initialItems={[]} /><div className="modal-help">Saving a template does not assign it. Each quick assignment creates separate tasks for one person and one event.</div><ModalActions onClose={onClose} primary="Save template" /></form>}
    {state.type === "edit-checklist-template" && checklistTemplate && <form onSubmit={onSubmit("update_checklist_template")} className="modal-form"><input type="hidden" name="templateId" value={checklistTemplate.id} /><div className="form-grid"><Field label="Template name" name="name" required minLength={2} defaultValue={checklistTemplate.name} /><Field label="Checklist stage" name="category" as="select" options={phaseOptions(data).map((item) => ({ value: item, label: item }))} defaultValue={checklistTemplate.category ?? phaseOptions(data)[0]} /></div><ChecklistTaskListEditor key={checklistTemplate.id} name="tasks" initialItems={checklistTemplate.tasks} /><div className="modal-help">Changes apply to the saved template. Checklists already assigned stay as they were.</div><ModalActions onClose={onClose} primary="Save template changes" /></form>}
    {state.type === "quick-assign-checklist" && checklistTemplate && <form onSubmit={onSubmit("quick_assign_checklist")} className="modal-form"><input type="hidden" name="templateId" value={checklistTemplate.id} /><div className="form-grid"><Field label="Event" name="eventId" as="select" required options={eventOptions.map((item) => ({ value: item.id, label: `${item.title} · ${displayDate(item.date)}` }))} defaultValue={eventOptions[0]?.id} /><Field label="Team member" name="userId" as="select" required options={people.map((item) => ({ value: item.id, label: `${item.fullName} · ${item.jobTitle || item.role}` }))} defaultValue={people.some((item) => item.id === rememberedPersonId) ? rememberedPersonId : people[0]?.id} /></div><ChecklistTaskListEditor key={`assign-${checklistTemplate.id}`} name="tasks" initialItems={checklistTemplate.tasks} /><div className="modal-help">The last team member you assigned a checklist to is selected automatically. You can change the copied tasks without changing the template.</div><ModalActions onClose={onClose} primary="Send checklist" /></form>}
    {state.type === "create-equipment-template" && <form onSubmit={onSubmit("create_equipment_template")} className="modal-form"><Field label="Template name" name="name" required minLength={2} placeholder="e.g. Audio setup kit" /><EquipmentTemplateItemsEditor name="items" assets={data.assets} initialItems={[]} /><div className="modal-help">Templates save the inventory items and quantities. Each quick assign creates separate handoff records for the selected person.</div><ModalActions onClose={onClose} primary="Save template" /></form>}
    {state.type === "edit-equipment-template" && equipmentTemplate && <form onSubmit={onSubmit("update_equipment_template")} className="modal-form"><input type="hidden" name="templateId" value={equipmentTemplate.id} /><Field label="Template name" name="name" required minLength={2} defaultValue={equipmentTemplate.name} /><EquipmentTemplateItemsEditor key={equipmentTemplate.id} name="items" assets={data.assets} initialItems={equipmentTemplate.items} /><div className="modal-help">Edits update the saved template only. Equipment already handed out is unchanged.</div><ModalActions onClose={onClose} primary="Save changes" /></form>}
    {state.type === "quick-assign-equipment" && equipmentTemplate && <form onSubmit={onSubmit("quick_assign_equipment")} className="modal-form"><input type="hidden" name="templateId" value={equipmentTemplate.id} /><Field label="Team member borrowing the equipment" name="borrowerId" as="select" required options={borrowers.map((item) => ({ value: item.id, label: `${item.fullName} · ${item.jobTitle || item.role}` }))} defaultValue={borrowers.some((item) => item.id === rememberedEquipmentPersonId) ? rememberedEquipmentPersonId : borrowers[0]?.id} /><div className="form-grid"><HandoffDateFields /></div><EquipmentTemplateItemsEditor key={`assign-equipment-${equipmentTemplate.id}`} name="items" assets={data.assets} initialItems={equipmentTemplate.items} /><Field label="Handoff notes" name="checkoutNotes" as="textarea" placeholder="Accessories or details given with the equipment" /><div className="modal-help">The last person assigned this template is selected automatically. You can adjust this handoff’s items without changing the saved template. It records the same individual loan history as a regular handoff.</div><ModalActions onClose={onClose} primary="Record handoff" /></form>}
    {state.type === "create-checklist-item" && <form onSubmit={onSubmit("create_checklist_item")} className="modal-form"><div className="form-grid"><Field label="Team member" name="userId" as="select" required options={people.map((item) => ({ value: item.id, label: `${item.fullName} · ${item.jobTitle || item.role}` }))} /><Field label="Event" name="eventId" as="select" required options={eventOptions.map((item) => ({ value: item.id, label: `${item.title} · ${displayDate(item.date)}` }))} /></div><Field label="Program phase" name="programPhase" as="select" required options={phaseOptions(data).map((phase) => ({ value: phase, label: phase }))} defaultValue={normalizeChecklistProgramPhase(eventOptions[0]?.programPhase) ?? phaseOptions(data)[0]} /><Field label="Checklist item" name="label" required minLength={2} placeholder="e.g. Confirm camera feed and framing" /><CheckboxField name="required" label="Required before the event" checked /><div className="modal-help">This checklist item appears only to the selected member and the administrator.</div><ModalActions onClose={onClose} primary="Add checklist item" /></form>}
    {state.type === "edit-checklist-item" && checklistItem && <form onSubmit={onSubmit("update_checklist_item")} className="modal-form"><input type="hidden" name="itemId" value={checklistItem.id} /><div className="context-callout"><ClipboardCheck size={17} /><span><strong>{checklistPerson?.fullName ?? "Team member"}</strong><small>{checklistPerson?.jobTitle ?? checklistPerson?.role ?? "Production role"} · {checklistEvent?.title ?? "Event"}</small></span></div><Field label="Checklist item" name="label" required minLength={2} defaultValue={checklistItem.label} /><Field label="Program phase" name="programPhase" as="select" required options={phaseOptions(data).map((phase) => ({ value: phase, label: phase }))} defaultValue={checklistItem.programPhase ?? phaseOptions(data)[0]} /><CheckboxField name="required" label="Required before the event" checked={checklistItem.required} /><div className="modal-help">Editing the wording or requirement keeps the current completion status. Required incomplete tasks turn urgent when the event moves to a later phase.</div><ModalActions onClose={onClose} primary="Save checklist item" /></form>}
    {state.type === "delete-checklist-item" && checklistItem && <form onSubmit={onSubmit("delete_checklist_item")} className="modal-form"><input type="hidden" name="itemId" value={checklistItem.id} /><div className="context-callout danger-callout"><Trash2 size={17} /><span><strong>{checklistItem.label}</strong><small>{checklistPerson?.fullName ?? "Assigned member"} · {checklistEvent?.title ?? "Event"}</small></span></div><p className="review-copy">This removes the item from the assigned member’s checklist.</p><ModalActions onClose={onClose} primary="Remove checklist item" /></form>}
      {state.type === "invite-member" && <form onSubmit={onSubmit("team_invite")} className="modal-form"><label className="form-field"><span>Start with one of the team positions you gave me</span><select name="teamPreset" defaultValue="" onChange={(event) => { const preset = teamInvitePresets.find((item) => item.id === event.currentTarget.value); const form = event.currentTarget.form; if (!preset || !form) return; (form.elements.namedItem("fullName") as HTMLInputElement).value = preset.fullName; (form.elements.namedItem("username") as HTMLInputElement).value = preset.username; for (const input of form.querySelectorAll<HTMLInputElement>(`input[name="productionRoles"]`)) input.checked = preset.productionRoles.includes(input.value); for (const input of form.querySelectorAll<HTMLInputElement>(`input[name="accessRoles"]`)) input.checked = preset.accessRoles.includes(input.value as AppRole); }}><option value="">Choose a person or enter details below</option>{teamInvitePresets.filter((preset) => actorIsAdministrator || preset.id !== "jaafar").map((preset) => <option value={preset.id} key={preset.id}>{preset.fullName} · {preset.productionRoles.join(" · ")}</option>)}</select></label><div className="form-grid"><Field label="Full name" name="fullName" required placeholder="Team member name" /><Field label="Username" name="username" required placeholder="first.last" />{context.mode === "supabase" && <Field label="Sign-in email" name="email" type="email" required placeholder="name@example.org" />}</div><div className="form-grid"><ProductionRoleFields selected={["Videography"]} roles={data.categories?.productionRoles ?? productionPositions} /><AccessRoleFields selected={["Videographer"]} includeAdministrator={actorIsAdministrator} /></div><ProfilePhotoField name="avatarUrl" personName="New team member" /><div className="modal-help">{context.mode === "demo" ? "A temporary password is generated and shown once after saving. Share it privately; the admin can reset it any time." : "The person receives a secure password setup email. The administrator can reset their password later."}</div><ModalActions onClose={onClose} primary={context.mode === "demo" ? "Create account" : "Send invitation"} /></form>}
     {state.type === "edit-member-roles" && member && <form onSubmit={onSubmit("team_update_roles")} className="modal-form"><input type="hidden" name="memberId" value={member.id} /><p>Choose the app permissions for this account. The account login itself stays unchanged.</p><AccessRoleFields selected={member.accessRoles ?? [member.role]} includeAdministrator={actorIsAdministrator} /><div className="modal-help">Directors can manage non-administrator roles. Only an administrator can grant or remove Administrator access.</div><ModalActions onClose={onClose} primary="Save access roles" /></form>}
     {state.type === "invite-member" && <form onSubmit={onSubmit("team_invite")} className="modal-form"><label className="form-field"><span>Start with one of the team positions you gave me</span><select name="teamPreset" defaultValue="" onChange={(event) => { const preset = teamInvitePresets.find((item) => item.id === event.currentTarget.value); const form = event.currentTarget.form; if (!preset || !form) return; (form.elements.namedItem("fullName") as HTMLInputElement).value = preset.fullName; (form.elements.namedItem("username") as HTMLInputElement).value = preset.username; for (const input of form.querySelectorAll<HTMLInputElement>(`input[name="productionRoles"]`)) input.checked = preset.productionRoles.includes(input.value); for (const input of form.querySelectorAll<HTMLInputElement>(`input[name="accessRoles"]`)) input.checked = preset.accessRoles.includes(input.value as AppRole); }}><option value="">Choose a person or enter details below</option>{teamInvitePresets.filter((preset) => actorIsAdministrator || preset.id !== "jaafar").map((preset) => <option value={preset.id} key={preset.id}>{preset.fullName} · {preset.productionRoles.join(" · ")}</option>)}</select></label><div className="form-grid"><Field label="Full name" name="fullName" required placeholder="Team member name" /><Field label="Username" name="username" required placeholder="first.last" />{context.mode === "supabase" && <Field label="Sign-in email" name="email" type="email" required placeholder="name@example.org" />}</div><div className="form-grid"><ProductionRoleFields selected={["Videography"]} /><AccessRoleFields selected={["Videographer"]} includeAdministrator={actorIsAdministrator} /></div><ProfilePhotoField name="avatarUrl" personName="New team member" /><div className="modal-help">{context.mode === "demo" ? "A temporary password is generated and shown once after saving. Share it privately; the admin can reset it any time." : "The person receives a secure password setup email. The administrator can reset their password later."}</div><ModalActions onClose={onClose} primary={context.mode === "demo" ? "Create account" : "Send invitation"} /></form>}
     {state.type === "edit-member" && member && <form onSubmit={onSubmit("team_update_member")} className="modal-form"><input type="hidden" name="memberId" value={member.id} /><div className="form-grid"><Field label="Full name" name="fullName" required defaultValue={member.fullName} /><Field label="Username" name="username" required defaultValue={member.username} />{context.mode === "supabase" && <Field label="Sign-in email" name="email" type="email" required defaultValue={member.email} />}</div><div className="form-grid"><ProductionRoleFields selected={selectedProductionRoles(member.jobTitle, data.categories?.productionRoles ?? productionPositions)} roles={data.categories?.productionRoles ?? productionPositions} /><AccessRoleFields selected={member.accessRoles ?? [member.role]} includeAdministrator={actorIsAdministrator} /></div><ProfilePhotoField name="avatarUrl" personName={member.fullName} initialValue={member.avatarUrl} /><CheckboxField name="active" label="Account is active" checked={member.active} /><div className="modal-help">Select every production role this person handles. App access permissions remain separate.</div><div className="modal-help">Only administrators can change administrator accounts or grant administrator access. Directors can manage the other team accounts.</div><ModalActions onClose={onClose} primary="Save account" /></form>}
    {state.type === "set-member-password" && member && <form onSubmit={onSubmit("team_set_password")} className="modal-form"><input type="hidden" name="memberId" value={member.id} /><PasswordField label="New password" name="password" autoComplete="new-password" minLength={4} /><PasswordField label="Confirm new password" name="confirmPassword" autoComplete="new-password" minLength={4} /><div className="modal-help">Use at least 4 characters. The password is stored as a secure hash and cannot be viewed later. Share the new password privately; the member can change it from their profile after signing in.</div><ModalActions onClose={onClose} primary="Set password" /></form>}
    {state.type === "credential-reveal" && <div className="modal-form credential-reveal"><div className="modal-help">This temporary password is shown only now. Save it and give it to the account owner privately. The administrator can set a replacement any time.</div><label className="form-field"><span>Username</span><input readOnly value={state.username ?? ""} /></label><label className="form-field"><span>Temporary password</span><input readOnly value={state.secret ?? ""} /></label><button type="button" className="button button-primary full-button" onClick={(event) => { void navigator.clipboard.writeText(`Username: ${state.username ?? ""}\nTemporary password: ${state.secret ?? ""}`); event.currentTarget.textContent = "Copied login details"; }}>Copy login details</button><div className="modal-actions"><button type="button" className="button button-quiet" onClick={onClose}>Done</button></div></div>}
    {(state.type === "create-event" || state.type === "edit-event") && <form onSubmit={onSubmit(state.type === "create-event" ? "create_event" : "update_event")} className="modal-form">{event && <input type="hidden" name="eventId" value={event.id} />}<div className="form-grid"><Field label="Event title" name="title" required placeholder="e.g. Friday Community Program" defaultValue={event?.title} /><Field label="Category" name="category" as="select" required options={data.categories?.events?.length ? data.categories.events : categoryDefaults.events} defaultValue={event?.category ?? "General"} /><Field label="Date" name="date" type="date" required defaultValue={event?.date} /><Field label="Venue" name="venue" required placeholder="Room or hall" defaultValue={event?.venue ?? "To be confirmed"} /><Field label="Start time" name="startTime" type="time" defaultValue={event?.startTime} /><Field label="End time" name="endTime" type="time" defaultValue={event?.endTime} /><Field label="Setup / arrival time" name="setupTime" type="time" defaultValue={event?.setupTime} /><Field label="Event lead" name="leadId" as="select" options={[{ value: "none", label: "Unassigned" }, ...people.map((item) => ({ value: item.id, label: `${item.fullName} · ${item.jobTitle || item.role}` }))]} defaultValue={event ? event.leadId || "none" : user.id} /></div><CrewAssignmentFields profiles={people} selectedIds={event ? data.assignments.filter((item) => item.eventId === event.id).map((item) => item.userId) : people.map((item) => item.id)} /><Field label="Description" name="description" as="textarea" placeholder="Production overview and event purpose" defaultValue={event?.description} /><div className="checkbox-row"><CheckboxField name="livestream" label="Livestream required" checked={event?.livestream ?? false} /><CheckboxField name="recording" label="Recording required" checked={event?.recording ?? false} /><CheckboxField name="photography" label="Photography required" checked={event?.photography ?? false} /></div>{event && <div className="modal-help">Current coverage: {[event.livestream && "Livestream", event.recording && "Recording", event.photography && "Photography"].filter(Boolean).join(" · ") || "Standard"}. Recheck these options if updating the event.</div>}<Field label="Public event information" name="publicInfo" as="textarea" placeholder="Information appropriate for event attendees" defaultValue={event?.publicInfo} /><Field label="Private production notes" name="privateNotes" as="textarea" placeholder="Internal instructions visible to authorized media staff" defaultValue={event?.privateNotes} /><ModalActions onClose={onClose} primary={event ? "Save event changes" : "Save draft event"} /></form>}
    {state.type === "create-asset" && <form onSubmit={onSubmit("create_asset")} className="modal-form"><div className="form-grid"><Field label="Asset ID" name="assetCode" required placeholder="IAC-BAT-001" /><Field label="Equipment name" name="name" required placeholder="Rechargeable batteries" /><Field label="Category" name="category" as="select" required options={data.categories?.equipment?.length ? data.categories.equipment : categoryDefaults.equipment} /><Field label="Quantity" name="quantity" type="number" required min={1} max={10000} defaultValue="1" /><Field label="Storage location" name="location" placeholder="Media Room · Shelf B" /><Field label="Manufacturer / model" name="model" /><Field label="Serial number (if applicable)" name="serial" /><Field label="Initial condition" name="condition" as="select" options={["Good", "Needs service", "Damaged"]} /></div><Field label="Notes" name="notes" as="textarea" placeholder="Record verified details only" /><div className="modal-help">Enter a single inventory record and the number of matching items you have. You can hand out part of the quantity and track how many remain.</div><ModalActions onClose={onClose} primary="Add to inventory" /></form>}{state.type === "edit-asset" && asset && <form onSubmit={onSubmit("update_asset")} className="modal-form"><input type="hidden" name="assetId" value={asset.id} /><div className="form-grid"><Field label="Asset ID" name="assetCode" required defaultValue={asset.assetCode} /><Field label="Equipment name" name="name" required defaultValue={asset.name} /><Field label="Category" name="category" as="select" required options={[...(data.categories?.equipment?.length ? data.categories.equipment : categoryDefaults.equipment), ...(asset.category && !(data.categories?.equipment ?? categoryDefaults.equipment).includes(asset.category) ? [asset.category] : [])]} defaultValue={asset.category} /><Field label="Quantity" name="quantity" type="number" required min={1} max={10000} defaultValue={String(asset.quantity ?? 1)} /><Field label="Storage location" name="location" defaultValue={asset.location} /><Field label="Manufacturer / model" name="model" defaultValue={asset.model} /><Field label="Serial number (if applicable)" name="serial" defaultValue={asset.serial} /><Field label="Condition" name="condition" as="select" required options={["Good", "Needs service", "Damaged"]} defaultValue={asset.condition} /></div><Field label="Notes" name="notes" as="textarea" defaultValue={asset.notes} /><div className="modal-help">Quantity cannot be reduced below the number of units currently borrowed. The administrator, director, or equipment manager can edit inventory.</div><div className="modal-actions asset-edit-actions"><button type="button" className="button button-quiet danger-text" onClick={async () => { if (!window.confirm(`Delete ${asset.name} (${asset.assetCode}) from the inventory? This cannot be undone.`)) return; if (await onDeleteAsset(asset.id)) onClose(); }}>Delete equipment</button><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button type="submit" className="button button-primary">Save equipment changes<ArrowRight size={15} /></button></div></form>}
    {state.type === "checkout-equipment" && <form onSubmit={onSubmit("issue_equipment")} className="modal-form"><div className="context-callout"><ArrowDownToLine size={17} /><span><strong>{asset?.name ?? "Equipment"}</strong><small>{asset?.assetCode} · {assetAvailableQuantity} of {asset?.quantity ?? 1} available · {asset?.location}</small></span></div><fieldset className="crew-assignment-fieldset checkout-person-picker"><legend>Tap the person borrowing this item</legend><p>The selected name will be recorded on the equipment card and handoff history.</p><div className="checkout-person-grid">{borrowers.map((person) => <label className="checkout-person-option" key={person.id}><input type="radio" name="borrowerId" value={person.id} required /><span><strong>{person.fullName}</strong><small>{person.jobTitle || person.role}</small></span></label>)}</div></fieldset><div className="form-grid"><Field label="Quantity to hand out" name="quantity" type="number" required min={1} max={assetAvailableQuantity} defaultValue="1" /><HandoffDateFields /><span className="condition-note">Condition at handoff: <strong>{asset?.condition ?? "Unknown"}</strong></span></div><Field label="Handoff notes" name="checkoutNotes" as="textarea" placeholder="Accessories or details given with the equipment" /><div className="modal-help">Tap a team member’s name, then record the handoff before giving them the equipment in person.</div><ModalActions onClose={onClose} primary="Record handoff" /></form>}
    {state.type === "report-incident" && <form onSubmit={onSubmit("report_incident")} className="modal-form"><div className="form-grid"><Field label="Event (if applicable)" name="eventId" as="select" options={[{ value: "", label: "Not event-specific" }, ...data.events.map((item) => ({ value: item.id, label: `${item.title} · ${displayDate(item.date)}` }))]} /><Field label="Equipment (if applicable)" name="assetId" as="select" options={[{ value: "", label: "No equipment selected" }, ...data.assets.map((item) => ({ value: item.id, label: `${item.assetCode} · ${item.name}` }))]} /><Field label="Issue category" name="category" as="select" required options={data.categories?.incidents?.length ? data.categories.incidents : categoryDefaults.incidents} /><Field label="Severity" name="severity" as="select" required options={["Low", "Medium", "High", "Critical"]} /></div><Field label="What happened?" name="description" as="textarea" required minLength={1} placeholder="Describe the issue and its impact" /><Field label="Immediate action taken" name="immediateAction" as="textarea" placeholder="Steps taken to keep people or equipment safe" /><IncidentPhotosField /><div className="modal-help">Your report and photos are visible to you and the administrator/director. Equipment managers can report equipment damage.</div><ModalActions onClose={onClose} primary="Submit incident" /></form>}
    {state.type === "flag-check" && <form onSubmit={onSubmit("complete_checklist_item")} className="modal-form"><div className="context-callout danger-callout"><AlertTriangle size={17} /><span><strong>{data.checklistItems.find((item) => item.id === state.id)?.label ?? "Required check"}</strong><small>This will keep the event marked as needing attention.</small></span></div><Field label="Describe the failed check" name="note" as="textarea" required minLength={5} placeholder="What failed and who has been notified?" /><ModalActions onClose={onClose} primary="Report issue" /></form>}
    {state.type === "resolve-incident" && <form onSubmit={onSubmit("resolve_incident")} className="modal-form"><div className="context-callout"><CheckCircle2 size={17} /><span><strong>{incident?.category}</strong><small>{incident?.description}</small></span></div><Field label="Action taken to complete the job" name="resolution" as="textarea" required minLength={1} placeholder="What was repaired, replaced, or followed up?" /><ModalActions onClose={onClose} primary="Record resolution" /></form>}{state.type === "complete-own-incident" && incident && <form onSubmit={onSubmit("complete_own_incident")} className="modal-form"><input type="hidden" name="incidentId" value={incident.id} /><div className="context-callout"><CheckCircle2 size={17} /><span><strong>{incident.category}</strong><small>{incident.description}</small></span></div><Field label="What did you do to fix it?" name="resolution" as="textarea" required minLength={1} placeholder="Describe the repair or action that completed this job" /><IncidentPhotosField initialValue={incident.photos ?? []} /><ModalActions onClose={onClose} primary="Mark job completed" /></form>}{state.type === "edit-incident" && incident && <form onSubmit={onSubmit("update_incident")} className="modal-form"><input type="hidden" name="incidentId" value={incident.id} /><div className="form-grid"><Field label="Event (if applicable)" name="eventId" as="select" options={[{ value: "", label: "Not event-specific" }, ...data.events.map((item) => ({ value: item.id, label: `${item.title} · ${displayDate(item.date)}` }))]} defaultValue={incident.eventId ?? ""} /><Field label="Equipment (if applicable)" name="assetId" as="select" options={[{ value: "", label: "No equipment selected" }, ...data.assets.map((item) => ({ value: item.id, label: `${item.assetCode} · ${item.name}` }))]} defaultValue={incident.assetId ?? ""} /><Field label="Issue category" name="category" as="select" required options={[...(data.categories?.incidents?.length ? data.categories.incidents : categoryDefaults.incidents), ...(incident.category && !(data.categories?.incidents ?? categoryDefaults.incidents).includes(incident.category) ? [incident.category] : [])]} defaultValue={incident.category} /><Field label="Severity" name="severity" as="select" required options={["Low", "Medium", "High", "Critical"]} defaultValue={incident.severity} /><Field label="Status" name="status" as="select" required options={["Open", "Acknowledged", "In progress", "Resolved", "Closed"]} defaultValue={incident.status} /></div><Field label="What happened?" name="description" as="textarea" required minLength={1} defaultValue={incident.description} /><Field label="Immediate action taken" name="immediateAction" as="textarea" defaultValue={incident.immediateAction ?? ""} /><IncidentPhotosField initialValue={incident.photos ?? []} /><Field label="Resolution notes" name="resolution" as="textarea" defaultValue={incident.resolution ?? ""} /><div className="modal-help">You can edit this record even after it has been resolved or closed.</div><ModalActions onClose={onClose} primary="Save incident changes" /></form>}
    {state.type === "create-sop" && <form onSubmit={onSubmit("save_rich_sop")} className="modal-form rich-sop-form"><div className="form-grid"><Field label="Procedure title" name="title" required placeholder="e.g. Wireless microphone check" /><Field label="Category" name="category" as="select" options={data.categories?.sops?.length ? data.categories.sops : categoryDefaults.sops} /></div><Field label="Purpose and scope" name="purpose" as="textarea" placeholder="Explain when this procedure is used and who it is for" /><RichSopEditor mode={context.mode} initialBlocks={[]} /><label className="checkbox-field"><input type="checkbox" name="availableToAll" defaultChecked /><span>Available to all team members</span></label><fieldset className="crew-assignment-fieldset"><legend>Assign to specific team members</legend><p>When “Available to all” is off, only selected people can see this procedure.</p><div className="crew-assignment-grid">{people.map((person) => <label className="checkbox-field crew-assignment-option" key={person.id}><input type="checkbox" name="assignedUserIds" value={person.id} /><span><strong>{person.fullName}</strong><small>{person.jobTitle || person.role}</small></span></label>)}</div></fieldset><div className="modal-help">Saved as a draft. A technical lead must verify local instructions before publishing.</div><ModalActions onClose={onClose} primary="Save SOP draft" /></form>}
    {state.type === "edit-sop" && sop && <form onSubmit={onSubmit("save_rich_sop")} className="modal-form rich-sop-form"><input type="hidden" name="sopId" value={sop.id} /><div className="form-grid"><Field label="Procedure title" name="title" required defaultValue={sop.title} /><Field label="Category" name="category" as="select" options={[...(data.categories?.sops?.length ? data.categories.sops : categoryDefaults.sops), ...(data.categories?.sops?.includes(sop.category) ? [] : [sop.category])]} defaultValue={sop.category} /></div><Field label="Purpose and scope" name="purpose" as="textarea" defaultValue={sop.summary} /><RichSopEditor key={sop.id} mode={context.mode} sopId={sop.id} initialBlocks={defaultSopContent(sop)} /><label className="checkbox-field"><input type="checkbox" name="availableToAll" defaultChecked={sop.availableToAll !== false} /><span>Available to all team members</span></label><fieldset className="crew-assignment-fieldset"><legend>Assign to specific team members</legend><div className="crew-assignment-grid">{people.map((person) => <label className="checkbox-field crew-assignment-option" key={person.id}><input type="checkbox" name="assignedUserIds" value={person.id} defaultChecked={sop.assignedUserIds?.includes(person.id) ?? false} /><span><strong>{person.fullName}</strong><small>{person.jobTitle || person.role}</small></span></label>)}</div></fieldset><div className="modal-help">Saving creates a new draft version. Existing versions remain in the SOP history for review.</div><ModalActions onClose={onClose} primary="Save new draft version" /></form>}
    {state.type === "edit-sop-audience" && sop && <form onSubmit={onSubmit("update_sop_audience")} className="modal-form"><input type="hidden" name="sopId" value={sop.id} /><label className="checkbox-field"><input type="checkbox" name="availableToAll" defaultChecked={sop.availableToAll !== false} /><span>Show this SOP to every crew member</span></label><fieldset className="crew-assignment-fieldset"><legend>Show to selected team members</legend><p>When “Show to every crew member” is off, only selected members can see it.</p><div className="crew-assignment-grid">{people.map((person) => <label className="checkbox-field crew-assignment-option" key={person.id}><input type="checkbox" name="assignedUserIds" value={person.id} defaultChecked={sop.assignedUserIds?.includes(person.id) ?? false} /><span><strong>{person.fullName}</strong><small>{person.jobTitle || person.role}</small></span></label>)}</div></fieldset><ModalActions onClose={onClose} primary="Save SOP visibility" /></form>}
    {state.type === "publish-sop" && <form onSubmit={onSubmit("publish_sop")} className="modal-form"><div className="context-callout"><BookOpen size={17} /><span><strong>{sop?.title}</strong><small>Version {sop?.version} · {sop?.category}</small></span></div><p className="review-copy">Confirm that an authorized IAC technical lead reviewed the procedure and that all equipment-specific details are accurate.</p><CheckboxField name="reviewConfirmed" label="Technical lead review is complete and details are verified" required /><ModalActions onClose={onClose} primary="Publish procedure" /></form>}
    {state.type === "return-equipment" && <form onSubmit={onSubmit("return_equipment")} className="modal-form"><div className="context-callout"><ArrowDownToLine size={17} /><span><strong>Inspect before completing return</strong><small>{loanAsset?.name ?? "Equipment"} · {loan?.quantity ?? 1} unit{(loan?.quantity ?? 1) === 1 ? "" : "s"} · borrowed by {loanBorrower?.fullName ?? "team member"}</small></span></div><Field label="Return condition" name="condition" as="select" required options={["Good", "Needs service", "Damaged"]} /><Field label="Inspection notes" name="notes" as="textarea" placeholder="Record visible damage, missing accessories, or maintenance needs" /><div className="modal-help">Recording the return closes this person’s loan and updates the equipment’s availability.</div><ModalActions onClose={onClose} primary="Record return" /></form>}
    {state.type === "read-sop" && sop && <div className="sop-detail"><div className="sop-detail-meta"><StatusPill tone={sop.status === "Published" ? "success" : "warning"}>{sop.status}</StatusPill><span>{sop.category} · v{sop.version}</span>{sop.reviewRequired && <span className="danger-text">Requires IAC technical review</span>}</div>{sop.summary && <p className="sop-purpose">{sop.summary}</p>}<SopRichContentView sop={sop} />{sop.reviewRequired && <div className="sop-review-warning"><AlertTriangle size={16} />This draft requires local technical review before it can be used as an approved procedure.</div>}{hasManagerAccess(user.accessRoles, user.role) && <div className="sop-reader-actions"><button type="button" className="button button-quiet" onClick={() => openModal({ type: "edit-sop", id: sop.id })}>Edit SOP</button>{sop.status === "Draft" && <button type="button" className="button button-primary sop-publish-button" onClick={() => openModal({ type: "publish-sop", id: sop.id })}>Review & publish</button>}</div>}</div>}
    {state.type === "event-report" && event && hasManagerAccess(user.accessRoles, user.role) && <div className="event-report-content"><div className="event-report-toolbar"><span>Generated {formatStamp(new Date().toISOString())}</span><button type="button" className="button button-primary" onClick={() => window.print()}><FileText size={15} />Print / save PDF</button></div><div className="event-report-summary"><div><small>EVENT</small><strong>{event.title}</strong></div><div><small>DATE & VENUE</small><strong>{displayDate(event.date)} · {event.venue}</strong></div><div><small>PROGRAM START</small><strong>{event.startedAt ? formatStamp(event.startedAt) : "Not started"}</strong></div><div><small>PROGRAM END</small><strong>{event.endedAt ? formatStamp(event.endedAt) : "Not ended"}</strong></div></div><section className="event-report-section"><h3>Attendance · {eventCrew.filter((item) => item.response === "Accepted").length} confirmed of {eventCrew.length} assigned</h3>{eventCrew.length ? <div className="event-report-list">{eventCrew.map((assignment) => { const person = data.profiles.find((item) => item.id === assignment.userId); return <div key={assignment.id}><span><strong>{person?.fullName ?? "Team member"}</strong><small>{assignment.roleName}</small></span><StatusPill tone={assignment.response === "Accepted" ? "success" : assignment.response === "Declined" ? "danger" : "warning"}>{assignment.response === "Accepted" ? "Attending" : assignment.response === "Declined" ? "Not attending" : "Awaiting"}</StatusPill></div>; })}</div> : <p>No crew assigned.</p>}</section><section className="event-report-section"><h3>Checklist · {eventChecklistItems.filter((item) => item.status === "Complete").length} of {eventChecklistItems.length} complete</h3>{eventChecklistItems.length ? <div className="event-report-list">{eventChecklistItems.map((item) => <div key={item.id}><span><strong>{item.label}</strong><small>{data.profiles.find((person) => person.id === item.userId)?.fullName ?? "Team member"}{item.required ? " · Required" : " · Optional"}</small></span><StatusPill tone={item.status === "Complete" ? "success" : item.status === "Needs attention" ? "danger" : "warning"}>{item.status}</StatusPill></div>)}</div> : <p>No checklist tasks assigned.</p>}</section><section className="event-report-section"><h3>Incident reports · {eventIncidents.length}</h3>{eventIncidents.length ? <div className="event-report-list">{eventIncidents.map((incident) => <div key={incident.id}><span><strong>{incident.category} · {incident.severity}</strong><small>{data.profiles.find((person) => person.id === incident.reportedBy)?.fullName ?? "Team member"} · {formatStamp(incident.createdAt)} · {incident.description}</small>{incident.resolution && <small>Resolution: {incident.resolution}</small>}</span><StatusPill tone={incident.status === "Resolved" || incident.status === "Closed" ? "success" : "warning"}>{incident.status}</StatusPill></div>)}</div> : <p>No event-linked incidents were reported.</p>}</section><section className="event-report-section"><h3>Chronological program activity · {eventTimeline.length}</h3>{eventTimeline.length ? <ol className="event-report-timeline">{eventTimeline.map((item) => <li key={item.id}><time>{formatStamp(item.occurredAt)}</time><span><strong>{data.profiles.find((person) => person.id === item.actorId)?.fullName ?? "Team member"}</strong><small>{item.summary}</small></span></li>)}</ol> : <p>Activity will appear here while the program is running. This includes roster, checklist, incident, and equipment handoff changes.</p>}</section><p className="event-report-footnote">This report includes activity recorded by the app while the program was running. Equipment actions without an event context stay in the equipment history.</p></div>}
    {state.type === "show-event" && event && <div className="event-modal-content"><div className="event-modal-date"><CalendarDays size={16} />{displayDate(event.date)} · {displayTime(event.startTime)}–{displayTime(event.endTime)}</div><div className="event-phase-modal"><span><small>CURRENT PROGRAM PHASE</small><strong><Clock3 size={14} />{event.programPhase ?? phaseOptions(data)[0]}</strong></span>{can(user.accessRoles ?? user.role, "manage_events") && <div className="program-phase-picker-field modal-program-phase-picker"><span>Change phase</span><ProgramPhaseButtons data={data} event={event} onSelect={(phase) => void run("set_event_program_phase", { eventId: event.id, programPhase: phase })} /><small>Required incomplete tasks from earlier phases are marked urgent.</small></div>}</div><div className="event-details-grid"><span><small>VENUE</small><strong>{event.venue}</strong></span><span><small>SETUP / ARRIVAL</small><strong>{displayTime(event.setupTime)}</strong></span><span><small>CATEGORY</small><strong>{event.category}</strong></span><span><small>PROGRAM START</small><strong>{event.startedAt ? formatStamp(event.startedAt) : "Not started"}</strong></span><span><small>PROGRAM END</small><strong>{event.endedAt ? formatStamp(event.endedAt) : "Not ended"}</strong></span></div><div className="event-modal-crew"><small>CREW ATTENDANCE · {eventCrew.filter((assignment) => assignment.response === "Accepted").length} attending · {eventCrew.filter((assignment) => assignment.response === "Declined").length} not attending · {eventCrew.filter((assignment) => assignment.response === "Pending").length} awaiting</small>{eventCrew.length ? <div className="event-crew-list">{eventCrew.map((assignment) => { const person = data.profiles.find((item) => item.id === assignment.userId); return <div className="event-crew-line" key={assignment.id}><span>{person?.fullName ?? assignment.roleName}<small>{assignment.roleName}</small></span>{<StatusPill tone={assignment.response === "Accepted" ? "success" : assignment.response === "Declined" ? "danger" : "warning"}>{assignment.response === "Accepted" ? "Attending" : assignment.response === "Declined" ? "Not attending" : "No response"}</StatusPill>}</div>; })}</div> : <div className="subtle-empty">No crew assigned.</div>}</div><p>{event.description}</p>{event.publicInfo && <div className="public-note">{event.publicInfo}</div>}{event.privateNotes && isStaff(user.role) && <div className="private-note"><ShieldCheck size={15} /><span><small>INTERNAL NOTE</small>{event.privateNotes}</span></div>}{event.status === "Published" && eventAssignment && <div className="rsvp-actions"><span>{eventAssignment.response === "Accepted" ? "You’re attending" : eventAssignment.response === "Declined" ? "You can’t attend" : "Can you attend?"}</span><div className="rsvp-buttons"><button className="button button-small button-primary" onClick={() => void run("set_event_response", { assignmentId: eventAssignment.id, response: "Accepted" })}>I can attend</button><button className="button button-small button-quiet" onClick={() => void run("set_event_response", { assignmentId: eventAssignment.id, response: "Declined" })}>I can’t attend</button></div></div>}{hasManagerAccess(user.accessRoles, user.role) && <div className="event-management-actions modal-event-actions">{can(user.accessRoles ?? user.role, "manage_events") && event.status === "Published" && !event.startedAt && <button type="button" className="button button-small button-primary" onClick={() => void run("start_event_program", { eventId: event.id })}>Start program</button>}{can(user.accessRoles ?? user.role, "manage_events") && event.status === "Published" && event.startedAt && !event.endedAt && <button type="button" className="button button-small button-danger" onClick={() => { if (window.confirm(`End the program “${event.title}” and notify its crew?`)) void run("end_event_program", { eventId: event.id }); }}>End program</button>}<button type="button" className="button button-small button-quiet" onClick={() => openModal({ type: "event-report", id: event.id })}>Event report</button></div>}</div>}
  </section></div>;
}

function CrewAssignmentFields({ profiles, selectedIds }: { profiles: Profile[]; selectedIds: string[] }) {
  return <fieldset className="crew-assignment-fieldset"><legend>Who should be here?</legend><p>Every active crew member starts selected. Adjust the event crew as needed.</p><div className="crew-assignment-grid">{profiles.map((person) => <label className="checkbox-field crew-assignment-option" key={person.id}><input type="checkbox" name="assignedUserIds" value={person.id} defaultChecked={selectedIds.includes(person.id)} /><span><strong>{person.fullName}</strong><small>{person.jobTitle || person.role}</small></span></label>)}</div></fieldset>;
}

function ChecklistTaskListEditor({ name, initialItems }: { name: string; initialItems: ChecklistTemplateTask[] }) {
  const [tasks, setTasks] = useState<ChecklistTemplateTask[]>(() => initialItems.map((task) => ({ ...task })));
  const updateTask = (taskId: string, updates: Partial<ChecklistTemplateTask>) => setTasks((current) => current.map((task) => task.id === taskId ? { ...task, ...updates } : task));
  return <section className="checklist-task-editor"><div className="checklist-task-editor-heading"><strong>Tasks</strong><small>Add the steps in the order the crew should complete them.</small></div>{tasks.length ? <div className="checklist-task-editor-list">{tasks.map((task, index) => <div className="checklist-task-editor-row" key={task.id}><label className="form-field"><span>Task {index + 1}</span><input value={task.label} onChange={(event) => updateTask(task.id, { label: event.currentTarget.value })} placeholder="Describe one checklist task" /></label><label className="checkbox-field"><input type="checkbox" checked={task.required} onChange={(event) => updateTask(task.id, { required: event.currentTarget.checked })} /><span>Required</span></label><button type="button" className="icon-button" aria-label={`Remove task ${index + 1}`} title="Remove task" onClick={() => setTasks((current) => current.filter((item) => item.id !== task.id))}><Trash2 size={14} /></button></div>)}</div> : <div className="subtle-empty">Add at least one task to save this template.</div>}<button type="button" className="button button-small button-quiet checklist-add-task" onClick={() => setTasks((current) => [...current, { id: crypto.randomUUID(), label: "", required: true }])}><Plus size={14} />Add task</button><input type="hidden" name={name} value={JSON.stringify(tasks)} /></section>;
}

function HandoffDateFields() {
  const [dates, setDates] = useState(() => {
    const today = localCalendarDate();
    return { handoffDate: today, dueDate: today, dueDateChanged: false };
  });
  return <>
    <label className="form-field"><span>Handoff date<i> *</i></span><input name="handoffDate" type="date" required value={dates.handoffDate} onChange={(event) => { const handoffDate = event.currentTarget.value; setDates((current) => ({ ...current, handoffDate, dueDate: current.dueDateChanged ? current.dueDate : handoffDate })); }} /></label>
    <label className="form-field"><span>Due back</span><input name="dueDate" type="date" value={dates.dueDate} onChange={(event) => { const dueDate = event.currentTarget.value; setDates((current) => ({ ...current, dueDate, dueDateChanged: true })); }} /></label>
  </>;
}

function EquipmentTemplateItemsEditor({ name, assets, initialItems }: { name: string; assets: AppData["assets"]; initialItems: EquipmentTemplateItem[] }) {
  const [items, setItems] = useState<EquipmentTemplateItem[]>(() => initialItems.map((item) => ({ ...item })));
  const updateItem = (itemId: string, updates: Partial<EquipmentTemplateItem>) => setItems((current) => current.map((item) => {
    if (item.id !== itemId) return item;
    const next = { ...item, ...updates };
    const asset = assets.find((row) => row.id === next.assetId);
    if (asset && next.quantity > (asset.quantity ?? 1)) next.quantity = asset.quantity ?? 1;
    return next;
  }));
  const addItem = () => setItems((current) => {
    const nextAsset = assets.find((asset) => !current.some((item) => item.assetId === asset.id));
    if (!nextAsset) return current;
    return [...current, { id: crypto.randomUUID(), assetId: nextAsset.id, quantity: 1 }];
  });
  return <section className="checklist-task-editor equipment-template-items-editor"><div className="checklist-task-editor-heading"><strong>Equipment items</strong><small>Choose each inventory item once and set the quantity for this bundle.</small></div>{items.length ? <div className="checklist-task-editor-list">{items.map((item, index) => {
    const selectedElsewhere = new Set(items.filter((row) => row.id !== item.id).map((row) => row.assetId));
    const availableAssets = assets.filter((asset) => asset.id === item.assetId || !selectedElsewhere.has(asset.id));
    const selectedAsset = assets.find((asset) => asset.id === item.assetId);
    return <div className="checklist-task-editor-row equipment-template-item-row" key={item.id}><label className="form-field"><span>Item {index + 1}</span><select required value={item.assetId} onChange={(event) => updateItem(item.id, { assetId: event.currentTarget.value })}>{availableAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.assetCode} · {asset.name} ({asset.quantity ?? 1} total)</option>)}</select></label><label className="form-field"><span>Quantity</span><input type="number" min={1} max={selectedAsset?.quantity ?? 1} step={1} required value={item.quantity} onChange={(event) => updateItem(item.id, { quantity: Number(event.currentTarget.value) || 1 })} /></label><button type="button" className="icon-button" aria-label={`Remove equipment item ${index + 1}`} title="Remove item" onClick={() => setItems((current) => current.filter((row) => row.id !== item.id))}><Trash2 size={14} /></button></div>;
  })}</div> : <div className="subtle-empty">Add at least one inventory item to this template.</div>}<button type="button" className="button button-small button-quiet checklist-add-task" disabled={!assets.some((asset) => !items.some((item) => item.assetId === asset.id))} onClick={addItem}><Plus size={14} />Add equipment</button><input type="hidden" name={name} value={JSON.stringify(items)} /></section>;
}

function Field({ label, name, type = "text", required = false, placeholder, defaultValue, minLength, min, max, autoComplete, options, as }: { label: string; name: string; type?: string; required?: boolean; placeholder?: string; defaultValue?: string; minLength?: number; min?: number; max?: number; autoComplete?: string; options?: (string | { value: string; label: string })[]; as?: "textarea" | "select" }) {
  const control = as === "textarea" ? <textarea name={name} required={required} minLength={minLength} placeholder={placeholder} defaultValue={defaultValue} rows={3} /> : as === "select" ? <select name={name} required={required} defaultValue={defaultValue ?? ""}><option value="" disabled>{required ? "Choose one" : "Select if applicable"}</option>{options?.map((option) => { const value = typeof option === "string" ? option : option.value; const labelText = typeof option === "string" ? option : option.label; return <option value={value} key={value}>{labelText}</option>; })}</select> : <input name={name} type={type} required={required} minLength={minLength} min={min} max={max} step={type === "number" ? 1 : undefined} autoComplete={autoComplete} placeholder={placeholder} defaultValue={defaultValue} />;
  return <label className="form-field"><span>{label}{required && <i> *</i>}</span>{control}</label>;
}

function PasswordField({ label, name, autoComplete, minLength }: { label: string; name: string; autoComplete: string; minLength: number }) {
  const [visible, setVisible] = useState(false);
  return <div className="form-field"><span id={`${name}-label`}>{label} *</span><div className="password-input-wrap"><input aria-labelledby={`${name}-label`} name={name} type={visible ? "text" : "password"} autoComplete={autoComplete} minLength={minLength} maxLength={128} required /><button type="button" className="button button-small button-quiet password-visibility" aria-label={visible ? "Hide password" : "Show password"} aria-pressed={visible} onClick={() => setVisible((current) => !current)}>{visible ? "Hide" : "Show"}</button></div></div>;
}

function CheckboxField({ name, label, required = false, checked = false }: { name: string; label: string; required?: boolean; checked?: boolean }) { return <label className="checkbox-field"><input name={name} type="checkbox" required={required} defaultChecked={checked} /><span>{label}</span></label>; }

function ProductionRoleFields({ selected, roles = productionPositions }: { selected: string[]; roles?: string[] }) {
  return <fieldset className="form-field access-role-field production-role-field"><legend>Production roles</legend><div className="access-role-grid">{roles.map((role) => <label className="checkbox-field" key={role}><input name="productionRoles" type="checkbox" value={role} defaultChecked={selected.includes(role)} /><span>{role}</span></label>)}</div><small>Select all production jobs this person handles. Administrators can add or remove roles from Team member accounts.</small></fieldset>;
}

function AccessRoleFields({ selected, includeAdministrator = true }: { selected: AppRole[]; includeAdministrator?: boolean }) {
  const selectableRoles = accessRoles.filter((role) => includeAdministrator || role !== "Administrator");
  return <fieldset className="form-field access-role-field"><legend>App access roles</legend><div className="access-role-grid">{selectableRoles.map((role) => <label className="checkbox-field" key={role}><input name="accessRoles" type="checkbox" value={role} defaultChecked={selected.includes(role)} /><span>{role}</span></label>)}</div><small>A person can have more than one role. Their permissions combine. Only an administrator can grant administrator access.</small></fieldset>;
}

function ModalActions({ onClose, primary }: { onClose: () => void; primary: string }) { return <div className="modal-actions"><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button type="submit" className="button button-primary">{primary}<ArrowRight size={15} /></button></div>; }
