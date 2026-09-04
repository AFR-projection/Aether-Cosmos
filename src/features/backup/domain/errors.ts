/**
 * The base HTTP error for backup and restore, and the two subclasses still thrown here.
 *
 * `BackupError` is registered in `handleApiError` (`src/shared/api/response.ts`), which
 * is the whole reason this class sits outside the account feature: every error the
 * feature raises — `account/domain/errors.ts` extends this one — becomes the status and
 * code it declares rather than a 500 with a stack in the logs.
 *
 * The per-account feature's own hierarchy carries the user-facing wording, including the
 * one generic message a wrong recovery phrase and a damaged file must share. Nothing in
 * that hierarchy is repeated here.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §12.
 */
export class BackupError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "BackupError";
    this.status = status;
    this.code = code;
  }
}

/** Raised by `app/api/backup/_guard.ts`: authenticated, but not on their own behalf. */
export class BackupForbiddenError extends BackupError {
  constructor(message = "Forbidden") {
    super(message, 403, "BACKUP_FORBIDDEN");
  }
}

export class BackupValidationError extends BackupError {
  constructor(message: string) {
    super(message, 400, "BACKUP_VALIDATION");
  }
}
