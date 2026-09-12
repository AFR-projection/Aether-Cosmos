export type ProviderFailureKind =
  | "timeout"
  | "network"
  | "http"
  | "response"
  | "configuration"
  | "unknown";

export type ProviderFailure = {
  transient: boolean;
  kind: ProviderFailureKind;
  status?: number;
  retryAfterMs?: number;
};

type ProviderErrorLike = {
  name?: unknown;
  code?: unknown;
  status?: unknown;
  retryAfterMs?: unknown;
  failureKind?: unknown;
  transient?: unknown;
  message?: unknown;
};

const TRANSIENT_STATUSES = new Set([408, 409, 425, 429]);
const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** Parse Retry-After delay-seconds or an HTTP-date into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now: number | Date = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1_000)) : undefined;
  }

  const at = Date.parse(trimmed);
  if (!Number.isFinite(at) || !/[A-Za-z]{3}/.test(trimmed)) return undefined;
  const nowMs = now instanceof Date ? now.getTime() : now;
  return Math.max(0, Math.round(at - nowMs));
}

export function retryAfterFromResponse(response: Response, now?: number | Date): number | undefined {
  return parseRetryAfter(response.headers.get("retry-after"), now);
}

/** Classify failures without importing either concrete provider adapter. */
export function classifyProviderFailure(error: unknown): ProviderFailure {
  const candidate = error && typeof error === "object" ? (error as ProviderErrorLike) : {};
  const status = typeof candidate.status === "number" && Number.isFinite(candidate.status)
    ? candidate.status
    : undefined;
  const retryAfterMs = typeof candidate.retryAfterMs === "number" && candidate.retryAfterMs >= 0
    ? candidate.retryAfterMs
    : undefined;
  const explicitKind = typeof candidate.failureKind === "string"
    ? candidate.failureKind as ProviderFailureKind
    : undefined;

  if (typeof candidate.transient === "boolean") {
    return { transient: candidate.transient, kind: explicitKind ?? "unknown", status, retryAfterMs };
  }
  if (status !== undefined) {
    return {
      transient: TRANSIENT_STATUSES.has(status) || (status >= 500 && status <= 599),
      kind: "http",
      status,
      retryAfterMs,
    };
  }
  if (candidate.name === "AbortError" || explicitKind === "timeout") {
    return { transient: true, kind: "timeout", retryAfterMs };
  }
  if (explicitKind === "network") {
    return { transient: true, kind: "network", retryAfterMs };
  }

  const code = typeof candidate.code === "string" ? candidate.code.toUpperCase() : "";
  const message = typeof candidate.message === "string" ? candidate.message : String(error ?? "");
  if (NETWORK_CODES.has(code) || /fetch failed|network|socket hang up|connection reset|timed? ?out/i.test(message)) {
    return { transient: true, kind: "network", retryAfterMs };
  }
  return { transient: false, kind: explicitKind ?? "unknown", retryAfterMs };
}

export type BackoffOptions = {
  attempt: number;
  baseMs?: number;
  capMs?: number;
  retryAfterMs?: number;
  random?: () => number;
};

/** Full-jitter exponential backoff; Retry-After is always honoured as a floor. */
export function fullJitterBackoffMs(options: BackoffOptions): number {
  const attempt = Math.max(1, Math.floor(options.attempt));
  const baseMs = Math.max(0, options.baseMs ?? 1_000);
  const capMs = Math.max(baseMs, options.capMs ?? 15 * 60_000);
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.min(30, attempt - 1));
  const random = Math.min(1, Math.max(0, (options.random ?? Math.random)()));
  const jitter = Math.floor(random * ceiling);
  return Math.max(jitter, Math.max(0, options.retryAfterMs ?? 0));
}

export function retryAvailableAt(options: BackoffOptions, now: number | Date = Date.now()): Date {
  const nowMs = now instanceof Date ? now.getTime() : now;
  return new Date(nowMs + fullJitterBackoffMs(options));
}
