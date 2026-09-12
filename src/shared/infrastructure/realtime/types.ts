export type RealtimeEvent =
  | { type: "upload_complete"; fileId: string; name: string; sizeBytes?: number }
  /**
   * A batch of uploads landed, from `/api/uploads/batch-complete`.
   *
   * One frame instead of one per file: a folder upload finishing 5,000 files used
   * to push 5,000 `upload_complete` frames into the uploader's own tab, which the
   * browser parsed and dispatched while the upload was still running. `fileIds`
   * carries the whole set so a listening tab can still suppress its own uploads
   * and reconcile its transfer rows.
   */
  | {
      type: "upload_batch_complete";
      count: number;
      fileIds: string[];
      name: string;
      sizeBytes?: number;
    }
  /**
   * A subtitle track finished, or did not.
   *
   * `language` is a BCP-47 tag rather than a label: the toast names the language in the reader's
   * own interface language, which the worker cannot know.
   */
  | { type: "subtitle_ready"; fileId: string; trackId: string; language: string }
  | { type: "subtitle_failed"; fileId: string; trackId: string; language: string }
  | {
      type: "share_access";
      shareId: string;
      fileName: string;
      accessCount: number;
      token?: string;
    }
  | {
      type: "session_revoked";
      sessionId?: string;
      reason?: string;
      wasCurrent?: boolean;
    }
  | { type: "heartbeat"; at: number }
  | { type: "brain_memory_created"; brainId: string; memoryId: string; title: string }
  | { type: "brain_memory_updated"; brainId: string; memoryId: string }
  | { type: "brain_memory_deleted"; brainId: string; memoryId: string }
  | {
      type: "brain_memory_linked";
      brainId: string;
      memoryId: string;
      linkId: string;
      targetType: "memory" | "entity";
    }
  | { type: "brain_entity_created"; brainId: string; entityId: string; name: string }
  | {
      type: "brain_relationship_created";
      brainId: string;
      relationshipId: string;
      relationshipType: string;
    }
  | {
      type: "brain_conflict_detected";
      brainId: string;
      memoryId: string;
      conflictsWith: string;
      reason: string;
    };

export type RealtimeEventHandler = (event: RealtimeEvent) => void;

/**
 * Broadcast events for the admin panel (channel `realtime:admin`). These are
 * intentionally minimal "something changed, refetch" signals — the admin list
 * API stays the single source of truth, so the client just invalidates its
 * query when one arrives (no per-event state patching → no drift).
 */
export type AdminRealtimeEvent =
  | { type: "user_registered"; userId: string; at: number }
  | { type: "user_verified"; userId: string; at: number }
  | { type: "user_updated"; userId: string; at: number }
  | { type: "user_deleted"; userId: string; at: number }
  | { type: "user_presence"; userId: string; online: boolean; at: number }
  | { type: "activity_log_created"; userId: string; action: string; at: number }
  | { type: "heartbeat"; at: number };

export type AdminRealtimeEventHandler = (event: AdminRealtimeEvent) => void;
