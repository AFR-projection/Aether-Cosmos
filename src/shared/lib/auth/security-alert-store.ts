/**
 * One-shot handoff for the security banner: the API client writes the alert when
 * a request comes back with a session-invalidated code, and the login screen
 * reads it once on the next render.
 *
 * It lives in shared/ rather than next to the banner because the writer is the
 * shared API client: a platform module must not import a feature component.
 */

export type SecurityAlertPayload = {
  code: "SESSION_IP_CHANGED" | "SESSION_INACTIVE" | "SESSION_REVOKED";
  /**
   * The server's English sentence for the same `code`. Kept on the payload for
   * logging, but not rendered: the banner text comes from `code`, so the reader
   * gets their own language instead of whichever language the API replied in.
   */
  message?: string;
  previousIp?: string;
  currentIp?: string;
};

const STORAGE_KEY = "security_alert";

export function storeSecurityAlert(payload: SecurityAlertPayload) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

export function consumeSecurityAlert(): SecurityAlertPayload | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(STORAGE_KEY);
    return JSON.parse(raw) as SecurityAlertPayload;
  } catch {
    return null;
  }
}
