/**
 * Typed HTTP errors for the Second Brain services.
 *
 * `handleApiError` maps these to their status directly — without it a thrown
 * "brain not found" surfaces as a generic 500 instead of a 404, which is what
 * the first cut of this feature did.
 */
export class BrainError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "BrainError";
    this.status = status;
    this.code = code;
  }
}

export class BrainNotFoundError extends BrainError {
  constructor() {
    super("Brain not found", 404, "BRAIN_NOT_FOUND");
  }
}

export class MemoryNotFoundError extends BrainError {
  constructor() {
    super("Memory not found", 404, "MEMORY_NOT_FOUND");
  }
}

export class MemoryVersionNotFoundError extends BrainError {
  constructor() {
    super("Memory version not found", 404, "MEMORY_VERSION_NOT_FOUND");
  }
}

export class BrainProjectNotFoundError extends BrainError {
  constructor() {
    super("Project not found", 404, "BRAIN_PROJECT_NOT_FOUND");
  }
}

export class BrainEntityNotFoundError extends BrainError {
  constructor() {
    super("Entity not found", 404, "BRAIN_ENTITY_NOT_FOUND");
  }
}

export class BrainAgentNotFoundError extends BrainError {
  constructor() {
    super("Agent not found", 404, "BRAIN_AGENT_NOT_FOUND");
  }
}

/** The caller authenticated fine but its brain scopes/access do not cover this call. */
export class BrainForbiddenError extends BrainError {
  constructor(message = "Forbidden") {
    super(message, 403, "BRAIN_FORBIDDEN");
  }
}

export class BrainConflictError extends BrainError {
  constructor(message: string) {
    super(message, 409, "BRAIN_CONFLICT");
  }
}

export class BrainValidationError extends BrainError {
  constructor(message: string) {
    super(message, 400, "BRAIN_VALIDATION");
  }
}
