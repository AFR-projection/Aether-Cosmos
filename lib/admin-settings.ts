import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";

export interface AdminSettings {
  maintenanceMode: boolean;
  maintenanceMessage: string;
  defaultQuotaGB: number;
  maxUploadSizeMB: number;
  allowedMimeTypes: string[];
  blockedExtensions: string[];
  sessionDurationHours: number;
  maxSessionsPerUser: number;
  registrationEnabled: boolean;
  maxFileLifetimeDays: number;
  storageWarningThreshold: number;
  autoDeleteTrashDays: number;
  rateLimitPerMinute: number;
  logRetentionDays: number;
  /** Require every user to set a 2-Step Code; enrolment is forced at next login. */
  stepCodeRequired: boolean;
  // ── Email delivery (smart router) ──
  /** Default per-sender daily send cap when a sender doesn't set its own. */
  emailDailyLimitPerSender: number;
  /** Consecutive failures before a sender is put on cooldown. */
  emailFailureThreshold: number;
  /** How long (minutes) a sender rests after hitting the failure threshold. */
  emailCooldownMinutes: number;
}

export const DEFAULT_ADMIN_SETTINGS: AdminSettings = {
  maintenanceMode: false,
  maintenanceMessage: "System is under maintenance. Please check back later.",
  defaultQuotaGB: 10,
  maxUploadSizeMB: 500,
  allowedMimeTypes: ["*/*"],
  blockedExtensions: [".exe", ".bat", ".cmd", ".com", ".msi", ".scr", ".vbs", ".ps1", ".sh"],
  sessionDurationHours: 168,
  maxSessionsPerUser: 10,
  registrationEnabled: false,
  maxFileLifetimeDays: 0,
  storageWarningThreshold: 85,
  autoDeleteTrashDays: 30,
  rateLimitPerMinute: 60,
  logRetentionDays: 90,
  stepCodeRequired: false,
  emailDailyLimitPerSender: 400,
  emailFailureThreshold: 3,
  emailCooldownMinutes: 30,
};

const CACHE_TTL_MS = 30_000;
const SETTINGS_ID = "default";

type CacheEntry = { value: AdminSettings; fetchedAt: number };

let memoryCache: CacheEntry | null = null;
/** Warm sync snapshot for hot paths that cannot await (after first load). */
let syncSnapshot: AdminSettings = { ...DEFAULT_ADMIN_SETTINGS };

function normalizeSettings(raw: Partial<AdminSettings> | null | undefined): AdminSettings {
  const merged = { ...DEFAULT_ADMIN_SETTINGS, ...(raw ?? {}) };

  // Strip removed fake fields if present in old DB JSON
  const cleaned = { ...merged } as AdminSettings & Record<string, unknown>;
  delete cleaned.smtpConfigured;
  delete cleaned.backupEnabled;
  delete cleaned.backupSchedule;

  return {
    maintenanceMode: !!cleaned.maintenanceMode,
    maintenanceMessage:
      typeof cleaned.maintenanceMessage === "string" && cleaned.maintenanceMessage.trim()
        ? cleaned.maintenanceMessage
        : DEFAULT_ADMIN_SETTINGS.maintenanceMessage,
    defaultQuotaGB: clamp(Number(cleaned.defaultQuotaGB), 1, 10000, DEFAULT_ADMIN_SETTINGS.defaultQuotaGB),
    maxUploadSizeMB: clamp(Number(cleaned.maxUploadSizeMB), 1, 5120, DEFAULT_ADMIN_SETTINGS.maxUploadSizeMB),
    allowedMimeTypes: Array.isArray(cleaned.allowedMimeTypes) && cleaned.allowedMimeTypes.length
      ? cleaned.allowedMimeTypes.map(String)
      : [...DEFAULT_ADMIN_SETTINGS.allowedMimeTypes],
    blockedExtensions: Array.isArray(cleaned.blockedExtensions)
      ? cleaned.blockedExtensions.map((e) => {
          const s = String(e).trim().toLowerCase();
          return s.startsWith(".") ? s : `.${s}`;
        })
      : [...DEFAULT_ADMIN_SETTINGS.blockedExtensions],
    sessionDurationHours: clamp(
      Number(cleaned.sessionDurationHours),
      1,
      8760,
      DEFAULT_ADMIN_SETTINGS.sessionDurationHours
    ),
    maxSessionsPerUser: clamp(
      Number(cleaned.maxSessionsPerUser),
      1,
      100,
      DEFAULT_ADMIN_SETTINGS.maxSessionsPerUser
    ),
    registrationEnabled: !!cleaned.registrationEnabled,
    maxFileLifetimeDays: clamp(
      Number(cleaned.maxFileLifetimeDays),
      0,
      3650,
      DEFAULT_ADMIN_SETTINGS.maxFileLifetimeDays
    ),
    storageWarningThreshold: clamp(
      Number(cleaned.storageWarningThreshold),
      50,
      100,
      DEFAULT_ADMIN_SETTINGS.storageWarningThreshold
    ),
    autoDeleteTrashDays: clamp(
      Number(cleaned.autoDeleteTrashDays),
      0,
      365,
      DEFAULT_ADMIN_SETTINGS.autoDeleteTrashDays
    ),
    rateLimitPerMinute: clamp(
      Number(cleaned.rateLimitPerMinute),
      10,
      1000,
      DEFAULT_ADMIN_SETTINGS.rateLimitPerMinute
    ),
    logRetentionDays: clamp(
      Number(cleaned.logRetentionDays),
      7,
      730,
      DEFAULT_ADMIN_SETTINGS.logRetentionDays
    ),
    stepCodeRequired: !!cleaned.stepCodeRequired,
    emailDailyLimitPerSender: clamp(
      Number(cleaned.emailDailyLimitPerSender),
      1,
      2000,
      DEFAULT_ADMIN_SETTINGS.emailDailyLimitPerSender
    ),
    emailFailureThreshold: clamp(
      Number(cleaned.emailFailureThreshold),
      1,
      20,
      DEFAULT_ADMIN_SETTINGS.emailFailureThreshold
    ),
    emailCooldownMinutes: clamp(
      Number(cleaned.emailCooldownMinutes),
      1,
      1440,
      DEFAULT_ADMIN_SETTINGS.emailCooldownMinutes
    ),
  };
}

