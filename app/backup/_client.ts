import type { BackupDomain } from "@backup/domain/types";
import type { RestoreMode } from "@backup/account/application/import-types";
import type {
  IdentityResponse,
  PrepareResponse,
  InspectResponse,
  RestoreResponse,
} from "./_types";

/**
 * Network calls for the `/backup` page. No `useT(` in this file, so it is exempt from the
 * literal i18n scan. The page owns the orchestration and the string presentation; this module
 * owns the wire protocol — including the two parts of it the page cannot work without:
 *
 *   * **The envelope.** Every route answers `apiSuccess`/`apiError`, i.e.
 *     `{success: true, data}` or `{success: false, error, code?, …}`. Returning `res.json()`
 *     raw would hand the page an object whose every field is `undefined`.
 *   * **The `code`.** `AFRBAK_UNREADABLE` is how the server says "this needs the recovery
 *     phrase", and `AFRBAK_STEP_CODE_*` carries `remaining`. A thrown `Error` with only a
 *     message loses both, and the page has no other way to tell "ask for the phrase" from
 *     "this is the wrong file".
 */

/** A refusal with its machine code intact. */
export class BackupApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** 2-Step Code attempts left, when the denial counted them. */
  readonly remaining: number | null;

  constructor(
    message: string,
    status: number,
    code: string | null,
    remaining: number | null
  ) {
    super(message);
    this.name = "BackupApiError";
    this.status = status;
    this.code = code;
    this.remaining = remaining;
  }
}

interface FailureBody {
  error?: unknown;
  code?: unknown;
  remaining?: unknown;
}

function toFailure(status: number, body: FailureBody | null, fallback: string): BackupApiError {
  const message = typeof body?.error === "string" && body.error ? body.error : fallback;
  const code = typeof body?.code === "string" ? body.code : null;
  const remaining = typeof body?.remaining === "number" ? body.remaining : null;
  return new BackupApiError(message, status, code, remaining);
}

/** `{success: true, data}` in, `data` out. Anything else throws. */
async function unwrap<T>(res: Response, fallback: string): Promise<T> {
  const body: unknown = await res.json().catch(() => null);
  const envelope = body as { success?: unknown; data?: unknown } | null;

  if (!res.ok || envelope?.success !== true) {
    throw toFailure(res.status, body as FailureBody | null, fallback);
  }
  if (envelope.data === undefined || envelope.data === null) {
    throw new BackupApiError(fallback, res.status, null, null);
  }
  return envelope.data as T;
}

/**
 * Everything the page needs to draw itself, in one request.
 *
 * It goes through `unwrap` like the four calls below rather than through `apiFetch`, for one
 * reason that matters more than the convenience it gives up: a server with no `BACKUP_MASTER_KEY`
 * answers this route `503 AFRBAK_NOT_CONFIGURED`, and the page can only say so if the code
 * survives the trip. A thrown `Error` carrying a message would leave it spinning forever.
 */
export async function fetchIdentity(): Promise<IdentityResponse> {
  const res = await fetch("/api/backup/identity", { headers: { Accept: "application/json" } });
  return unwrap<IdentityResponse>(res, "Failed to load backup identity");
}

/**
 * Mint the ticket and this archive's recovery phrase.
 *
 * `phrase` is in every successful response — nine fresh words per download, derived from the
 * ticket rather than stored — and this response is the only place they are ever readable. The
 * caller must show them before it navigates to `url`, because nothing can produce them again.
 */
export async function prepareTakeout(
  domain: BackupDomain,
  csrfToken: string
): Promise<PrepareResponse> {
  const res = await fetch("/api/backup/takeout/prepare", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({ domain }),
  });

  return unwrap<PrepareResponse>(res, "Failed to prepare backup");
}

/**
 * Describe the archive from a prefix of it. `previewBytes` comes from the identity endpoint
 * because the constant lives beside `node:crypto` and must not reach the browser bundle.
 */
export async function inspectArchive(
  file: File,
  domain: BackupDomain,
  mode: RestoreMode,
  previewBytes: number,
  phrase: string | null,
  csrfToken: string
): Promise<InspectResponse> {
  const res = await fetch("/api/backup/restore/inspect", {
    method: "POST",
    headers: {
      "x-csrf-token": csrfToken,
      "X-Afr-Domain": domain,
      "X-Afr-Mode": mode,
      ...(phrase === null ? {} : { "X-Afr-Phrase": phrase }),
    },
    body: file.slice(0, previewBytes),
  });

  return unwrap<InspectResponse>(res, "Failed to inspect archive");
}

/**
 * The upload, as `XMLHttpRequest` rather than `fetch`.
 *
 * A 40 GB archive needs a progress bar, and `fetch` still has no upload-progress event in any
 * shipping browser. The body is the `File` itself, so the browser streams it from disk and the
 * page never holds it in memory.
 */
export function restoreArchive(
  file: File,
  domain: BackupDomain,
  mode: RestoreMode,
  phrase: string | null,
  stepCode: string | null,
  csrfToken: string,
  onProgress: (percent: number) => void
): Promise<RestoreResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });

    // The bytes are all on the wire; everything after this is the server's five stages, which
    // report no progress and can take minutes. The page swaps the bar for a spinner here.
    xhr.upload.addEventListener("load", () => onProgress(100));

    xhr.addEventListener("load", () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText) as unknown;
      } catch {
        body = null;
      }
      const envelope = body as { success?: unknown; data?: unknown } | null;

      if (xhr.status >= 200 && xhr.status < 300 && envelope?.success === true && envelope.data) {
        resolve(envelope.data as RestoreResponse);
        return;
      }
      reject(toFailure(xhr.status, body as FailureBody | null, "Restore failed"));
    });

    xhr.addEventListener("error", () => {
      reject(new BackupApiError("Network error", 0, null, null));
    });

    xhr.addEventListener("abort", () => {
      reject(new BackupApiError("Upload cancelled", 0, null, null));
    });

    xhr.open("POST", "/api/backup/restore");
    xhr.setRequestHeader("x-csrf-token", csrfToken);
    xhr.setRequestHeader("X-Afr-Domain", domain);
    xhr.setRequestHeader("X-Afr-Mode", mode);
    if (phrase !== null) {
      xhr.setRequestHeader("X-Afr-Phrase", phrase);
    }
    if (stepCode !== null) {
      xhr.setRequestHeader("X-Afr-Step-Code", stepCode);
    }

    xhr.send(file);
  });
}
