import { eq } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { systemSettings } from "@/shared/infrastructure/db/schema";

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
  // ── Sessions ──
  /**
   * Idle cut-off in minutes, or 0 to disable it. Opt-in on purpose: whichever of
   * this and `sessionDurationHours` is shorter is the one that ends the session,
   * so a non-zero value here silently overrides the absolute duration.
   */
  sessionIdleTimeoutMinutes: number;
  /**
   * Revoke a session when its client IP changes. "auto" keeps the historic
   * behaviour — on in production, off in development, where a changing IP is
   * usually just a restarted tunnel.
   */
  sessionIpBinding: "auto" | "on" | "off";
  // ── Login lockout ──
  /** Failed password attempts before the account itself is locked. */
  loginMaxAttempts: number;
  /** Failed attempts allowed from a single IP across all accounts in one window. */
  loginIpMaxAttempts: number;
  /** How long a lockout lasts, and the width of the per-IP window, in minutes. */
  loginLockoutMinutes: number;
  // ── Presigned storage URLs ──
  /** Lifetime of an upload URL. Long enough to finish a slow multipart part. */
  uploadUrlExpiryMinutes: number;
  /** Lifetime of a download URL. Short: it is handed straight to the browser. */
  downloadUrlExpirySeconds: number;
  // ── New accounts ──
  /** Egress allowance given to a new account, in GB. 0 = unmetered. */
  defaultBandwidthQuotaGB: number;
  /** When non-empty, self-registration only accepts these email domains. */
  allowedEmailDomains: string[];
  // ── Public share links ──
  /** Master switch for creating new public links. Existing links keep working. */
  publicSharingEnabled: boolean;
  /** Expiry used when the sharer picks none, in days. 0 = never expires. */
  shareDefaultExpiryDays: number;
  /** Longest expiry a sharer may pick, in days. 0 = no ceiling. */
  shareMaxExpiryDays: number;
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
  // Every default below reproduces the behaviour these knobs used to have as
  // hardcoded constants or env vars, so an existing deployment sees no change
  // until someone actually moves a slider.
  sessionIdleTimeoutMinutes: 0,
  sessionIpBinding: "auto",
  loginMaxAttempts: 5,
  loginIpMaxAttempts: 30,
  loginLockoutMinutes: 15,
  uploadUrlExpiryMinutes: 15,
  downloadUrlExpirySeconds: 60,
  defaultBandwidthQuotaGB: 0,
  allowedEmailDomains: [],
  publicSharingEnabled: true,
  shareDefaultExpiryDays: 0,
  shareMaxExpiryDays: 0,
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
      0.5,
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
    // 0 disables the idle cut-off; anything else is a real minute count. The
    // ceiling is a week, which is already the longest sensible session.
    sessionIdleTimeoutMinutes: clamp(
      Number(cleaned.sessionIdleTimeoutMinutes),
      0,
      10080,
      DEFAULT_ADMIN_SETTINGS.sessionIdleTimeoutMinutes
    ),
    sessionIpBinding:
      cleaned.sessionIpBinding === "on" || cleaned.sessionIpBinding === "off"
        ? cleaned.sessionIpBinding
        : "auto",
    // The floor of 3 matters: a value of 1 locks an account on the first typo,
    // which turns the lockout into a denial-of-service anyone can trigger with
    // just a username.
    loginMaxAttempts: clamp(
      Number(cleaned.loginMaxAttempts),
      3,
      50,
      DEFAULT_ADMIN_SETTINGS.loginMaxAttempts
    ),
    loginIpMaxAttempts: clamp(
      Number(cleaned.loginIpMaxAttempts),
      5,
      500,
      DEFAULT_ADMIN_SETTINGS.loginIpMaxAttempts
    ),
    loginLockoutMinutes: clamp(
      Number(cleaned.loginLockoutMinutes),
      1,
      1440,
      DEFAULT_ADMIN_SETTINGS.loginLockoutMinutes
    ),
    // A signed URL is a bearer token for one object: the ceiling is deliberately
    // hours, not days, so a leaked link cannot be useful for long.
    uploadUrlExpiryMinutes: clamp(
      Number(cleaned.uploadUrlExpiryMinutes),
      1,
      720,
      DEFAULT_ADMIN_SETTINGS.uploadUrlExpiryMinutes
    ),
    downloadUrlExpirySeconds: clamp(
      Number(cleaned.downloadUrlExpirySeconds),
      15,
      3600,
      DEFAULT_ADMIN_SETTINGS.downloadUrlExpirySeconds
    ),
    defaultBandwidthQuotaGB: clamp(
      Number(cleaned.defaultBandwidthQuotaGB),
      0,
      1_000_000,
      DEFAULT_ADMIN_SETTINGS.defaultBandwidthQuotaGB
    ),
    allowedEmailDomains: Array.isArray(cleaned.allowedEmailDomains)
      ? cleaned.allowedEmailDomains
          // Accept "@example.com", "Example.com" or " example.com " — all three are
          // what someone actually types — and store one canonical form.
          .map((d) => String(d).trim().toLowerCase().replace(/^@+/, ""))
          .filter((d) => d.length > 0 && d.includes("."))
      : [...DEFAULT_ADMIN_SETTINGS.allowedEmailDomains],
    publicSharingEnabled: cleaned.publicSharingEnabled !== false,
    shareDefaultExpiryDays: clamp(
      Number(cleaned.shareDefaultExpiryDays),
      0,
      3650,
      DEFAULT_ADMIN_SETTINGS.shareDefaultExpiryDays
    ),
    shareMaxExpiryDays: clamp(
      Number(cleaned.shareMaxExpiryDays),
      0,
      3650,
      DEFAULT_ADMIN_SETTINGS.shareMaxExpiryDays
    ),
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