function clamp(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function setCache(value: AdminSettings) {
  memoryCache = { value, fetchedAt: Date.now() };
  syncSnapshot = value;
}

export function invalidateAdminSettingsCache() {
  memoryCache = null;
}

/** Sync accessor — uses last warm cache / defaults. Prefer getAdminSettings() when possible. */
export function getAdminSettingsSync(): AdminSettings {
  return syncSnapshot;
}

export function defaultQuotaBytes(settings?: AdminSettings): number {
  const s = settings ?? getAdminSettingsSync();
  return Math.round(s.defaultQuotaGB * 1073741824);
}

export function maxUploadBytes(settings?: AdminSettings): number {
  const s = settings ?? getAdminSettingsSync();
  const fromSettings = Math.round(s.maxUploadSizeMB * 1024 * 1024);
  const fromEnv = parseInt(process.env.MAX_FILE_SIZE_BYTES ?? "0", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.min(fromSettings, fromEnv);
  }
  return fromSettings;
}

/** MIME + extension policy from settings. */
export function isUploadAllowed(
  mimeType: string,
  filename: string,
  settings?: AdminSettings
): { allowed: boolean; reason?: string } {
  const s = settings ?? getAdminSettingsSync();
  const lowerName = filename.toLowerCase();
  const ext = lowerName.includes(".") ? `.${lowerName.split(".").pop()}` : "";

  if (ext && s.blockedExtensions.some((b) => b.toLowerCase() === ext)) {
    return { allowed: false, reason: `File extension ${ext} is blocked` };
  }

  const allowed = s.allowedMimeTypes;
  if (!allowed.length || allowed.includes("*/*")) {
    return { allowed: true };
  }

  const mime = (mimeType || "application/octet-stream").toLowerCase();
  const ok = allowed.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p === mime) return true;
    if (p.endsWith("/*")) {
      const prefix = p.slice(0, -1); // e.g. "image/"
      return mime.startsWith(prefix);
    }
    return false;
  });

  if (!ok) {
    return { allowed: false, reason: `MIME type ${mime} is not allowed` };
  }
  return { allowed: true };
}

async function ensureRow(): Promise<AdminSettings> {
  const [row] = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.id, SETTINGS_ID))
    .limit(1);

  if (row) {
    const normalized = normalizeSettings(row.data as Partial<AdminSettings>);
    // If DB had legacy junk fields, rewrite cleaned version once
    return normalized;
  }

  const defaults = normalizeSettings(DEFAULT_ADMIN_SETTINGS);
  await db.insert(systemSettings).values({
    id: SETTINGS_ID,
    data: defaults,
    updatedAt: new Date(),
  });
  return defaults;
}

export async function getAdminSettings(force = false): Promise<AdminSettings> {
  if (
    !force &&
    memoryCache &&
    Date.now() - memoryCache.fetchedAt < CACHE_TTL_MS
  ) {
    return memoryCache.value;
  }

  try {
    const value = await ensureRow();
    setCache(value);
    return value;
  } catch (error) {
    console.error("[admin-settings] load failed, using snapshot/defaults", error);
    return syncSnapshot;
  }
}

export async function updateAdminSettings(
  patch: Partial<AdminSettings>
): Promise<AdminSettings> {
  const current = await getAdminSettings(true);
  const next = normalizeSettings({ ...current, ...patch });

  await db
    .insert(systemSettings)
    .values({
      id: SETTINGS_ID,
      data: next,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: systemSettings.id,
      set: {
        data: next,
        updatedAt: new Date(),
      },
    });

  setCache(next);
  return next;
}

/** Warm cache at startup (best-effort). */
export function warmAdminSettings(): void {
  getAdminSettings(true).catch(() => {});
}
