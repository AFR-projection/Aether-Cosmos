/**
 * Lightweight email activity logger. Two sinks:
 *   1. console — structured `[MAIL] ...` lines, visible in `docker logs app` /
 *      the VPS journal, so problems are diagnosable without a UI.
 *   2. an in-memory ring buffer — the last N events, surfaced to admins at
 *      /api/admin/email/logs so they can see recent activity from the panel
 *      without SSH access.
 *
 * The buffer is per-process and NOT persisted: it resets on restart and is not
 * shared across multiple app instances. It is a live diagnostic tail, not an
 * audit log. Secrets (App Passwords, OTP codes) are NEVER recorded here —
 * recipient addresses are stored as-is for support, which is acceptable since
 * this endpoint is master-only.
 */

export type EmailLogLevel = "info" | "warn" | "error";

export type EmailEventType =
  | "verify" // admin tested a sender's SMTP credentials
  | "send" // a single message send attempt via a sender
  | "deliver" // a logical delivery (OTP/notification), possibly across failover
  | "otp"; // OTP issue/verify lifecycle

export type EmailLogEntry = {
  ts: number;
  level: EmailLogLevel;
  type: EmailEventType;
  message: string;
  /** Non-sensitive context: sender email, recipient, senderId, durationMs, etc. */
  meta?: Record<string, unknown>;
};

const MAX_ENTRIES = 200;
const buffer: EmailLogEntry[] = [];

export function recordEmailLog(
  level: EmailLogLevel,
  type: EmailEventType,
  message: string,
  meta?: Record<string, unknown>
): void {
  const entry: EmailLogEntry = { ts: Date.now(), level, type, message, meta };

  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);

  const line = `[MAIL] ${type} ${message}`;
  const detail = meta && Object.keys(meta).length ? meta : undefined;
  if (level === "error") console.error(line, detail ?? "");
  else if (level === "warn") console.warn(line, detail ?? "");
  else console.log(line, detail ?? "");
}

/** Most-recent-first snapshot of the ring buffer (optionally capped). */
export function getRecentEmailLogs(limit = MAX_ENTRIES): EmailLogEntry[] {
  const slice = limit > 0 ? buffer.slice(-limit) : buffer.slice();
  return slice.reverse();
}