/** Egress allowance for a new account. 0 stays 0, which the biller reads as unmetered. */
export function defaultBandwidthQuotaBytes(settings?: AdminSettings): number {
  const s = settings ?? getAdminSettingsSync();
  return Math.round(s.defaultBandwidthQuotaGB * 1073741824);
}

/**
 * The upload ceiling, from settings alone.
 *
 * There used to be a `MAX_FILE_SIZE_BYTES` env var MIN-ed with this, which meant
 * the number an admin typed into the panel was not necessarily the number that
 * applied — and since its shipped value (5 GiB) was exactly the panel's own
 * ceiling, it never actually lowered anything. One authority is easier to reason
 * about than two, and the clamp in `normalizeSettings` is where the hard limit lives.
 */
export function maxUploadBytes(settings?: AdminSettings): number {
  const s = settings ?? getAdminSettingsSync();
  return Math.round(s.maxUploadSizeMB * 1024 * 1024);
}

/** Idle cut-off in ms, or null when it is switched off. */
export function sessionIdleTimeoutMs(settings?: AdminSettings): number | null {
  const s = settings ?? getAdminSettingsSync();
  return s.sessionIdleTimeoutMinutes > 0 ? s.sessionIdleTimeoutMinutes * 60_000 : null;
}

/** Whether to revoke a session whose client IP changed. */
export function sessionIpBindingEnabled(settings?: AdminSettings): boolean {
  const s = settings ?? getAdminSettingsSync();
  if (s.sessionIpBinding === "on") return true;
  if (s.sessionIpBinding === "off") return false;
  return process.env.NODE_ENV === "production";
}

export type LoginLockoutPolicy = {
  /** Failed passwords before this account locks. */
  accountMax: number;
  /** Failed attempts before this IP is throttled. */
  ipMax: number;
  /** Lockout length and per-IP window width. */
  windowMs: number;
  /** The same window in whole minutes, for user-facing copy. */
  windowMinutes: number;
};

export function loginLockoutPolicy(settings?: AdminSettings): LoginLockoutPolicy {
  const s = settings ?? getAdminSettingsSync();
  return {
    accountMax: s.loginMaxAttempts,
    ipMax: s.loginIpMaxAttempts,
    windowMs: s.loginLockoutMinutes * 60_000,
    windowMinutes: s.loginLockoutMinutes,
  };
}

export function uploadUrlExpirySeconds(settings?: AdminSettings): number {
  const s = settings ?? getAdminSettingsSync();
  return s.uploadUrlExpiryMinutes * 60;
}

export function downloadUrlExpirySeconds(settings?: AdminSettings): number {
  const s = settings ?? getAdminSettingsSync();
  return s.downloadUrlExpirySeconds;
}

/**
 * Registration domain allowlist. An empty list allows everything, which is the
 * default — this only narrows, it never widens.
 */
export function isEmailDomainAllowed(email: string, settings?: AdminSettings): boolean {
  const s = settings ?? getAdminSettingsSync();
  if (s.allowedEmailDomains.length === 0) return true;
  const domain = email.trim().toLowerCase().split("@").pop() ?? "";
  if (!domain) return false;
  // Match the domain itself and its subdomains, so "example.com" also covers
  // "mail.example.com" — but never lets "notexample.com" through.
  return s.allowedEmailDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

export type ShareExpiryPolicy = {
  /** Expiry in days to apply when the sharer picked none. 0 = no expiry. */
  defaultDays: number;
  /** Ceiling in days on what a sharer may pick. 0 = no ceiling. */
  maxDays: number;
};

export function shareExpiryPolicy(settings?: AdminSettings): ShareExpiryPolicy {
  const s = settings ?? getAdminSettingsSync();
  const maxDays = s.shareMaxExpiryDays;
  // A default longer than the ceiling would hand out links the ceiling forbids,
  // so the ceiling wins. The two fields are clamped independently, which makes
  // that combination reachable from the panel.
  const defaultDays =
    maxDays > 0 && (s.shareDefaultExpiryDays === 0 || s.shareDefaultExpiryDays > maxDays)
      ? maxDays
      : s.shareDefaultExpiryDays;
  return { defaultDays, maxDays };
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
