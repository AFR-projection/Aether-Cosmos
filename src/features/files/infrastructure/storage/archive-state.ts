export type ArchiveLifecycleStatus = "created" | "processing" | "ready" | "failed" | "expired";

const transitions: Record<ArchiveLifecycleStatus, readonly ArchiveLifecycleStatus[]> = {
  created: ["processing", "failed", "expired"],
  processing: ["ready", "failed", "expired"],
  ready: ["expired"],
  failed: ["processing", "expired"],
  expired: [],
};

export function canArchiveTransition(
  from: ArchiveLifecycleStatus,
  to: ArchiveLifecycleStatus
): boolean {
  return transitions[from].includes(to);
}

export function assertArchiveTransition(
  from: ArchiveLifecycleStatus,
  to: ArchiveLifecycleStatus
): void {
  if (!canArchiveTransition(from, to)) {
    throw new Error(`Invalid archive transition: ${from} -> ${to}`);
  }
}

export function isArchiveAvailable(status: ArchiveLifecycleStatus): boolean {
  return status === "ready";
}
