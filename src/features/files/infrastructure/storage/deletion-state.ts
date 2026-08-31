export type DeletionLifecycleStatus = "created" | "processing" | "completed" | "failed" | "expired";

const transitions: Record<DeletionLifecycleStatus, readonly DeletionLifecycleStatus[]> = {
  created: ["processing", "failed", "expired"],
  processing: ["completed", "failed", "expired"],
  completed: ["expired"],
  failed: ["processing", "expired"],
  expired: [],
};

export function canDeletionTransition(from: DeletionLifecycleStatus, to: DeletionLifecycleStatus): boolean {
  return transitions[from].includes(to);
}

export function assertDeletionTransition(from: DeletionLifecycleStatus, to: DeletionLifecycleStatus): void {
  if (!canDeletionTransition(from, to)) throw new Error(`Invalid deletion transition: ${from} -> ${to}`);
}
