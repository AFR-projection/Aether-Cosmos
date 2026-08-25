import {
  pgTable,
  text,
  timestamp,
  uuid,
  bigint,
  boolean,
  integer,
  jsonb,
  index,
  uniqueIndex,
  pgEnum,
  customType,
  real,
  primaryKey,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations, sql, type SQL } from "drizzle-orm";

/**
 * PostgreSQL `tsvector` column type for full-text search. Not represented in JS
 * (we never read it directly) — Postgres computes it from a generated expression
 * and we query it via the FTS helpers in lib/search/fts.ts.
 */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

/**
 * Default embedding width — the native output of the default model
 * (`openai/text-embedding-3-small`). It seeds a fresh config row and nothing more:
 * it is NOT a hard column constraint. OpenRouter models produce different widths
 * (voyage-code-4 → 1024, others → 256/512/2048…), and the actual width is auto-detected
 * at the settings "Test"/Save step and stored per-config, so any model works.
 */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * pgvector `vector` column type for semantic embeddings (Second Brain 2.0, P9).
 *
 * The column is DIMENSION-FLEXIBLE (no `(N)` typmod): whichever OpenRouter model the
 * operator configures, its native width is stored as-is. A fixed `vector(N)` would reject
 * every model that does not emit exactly N dimensions; flexibility is what lets all models
 * work. The tradeoff is no HNSW/ANN index (that needs a fixed width) — retrieval uses an
 * exact `<=>` scan, which is bounded per brain and fine at this scale. The driver serialises
 * `number[]` → the `'[a,b,c]'` text literal pgvector parses; most writes/reads go through raw
 * `::vector` SQL, but the typed column lets the query builder reference it (`isNotNull`, ANN
 * ordering) without stringly-typed column names.
 */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .slice(1, -1)
      .split(",")
      .filter((part) => part.length > 0)
      .map(Number);
  },
});

export const userRoleEnum = pgEnum("user_role", ["master", "user"]);
export const userStatusEnum = pgEnum("user_status", ["active", "suspended"]);
/** Lifecycle of a file's backing object. Only `ready` is user-visible/downloadable. */
export const fileUploadStatusEnum = pgEnum("file_upload_status", [
  "legacy_unverified",
  "created",
  "uploading",
  "verifying",
  "ready",
  "failed",
  "cancelled",
  "deleting",
  "delete_failed",
  "inconsistent",
]);
export const uploadSessionStatusEnum = pgEnum("upload_session_status", [
  "created",
  "uploading",
  "verifying",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);
export const uploadPartStatusEnum = pgEnum("upload_part_status", [
  "pending",
  "uploaded",
  "failed",
]);
export const uploadTypeEnum = pgEnum("upload_type", ["single", "multipart"]);
export const archiveJobStatusEnum = pgEnum("archive_job_status", [
  "created",
  "processing",
  "ready",
  "failed",
  "expired",
]);
export const archiveItemStatusEnum = pgEnum("archive_item_status", [
  "pending",
  "processing",
  "completed",
  "failed",
]);
export const deletionJobStatusEnum = pgEnum("deletion_job_status", [
  "created",
  "processing",
  "completed",
  "failed",
  "expired",
]);
export const deletionItemStatusEnum = pgEnum("deletion_item_status", [
  "pending",
  "processing",
  "completed",
  "failed",
]);
export type FileUploadStatus = (typeof fileUploadStatusEnum.enumValues)[number];
export type UploadSessionStatus = (typeof uploadSessionStatusEnum.enumValues)[number];
export type UploadPartStatus = (typeof uploadPartStatusEnum.enumValues)[number];
export type ArchiveJobStatus = (typeof archiveJobStatusEnum.enumValues)[number];
export type ArchiveItemStatus = (typeof archiveItemStatusEnum.enumValues)[number];
export type DeletionJobStatus = (typeof deletionJobStatusEnum.enumValues)[number];
export type DeletionItemStatus = (typeof deletionItemStatusEnum.enumValues)[number];
/** Verification state of a Gmail SMTP sender: "ok" once a live SMTP handshake succeeds. */
export const mailStatusEnum = pgEnum("mail_status", ["unverified", "ok", "error"]);
export const sharePermissionEnum = pgEnum("share_permission", ["view", "edit"]);
export const activityActionEnum = pgEnum("activity_action", [
  "login",
  "logout",
  "upload",
  "download",
  "delete",
  "restore",
  "share",
  "edit",
  "rename",
  "move",
  "copy",
  "create_folder",
  "delete_folder",
  "impersonate",
  "create_user",
  "update_user",
  "delete_user",
  "suspend_user",
  "favorite",
  "account_lock",
  "ip_rate_limit",
  "session_revoked",
  "password_change",
  "step_code_change",
  "step_code_lock",
  "step_code_reset",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    username: text("username").notNull(),
    phone: text("phone"),
    email: text("email"),
    passwordHash: text("password_hash").notNull(),
    role: userRoleEnum("role").notNull().default("user"),
    status: userStatusEnum("status").notNull().default("active"),
    quotaBytes: bigint("quota_bytes", { mode: "number" }).notNull().default(10737418240),
    usedBytes: bigint("used_bytes", { mode: "number" }).notNull().default(0),
    /** Bytes reserved by upload sessions that have not reached READY yet. */
    reservedBytes: bigint("reserved_bytes", { mode: "number" }).notNull().default(0),
    failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    suspendReason: text("suspend_reason"),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    totpSecret: text("totp_secret"),
    totpEnabled: boolean("totp_enabled").notNull().default(false),
    totpRecoveryCodes: jsonb("totp_recovery_codes").$type<string[]>().default([]),
    /** 2-Step Code (numpad layer between password and TOTP), argon2-hashed. */
    stepCodeHash: text("step_code_hash"),
    stepCodeUpdatedAt: timestamp("step_code_updated_at", { withTimezone: true }),
    /** Tracked separately from password attempts so one lockout cannot mask the other. */
    stepCodeFailedAttempts: integer("step_code_failed_attempts").notNull().default(0),
    stepCodeLockedUntil: timestamp("step_code_locked_until", { withTimezone: true }),
    /** Set by a master to force the user to choose a new code at next login. */
    stepCodeMustChange: boolean("step_code_must_change").notNull().default(false),
    bandwidthQuotaBytes: bigint("bandwidth_quota_bytes", { mode: "number" }).notNull().default(0),
    bandwidthUsedBytes: bigint("bandwidth_used_bytes", { mode: "number" }).notNull().default(0),
    bandwidthPeriodStart: timestamp("bandwidth_period_start", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("users_username_unique").on(table.username),
    uniqueIndex("users_phone_unique").on(table.phone),
    uniqueIndex("users_email_unique").on(table.email),
    index("users_role_idx").on(table.role),
  ]
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    deviceLabel: text("device_label"),
    /** Approx location from IP lookup, e.g. "Jakarta, Indonesia" */
    locationLabel: text("location_label"),
    locationCity: text("location_city"),
    locationCountry: text("location_country"),
    locationRegion: text("location_region"),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
    impersonatingUserId: uuid("impersonating_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
    index("sessions_last_active_idx").on(table.lastActiveAt),
    // FK child index: a user delete must not scan every session row.
    index("sessions_impersonating_idx").on(table.impersonatingUserId),
  ]
);

export const folders = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    materializedPath: text("materialized_path").notNull(),
    depth: integer("depth").notNull().default(0),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("folders_user_id_idx").on(table.userId),
    index("folders_parent_id_idx").on(table.parentId),
    index("folders_path_idx").on(table.userId, table.materializedPath),
    index("folders_user_active_idx").on(table.userId, table.deletedAt),
  ]
);

export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    r2Key: text("r2_key").notNull(),
    /** A file is available only after the R2 object has been verified and finalized. */
    status: fileUploadStatusEnum("status").notNull().default("created"),
    checksumSha256: text("checksum_sha256"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    isFavorite: boolean("is_favorite").notNull().default(false),
    isNote: boolean("is_note").notNull().default(false),
    thumbnailKey: text("thumbnail_key"),
    // Searchable body text: note plaintext today; extracted PDF/Office text later
    // (Phase B). Kept separate from name so the FTS vector can weight them.
    contentText: text("content_text"),
    // Generated full-text search vector: name (weight A) + contentText (weight B).
    // STORED so it is computed on write by Postgres — no trigger, never stale.
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      (): SQL =>
        sql`setweight(to_tsvector('simple', coalesce(${files.name}, '')), 'A') || setweight(to_tsvector('simple', coalesce(${files.contentText}, '')), 'B')`
    ),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    encrypted: boolean("encrypted").notNull().default(false),
    encryptionMeta: jsonb("encryption_meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("files_user_id_idx").on(table.userId),
    index("files_folder_id_idx").on(table.folderId),
    index("files_user_active_idx").on(table.userId, table.deletedAt),
    index("files_status_idx").on(table.status),
    index("files_user_status_idx").on(table.userId, table.status),
    index("files_r2_key_idx").on(table.r2Key),
    index("files_favorite_idx").on(table.userId, table.isFavorite),
    // GIN index makes tsvector @@ tsquery lookups fast.
    index("files_search_vector_idx").using("gin", table.searchVector),
  ]
);

export const uploadSessions = pgTable(
  "upload_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Client-generated stable key used to make init safe to retry. */
    idempotencyKey: text("idempotency_key").notNull(),
    uploadType: uploadTypeEnum("upload_type").notNull(),
    r2UploadId: text("r2_upload_id"),
    objectKey: text("object_key").notNull(),
    totalSizeBytes: bigint("total_size_bytes", { mode: "number" }).notNull(),
    partSizeBytes: bigint("part_size_bytes", { mode: "number" }),
    expectedChecksumSha256: text("expected_checksum_sha256"),
    status: uploadSessionStatusEnum("status").notNull().default("created"),
    retryCount: integer("retry_count").notNull().default(0),
    reservationReleased: boolean("reservation_released").notNull().default(false),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("upload_sessions_user_idempotency_unique").on(
      table.userId,
      table.idempotencyKey
    ),
    index("upload_sessions_file_idx").on(table.fileId),
    index("upload_sessions_user_status_idx").on(table.userId, table.status),
    index("upload_sessions_expiry_idx").on(table.status, table.expiresAt),
    index("upload_sessions_r2_upload_idx").on(table.r2UploadId),
  ]
);

export const uploadParts = pgTable(
  "upload_parts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    uploadSessionId: uuid("upload_session_id")
      .notNull()
      .references(() => uploadSessions.id, { onDelete: "cascade" }),
    partNumber: integer("part_number").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    etag: text("etag"),
    checksumSha256: text("checksum_sha256"),
    status: uploadPartStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("upload_parts_session_part_unique").on(
      table.uploadSessionId,
      table.partNumber
    ),
    index("upload_parts_session_status_idx").on(table.uploadSessionId, table.status),
  ]
);

/** Asynchronous folder/archive download jobs. The item rows are an immutable
 * authorization snapshot, so a later rename/move cannot change the archive. */
export const archiveJobs = pgTable(
  "archive_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key").notNull(),
    objectKey: text("object_key").notNull(),
    archiveName: text("archive_name").notNull(),
    status: archiveJobStatusEnum("status").notNull().default("created"),
    totalFiles: integer("total_files").notNull().default(0),
    processedFiles: integer("processed_files").notNull().default(0),
    totalBytes: bigint("total_bytes", { mode: "number" }).notNull().default(0),
    processedBytes: bigint("processed_bytes", { mode: "number" }).notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("archive_jobs_user_idempotency_unique").on(table.userId, table.idempotencyKey),
    index("archive_jobs_user_status_idx").on(table.userId, table.status),
    index("archive_jobs_expiry_idx").on(table.status, table.expiresAt),
  ]
);

export const archiveJobItems = pgTable(
  "archive_job_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    archiveJobId: uuid("archive_job_id")
      .notNull()
      .references(() => archiveJobs.id, { onDelete: "cascade" }),
    fileId: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
    archivePath: text("archive_path").notNull(),
    objectKey: text("object_key").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    status: archiveItemStatusEnum("status").notNull().default("pending"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("archive_job_items_job_path_unique").on(table.archiveJobId, table.archivePath),
    index("archive_job_items_job_status_idx").on(table.archiveJobId, table.status),
    // FK child index: a file delete must not scan every archive item.
    index("archive_job_items_file_idx").on(table.fileId),
  ]
);

/** Durable batch deletion for large permanent folder deletes. */
export const deletionJobs = pgTable(
  "deletion_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key").notNull(),
    status: deletionJobStatusEnum("status").notNull().default("created"),
    totalItems: integer("total_items").notNull().default(0),
    processedItems: integer("processed_items").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("deletion_jobs_user_idempotency_unique").on(table.userId, table.idempotencyKey),
    index("deletion_jobs_user_status_idx").on(table.userId, table.status),
    index("deletion_jobs_expiry_idx").on(table.status, table.expiresAt),
  ]
);

export const deletionJobItems = pgTable(
  "deletion_job_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deletionJobId: uuid("deletion_job_id")
      .notNull()
      .references(() => deletionJobs.id, { onDelete: "cascade" }),
    fileId: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
    objectKey: text("object_key").notNull(),
    thumbnailKey: text("thumbnail_key"),
    status: deletionItemStatusEnum("status").notNull().default("pending"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("deletion_job_items_job_object_unique").on(table.deletionJobId, table.objectKey),
    index("deletion_job_items_job_status_idx").on(table.deletionJobId, table.status),
    // FK child index: a file delete must not scan every deletion item.
    index("deletion_job_items_file_idx").on(table.fileId),
  ]
);

export const fileContents = pgTable(
  "file_contents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    contentJson: jsonb("content_json"),
    annotationsJson: jsonb("annotations_json"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("file_contents_file_id_unique").on(table.fileId)]
);

export const shares = pgTable(
  "shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    sharedBy: uuid("shared_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    permission: sharePermissionEnum("permission").notNull().default("view"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    accessCount: integer("access_count").notNull().default(0),
    maxAccessCount: integer("max_access_count"),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("shares_token_unique").on(table.token),
    index("shares_file_id_idx").on(table.fileId),
    index("shares_expires_idx").on(table.expiresAt),
    index("shares_max_access_idx").on(table.maxAccessCount),
    // FK child index: a user delete must not scan every share.
    index("shares_shared_by_idx").on(table.sharedBy),
  ]
);

export const activityScopeStatusEnum = pgEnum("activity_scope_status", ["active", "revoked"]);

export const activityScopes = pgTable(
  "activity_scopes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: activityScopeStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("activity_scopes_owner_unique").on(table.ownerUserId),
    index("activity_scopes_last_active_idx").on(table.lastActiveAt),
  ]
);

export const activityLogs = pgTable(
  "activity_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    activityScopeId: uuid("activity_scope_id")
      .notNull()
      .references(() => activityScopes.id, { onDelete: "cascade" }),
    action: activityActionEnum("action").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    metadata: jsonb("metadata"),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("activity_logs_user_time_idx").on(table.userId, table.createdAt),
    index("activity_logs_scope_time_idx").on(table.activityScopeId, table.createdAt),
    index("activity_logs_action_idx").on(table.action),
    index("activity_logs_created_at_idx").on(table.createdAt),
  ]
);

export const changeHistory = pgTable(
  "change_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    changeType: text("change_type").notNull(),
    snapshot: jsonb("snapshot"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("change_history_file_id_idx").on(table.fileId),
    index("change_history_user_id_idx").on(table.userId),
  ]
);

/** Single-row platform settings (Admin → Settings). */
export const systemSettings = pgTable("system_settings", {
  id: text("id").primaryKey().default("default"),
  data: jsonb("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const folderMemberRoleEnum = pgEnum("folder_member_role", ["view", "edit"]);

export const folderMembers = pgTable(
  "folder_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    folderId: uuid("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: folderMemberRoleEnum("role").notNull().default("view"),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("folder_members_unique").on(table.folderId, table.userId),
    index("folder_members_user_idx").on(table.userId),
  ]
);

export const invitationStatusEnum = pgEnum("invitation_status", ["pending", "accepted", "rejected"]);

export const folderInvitations = pgTable(
  "folder_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    folderId: uuid("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    invitedUserId: uuid("invited_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: folderMemberRoleEnum("role").notNull().default("view"),
    status: invitationStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("folder_invitations_unique").on(table.folderId, table.invitedUserId),
    index("folder_invitations_user_idx").on(table.invitedUserId),
    index("folder_invitations_status_idx").on(table.invitedUserId, table.status),
  ]
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default(["read"]),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("api_keys_user_idx").on(table.userId),
    uniqueIndex("api_keys_prefix_unique").on(table.keyPrefix),
  ]
);

export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    secret: text("secret").notNull(),
    events: jsonb("events").$type<string[]>().notNull().default(["upload", "delete", "share"]),
    enabled: boolean("enabled").notNull().default(true),
    lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }),
    lastStatus: integer("last_status"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("webhooks_user_idx").on(table.userId)]
);

export const fileVersions = pgTable(
  "file_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    r2Key: text("r2_key").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    checksumSha256: text("checksum_sha256"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("file_versions_file_idx").on(table.fileId),
    uniqueIndex("file_versions_unique").on(table.fileId, table.version),
  ]
);

/**
 * Gmail SMTP senders used to deliver OTP and security notifications. Each row is
 * a Gmail account + an App Password (stored ENCRYPTED, never plaintext — see
 * lib/email/crypto.ts). Multiple senders enable priority-ordered failover.
 */
export const mailSenders = pgTable(
  "mail_senders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    /** AES-256-GCM ciphertext of the Gmail App Password (see lib/email/crypto.ts). */
    appPasswordEncrypted: text("app_password_encrypted").notNull(),
    displayName: text("display_name").notNull(),
    /** Friendly From name shown to recipients, e.g. "Storage ByAFR". */
    fromName: text("from_name").notNull().default("Storage ByAFR"),
    status: mailStatusEnum("status").notNull().default("unverified"),
    isActive: boolean("is_active").notNull().default(true),
    lastError: text("last_error"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    priority: integer("priority").notNull().default(0),
    // ── Smart-router state ──────────────────────────────────────────────────
    /** Max messages this sender may send per rolling day (0 = use global default). */
    dailyLimit: integer("daily_limit").notNull().default(0),
    /** Messages sent in the current day window (reset when sentCountResetAt passes). */
    dailySentCount: integer("daily_sent_count").notNull().default(0),
    /** When the daily counter was last reset — the window is 24h from here. */
    sentCountResetAt: timestamp("sent_count_reset_at", { withTimezone: true }),
    /** Last time this sender successfully sent — drives least-recently-used rotation. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** Consecutive send failures; resets to 0 on any success. Feeds the cooldown. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /** When set and in the future, the router skips this sender (temporary rest). */
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("mail_senders_email_unique").on(table.email),
    index("mail_senders_status_idx").on(table.status),
    index("mail_senders_active_idx").on(table.isActive),
  ]
);

export const otpTokens = pgTable(
  "otp_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Legacy OTP-by-phone target; retained nullable until migration 0005 drops it. */
    phoneNumber: text("phone_number"),
    /** Email OTP target (primary channel). */
    email: text("email"),
    code: text("code").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    verified: boolean("verified").notNull().default(false),
    attemptCount: integer("attempt_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("otp_tokens_phone_idx").on(table.phoneNumber),
    index("otp_tokens_email_idx").on(table.email),
    index("otp_tokens_expires_idx").on(table.expiresAt),
  ]
);

export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: text("client_id").notNull(),
    clientSecretHash: text("client_secret_hash"),
    clientName: text("client_name"),
    redirectUris: jsonb("redirect_uris").$type<string[]>().notNull().default([]),
    grantTypes: jsonb("grant_types").$type<string[]>().notNull().default(["authorization_code", "refresh_token"]),
    responseTypes: jsonb("response_types").$type<string[]>().notNull().default(["code"]),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull().default("none"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("oauth_clients_client_id_unique").on(table.clientId)]
);

export const oauthAuthorizationCodes = pgTable(
  "oauth_authorization_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    codeHash: text("code_hash").notNull(),
    clientId: text("client_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    scope: text("scope").notNull().default("read"),
    codeChallenge: text("code_challenge").notNull(),
    codeChallengeMethod: text("code_challenge_method").notNull().default("S256"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("oauth_authorization_codes_hash_unique").on(table.codeHash),
    index("oauth_authorization_codes_client_idx").on(table.clientId),
    index("oauth_authorization_codes_expires_idx").on(table.expiresAt),
  ]
);

export const oauthAccessTokens = pgTable(
  "oauth_access_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    refreshTokenHash: text("refresh_token_hash"),
    clientId: text("client_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope").notNull().default("read"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("oauth_access_tokens_hash_unique").on(table.tokenHash),
    uniqueIndex("oauth_access_tokens_refresh_hash_unique").on(table.refreshTokenHash),
    index("oauth_access_tokens_user_idx").on(table.userId),
    index("oauth_access_tokens_client_idx").on(table.clientId),
  ]
);

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  folders: many(folders),
  files: many(files),
  uploadSessions: many(uploadSessions),
  activityLogs: many(activityLogs),
}));

export const foldersRelations = relations(folders, ({ one, many }) => ({
  user: one(users, { fields: [folders.userId], references: [users.id] }),
  parent: one(folders, { fields: [folders.parentId], references: [folders.id] }),
  files: many(files),
}));

export const filesRelations = relations(files, ({ one, many }) => ({
  user: one(users, { fields: [files.userId], references: [users.id] }),
  folder: one(folders, { fields: [files.folderId], references: [folders.id] }),
  content: one(fileContents),
  uploadSessions: many(uploadSessions),
  shares: many(shares),
  changeHistory: many(changeHistory),
}));

export const uploadSessionsRelations = relations(uploadSessions, ({ one, many }) => ({
  file: one(files, { fields: [uploadSessions.fileId], references: [files.id] }),
  user: one(users, { fields: [uploadSessions.userId], references: [users.id] }),
  parts: many(uploadParts),
}));

export const uploadPartsRelations = relations(uploadParts, ({ one }) => ({
  uploadSession: one(uploadSessions, {
    fields: [uploadParts.uploadSessionId],
    references: [uploadSessions.id],
  }),
}));

export const archiveJobsRelations = relations(archiveJobs, ({ one, many }) => ({
  user: one(users, { fields: [archiveJobs.userId], references: [users.id] }),
  folder: one(folders, { fields: [archiveJobs.folderId], references: [folders.id] }),
  items: many(archiveJobItems),
}));

export const archiveJobItemsRelations = relations(archiveJobItems, ({ one }) => ({
  archiveJob: one(archiveJobs, { fields: [archiveJobItems.archiveJobId], references: [archiveJobs.id] }),
  file: one(files, { fields: [archiveJobItems.fileId], references: [files.id] }),
}));

export const deletionJobsRelations = relations(deletionJobs, ({ one, many }) => ({
  user: one(users, { fields: [deletionJobs.userId], references: [users.id] }),
  folder: one(folders, { fields: [deletionJobs.folderId], references: [folders.id] }),
  items: many(deletionJobItems),
}));

export const deletionJobItemsRelations = relations(deletionJobItems, ({ one }) => ({
  deletionJob: one(deletionJobs, { fields: [deletionJobItems.deletionJobId], references: [deletionJobs.id] }),
  file: one(files, { fields: [deletionJobItems.fileId], references: [files.id] }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Folder = typeof folders.$inferSelect;
export type File = typeof files.$inferSelect;
export type UploadSession = typeof uploadSessions.$inferSelect;
export type UploadPart = typeof uploadParts.$inferSelect;
export type ArchiveJob = typeof archiveJobs.$inferSelect;
export type ArchiveJobItem = typeof archiveJobItems.$inferSelect;
export type DeletionJob = typeof deletionJobs.$inferSelect;
export type DeletionJobItem = typeof deletionJobItems.$inferSelect;
export type ActivityLog = typeof activityLogs.$inferSelect;
export type MailSender = typeof mailSenders.$inferSelect;
export type NewMailSender = typeof mailSenders.$inferInsert;
export type OtpToken = typeof otpTokens.$inferSelect;

// ── Second Brain ────────────────────────────────────────────────────────────

export const brainStatusEnum = pgEnum("brain_status", ["active", "archived"]);
export const brainAgentStatusEnum = pgEnum("brain_agent_status", ["active", "revoked"]);
export const brainPrincipalTypeEnum = pgEnum("brain_principal_type", ["user", "agent"]);
export const brainAccessRoleEnum = pgEnum("brain_access_role", ["owner", "editor", "viewer", "agent"]);
export const memoryTypeEnum = pgEnum("memory_type", [
  "fact", "preference", "decision", "instruction", "project",
  "person", "concept", "experience", "procedure", "event",
  "observation", "conversation", "knowledge",
]);
export const memorySourceTypeEnum = pgEnum("memory_source_type", [
  "user", "agent", "conversation", "imported_document", "manual_note", "api", "system",
]);
export const brainEntityTypeEnum = pgEnum("brain_entity_type", [
  "person", "project", "organization", "technology", "location",
  "concept", "product", "agent", "document", "other",
]);

/**
 * Where a memory sits in its own lifecycle. Distinct from `archivedAt`/`deletedAt`
 * (user intent) — this is what the *knowledge* is worth right now. `stale` and
 * `superseded` memories stay readable and exportable; they only lose ranking
 * weight, because decay must never delete knowledge.
 */
export const memoryValidityStateEnum = pgEnum("memory_validity_state", [
  "active",
  "superseded",
  "stale",
  "retracted",
]);

/** Background-enrichment state machine. `skipped` = deliberately not enriched. */
export const memoryEnrichmentStatusEnum = pgEnum("memory_enrichment_status", [
  "pending",
  "processing",
  "ready",
  "failed",
  "skipped",
]);

/** Node kinds that can carry cached graph metrics. */
export const brainGraphNodeKindEnum = pgEnum("brain_graph_node_kind", ["memory", "entity"]);

/** Lifecycle of one retrieved memory inside one retrieval. Feeds bounded ranking signals. */
export const brainRetrievalOutcomeEnum = pgEnum("brain_retrieval_outcome", [
  "retrieved",
  "selected",
  "omitted",
  "opened",
  "confirmed",
  "corrected",
  "superseded",
]);

/** What a review item is asking the human to look at. */
export const brainReviewKindEnum = pgEnum("brain_review_kind", [
  "contradiction",
  "duplicate",
  "stale",
  "orphan",
  "low_confidence_important",
  "missing_entities",
]);

export const brainReviewStatusEnum = pgEnum("brain_review_status", [
  "open",
  "dismissed",
  "resolved",
]);

/**
 * PHASE 2: Origin of a memory relationship — derived vs inferred.
 * - derived: one signal family passed its gate (semantic OR tag OR entity OR project)
 * - inferred: >= 2 independent signal families agreed (higher confidence)
 */
export const memoryRelationOriginEnum = pgEnum("memory_relation_origin", [
  "derived",
  "inferred",
]);

/**
 * PHASE 2: Status of a derived relationship — applied vs suggested.
 * - applied: readable by brain_related (confidence >= threshold)
 * - suggested: scored but awaiting policy/human approval (invisible by default)
 */
export const memoryRelationStatusEnum = pgEnum("memory_relation_status", [
  "applied",
  "suggested",
]);

export const brains = pgTable(
  "brains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    isDefault: boolean("is_default").notNull().default(false),
    status: brainStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("brains_owner_idx").on(table.ownerUserId),
    // Partial unique index: at most ONE default brain per user. Without it two
    // concurrent getOrCreateDefaultBrain() calls both see "none" and insert.
    uniqueIndex("brains_owner_default_unique")
      .on(table.ownerUserId)
      .where(sql`is_default`),
  ]
);

export const brainAgents = pgTable(
  "brain_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    type: text("type").notNull().default("agent"),
    status: brainAgentStatusEnum("status").notNull().default("active"),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("brain_agents_owner_idx").on(table.ownerUserId),
    index("brain_agents_status_idx").on(table.ownerUserId, table.status),
  ]
);

export const brainAccess = pgTable(
  "brain_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brainId: uuid("brain_id").notNull().references(() => brains.id, { onDelete: "cascade" }),
    principalType: brainPrincipalTypeEnum("principal_type").notNull(),
    principalId: uuid("principal_id").notNull(),
    role: brainAccessRoleEnum("role").notNull().default("viewer"),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("brain_access_unique").on(table.brainId, table.principalType, table.principalId),
    index("brain_access_principal_idx").on(table.principalType, table.principalId),
    index("brain_access_brain_idx").on(table.brainId),
  ]
);

export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brainId: uuid("brain_id").notNull().references(() => brains.id, { onDelete: "cascade" }),
    type: memoryTypeEnum("type").notNull().default("fact"),
    title: text("title").notNull(),
    content: text("content").notNull(),
    summary: text("summary"),
    importance: real("importance").notNull().default(0.5),
    confidence: real("confidence").notNull().default(0.9),
    sourceType: memorySourceTypeEnum("source_type").notNull().default("user"),
    sourceId: text("source_id"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdByAgent: uuid("created_by_agent").references(() => brainAgents.id, { onDelete: "set null" }),
    // Deleting a project must not delete the knowledge gathered under it.
    projectId: uuid("project_id").references(() => brainProjects.id, { onDelete: "set null" }),
    metadata: jsonb("metadata"),
    version: integer("version").notNull().default(1),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),

    // ── Second Brain 2.0: enrichment bookkeeping ──────────────────────────
    /**
     * SHA-256 of the enrichable payload (type + title + content + summary).
     * Enrichment compares this against `enrichedHash` so re-running the job for
     * an unchanged memory is a no-op — the idempotency key required by P1.
     */
    contentHash: text("content_hash"),
    enrichedHash: text("enriched_hash"),
    enrichmentStatus: memoryEnrichmentStatusEnum("enrichment_status").notNull().default("pending"),
    enrichmentError: text("enrichment_error"),
    enrichedAt: timestamp("enriched_at", { withTimezone: true }),

    // ── Second Brain 2.0: temporal / epistemic state ──────────────────────
    /** Bounded usage counters. Retrieval feedback must not run away (P10). */
    recallCount: integer("recall_count").notNull().default(0),
    lastRecalledAt: timestamp("last_recalled_at", { withTimezone: true }),
    confirmationCount: integer("confirmation_count").notNull().default(0),
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }),
    /** Explicit validity window. NULL `validFrom` means "since createdAt". */
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    validityState: memoryValidityStateEnum("validity_state").notNull().default("active"),
    /** Set when consolidation supersedes this memory. Never deletes the row. */
    supersededById: uuid("superseded_by_id").references((): AnyPgColumn => memories.id, {
      onDelete: "set null",
    }),
    /** Extra surface forms for this memory's subject, used by mention detection. */
    aliases: text("aliases").array(),

    // ── Second Brain 2.0: semantic embedding (P9) ─────────────────────────
    /**
     * Dense vector for semantic retrieval. NULL until an embedding provider is
     * configured and the embed job has run — the semantic leg simply abstains for
     * rows without one, so an un-embedded brain degrades to lexical+graph, never fails.
     */
    embedding: vector("embedding"),
    /** Which model produced {@link embedding}. Drives idempotent re-embedding on model change. */
    embeddingModel: text("embedding_model"),
    embeddingUpdatedAt: timestamp("embedding_updated_at", { withTimezone: true }),

    searchVector: tsvector("search_vector").generatedAlwaysAs(
      (): SQL =>
        sql`setweight(to_tsvector('simple', coalesce(${memories.title}, '')), 'A') || setweight(to_tsvector('simple', coalesce(${memories.content}, '')), 'B')`
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("memories_brain_idx").on(table.brainId),
    index("memories_brain_type_idx").on(table.brainId, table.type),
    index("memories_brain_created_idx").on(table.brainId, table.createdAt),
    index("memories_brain_importance_idx").on(table.brainId, table.importance),
    index("memories_brain_deleted_idx").on(table.brainId, table.deletedAt),
    // Matches the (created_at, id) keyset order used by listMemories().
    index("memories_brain_keyset_idx").on(table.brainId, table.createdAt, table.id),
    index("memories_project_idx").on(table.projectId),
    index("memories_search_vector_idx").using("gin", table.searchVector),
    // Worker claim query: "next N memories in this brain needing enrichment".
    index("memories_enrichment_idx")
      .on(table.brainId, table.enrichmentStatus)
      .where(sql`enrichment_status <> 'ready'`),
    index("memories_brain_validity_idx").on(table.brainId, table.validityState),
    index("memories_superseded_by_idx").on(table.supersededById),
    // Temporal ranking + "what did I last touch" reads.
    index("memories_brain_recalled_idx").on(table.brainId, table.lastRecalledAt),
    // FK child indexes: deleting a user or revoking an agent's key must not scan the
    // whole memories table to check authorship.
    index("memories_created_by_idx").on(table.createdBy),
    index("memories_created_by_agent_idx").on(table.createdByAgent),
  ]
);

/**
 * Global (single-row) configuration for the semantic embedding provider (P9).
 *
 * One row, `id = "default"`, mirroring {@link systemSettings}. The API key is a
 * server-wide secret with cost + privacy impact, so it is stored ENCRYPTED at rest
 * (AES-256-GCM via lib/email/crypto.ts) in `api_key_encrypted` and is NEVER returned
 * to any client — the GET surface exposes only `{provider, model, enabled, hasApiKey}`.
 * Writes are gated behind master auth, exactly like the Gmail sender secret.
 */
export const brainEmbeddingSettings = pgTable("brain_embedding_settings", {
  id: text("id").primaryKey().default("default"),
  /** Provider identifier, e.g. "openrouter". */
  provider: text("provider").notNull().default("openrouter"),
  /** Embedding model, e.g. "openai/text-embedding-3-small". */
  model: text("model").notNull().default("openai/text-embedding-3-small"),
  /** AES-256-GCM ciphertext of the API key. NULL when unset. Never leaves the server. */
  apiKeyEncrypted: text("api_key_encrypted"),
  /** Auto-detected native width of the configured model. Used to validate that returned
   *  vectors stay a consistent width; the column itself is dimension-flexible. */
  dimensions: integer("dimensions").notNull().default(1536),
  /** Master switch. When false the semantic leg abstains regardless of key presence. */
  enabled: boolean("enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memoryVersions = pgTable(
  "memory_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memoryId: uuid("memory_id").notNull().references(() => memories.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    summary: text("summary"),
    changedBy: uuid("changed_by").references(() => users.id, { onDelete: "set null" }),
    changedByAgent: uuid("changed_by_agent").references(() => brainAgents.id, { onDelete: "set null" }),
    changeReason: text("change_reason"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("memory_versions_unique").on(table.memoryId, table.versionNumber),
    index("memory_versions_memory_idx").on(table.memoryId),
    // FK child indexes for the two authorship columns.
    index("memory_versions_changed_by_idx").on(table.changedBy),
    index("memory_versions_changed_by_agent_idx").on(table.changedByAgent),
  ]
);

export const memoryTags = pgTable(
  "memory_tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brainId: uuid("brain_id").notNull().references(() => brains.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("memory_tags_brain_name_unique").on(table.brainId, table.name),
    index("memory_tags_brain_idx").on(table.brainId),
  ]
);

export const memoryTagMap = pgTable(
  "memory_tag_map",
  {
    memoryId: uuid("memory_id").notNull().references(() => memories.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id").notNull().references(() => memoryTags.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.memoryId, table.tagId] }),
    // PHASE 2: reverse lookup for "which memories use tag X" candidate probe
    index("memory_tag_map_tag_idx").on(table.tagId, table.memoryId),
  ]
);

export const brainProjectStatusEnum = pgEnum("brain_project_status", [
  "active",
  "paused",
  "done",
  "archived",
]);

export const brainProjects = pgTable(
  "brain_projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brainId: uuid("brain_id").notNull().references(() => brains.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    status: brainProjectStatusEnum("status").notNull().default("active"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("brain_projects_brain_idx").on(table.brainId),
    index("brain_projects_brain_status_idx").on(table.brainId, table.status),
    uniqueIndex("brain_projects_brain_name_unique").on(table.brainId, table.name),
  ]
);

export const brainEntities = pgTable(
  "brain_entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brainId: uuid("brain_id").notNull().references(() => brains.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: brainEntityTypeEnum("type").notNull().default("other"),
    description: text("description"),
    metadata: jsonb("metadata"),
    // ── Second Brain 2.0: extraction provenance (P1) ──────────────────────
    /** Alternate surface forms that resolve to this node ("R2", "Cloudflare R2"). */
    aliases: text("aliases").array(),
    mentionCount: integer("mention_count").notNull().default(0),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    /** Which extractor produced this node, e.g. `manual` or `deterministic-v1`. */
    extractedBy: text("extracted_by"),
    extractionConfidence: real("extraction_confidence"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("brain_entities_brain_idx").on(table.brainId),
    index("brain_entities_brain_type_idx").on(table.brainId, table.type),
    // One node per (name, type) inside a brain so repeated extraction upserts
    // instead of piling up near-duplicate nodes.
    uniqueIndex("brain_entities_brain_name_type_unique").on(
      table.brainId,
      table.name,
      table.type
    ),
  ]
);

export const brainRelationships = pgTable(
  "brain_relationships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brainId: uuid("brain_id").notNull().references(() => brains.id, { onDelete: "cascade" }),
    sourceEntityId: uuid("source_entity_id").notNull().references(() => brainEntities.id, { onDelete: "cascade" }),
    targetEntityId: uuid("target_entity_id").notNull().references(() => brainEntities.id, { onDelete: "cascade" }),
    relationshipType: text("relationship_type").notNull(),
    confidence: real("confidence").notNull().default(0.9),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("brain_relationships_brain_idx").on(table.brainId),
    index("brain_relationships_source_idx").on(table.sourceEntityId),
    index("brain_relationships_target_idx").on(table.targetEntityId),
    uniqueIndex("brain_relationships_unique").on(
      table.sourceEntityId,
      table.targetEntityId,
      table.relationshipType
    ),
  ]
);

/**
 * A link that starts at a memory. Two shapes in one table:
 *  - memory -> memory  ("this decision supersedes that one")
 *  - memory -> entity  ("this memory mentions Cloudflare R2")
 *
 * brain_relationships stays entity->entity; backlinks for a memory need the other
 * two directions, and keeping them here means "referenced by" is one indexed
 * lookup instead of a client-side scan of every memory body (§41).
 */
export const memoryLinkTargetEnum = pgEnum("memory_link_target", ["memory", "entity"]);

export const memoryLinks = pgTable(
  "memory_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brainId: uuid("brain_id").notNull().references(() => brains.id, { onDelete: "cascade" }),
    sourceMemoryId: uuid("source_memory_id").notNull().references(() => memories.id, { onDelete: "cascade" }),
    targetType: memoryLinkTargetEnum("target_type").notNull(),
    targetMemoryId: uuid("target_memory_id").references(() => memories.id, { onDelete: "cascade" }),
    targetEntityId: uuid("target_entity_id").references(() => brainEntities.id, { onDelete: "cascade" }),
    linkType: text("link_type").notNull().default("relates_to"),
    metadata: jsonb("metadata"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdByAgent: uuid("created_by_agent").references(() => brainAgents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("memory_links_brain_idx").on(table.brainId),
    index("memory_links_source_idx").on(table.sourceMemoryId),
    index("memory_links_target_memory_idx").on(table.targetMemoryId),
    index("memory_links_target_entity_idx").on(table.targetEntityId),
    // FK child indexes for the two authorship columns.
    index("memory_links_created_by_idx").on(table.createdBy),
    index("memory_links_created_by_agent_idx").on(table.createdByAgent),
    // Partial uniques: re-linking the same pair with the same verb updates rather
    // than piling up duplicates. Two indexes because only one target is ever set.
    uniqueIndex("memory_links_memory_unique")
      .on(table.sourceMemoryId, table.targetMemoryId, table.linkType)
      .where(sql`target_memory_id is not null`),
    uniqueIndex("memory_links_entity_unique")
      .on(table.sourceMemoryId, table.targetEntityId, table.linkType)
      .where(sql`target_entity_id is not null`),
    // Integrity in the database, not just in the service (§48): exactly one target,
    // matching target_type, and never a memory linked to itself.
    check(
      "memory_links_one_target",
      sql`(("target_memory_id" IS NOT NULL)::int + ("target_entity_id" IS NOT NULL)::int) = 1`
    ),
    check(
      "memory_links_target_type_matches",
      sql`("target_type" = 'memory' AND "target_memory_id" IS NOT NULL) OR ("target_type" = 'entity' AND "target_entity_id" IS NOT NULL)`
    ),
    check(
      "memory_links_no_self_link",
      sql`"target_memory_id" IS NULL OR "target_memory_id" <> "source_memory_id"`
    ),
  ]
);

export const brainAuditLogs = pgTable(
  "brain_audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brainId: uuid("brain_id").notNull().references(() => brains.id, { onDelete: "cascade" }),
    principalType: brainPrincipalTypeEnum("principal_type").notNull(),
    principalId: uuid("principal_id").notNull(),
    operation: text("operation").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("brain_audit_logs_brain_time_idx").on(table.brainId, table.createdAt),
    index("brain_audit_logs_principal_idx").on(table.principalType, table.principalId),
  ]
);

// ── Second Brain 2.0: intelligence tables ───────────────────────────────────

/**
 * One occurrence of an entity inside one memory, with the exact surface form and
 * character offsets that produced it. This is the evidence layer: every
 * memory→entity link the enrichment pipeline writes can be traced back to the
 * literal span that justified it, so no relationship is ever unexplainable.
 */
export const memoryMentions = pgTable(
  "memory_mentions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brainId: uuid("brain_id").notNull().references(() => brains.id, { onDelete: "cascade" }),
    memoryId: uuid("memory_id").notNull().references(() => memories.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id").notNull().references(() => brainEntities.id, { onDelete: "cascade" }),
    /** `title` | `summary` | `content` — which field the span was found in. */
    field: text("field").notNull(),
    /** The literal matched text, kept verbatim for auditability. */
    surface: text("surface").notNull(),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    confidence: real("confidence").notNull().default(1),
    extractedBy: text("extracted_by").notNull().default("deterministic-v1"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("memory_mentions_brain_idx").on(table.brainId),
    index("memory_mentions_memory_idx").on(table.memoryId),
    index("memory_mentions_entity_idx").on(table.brainId, table.entityId),
    // FK child index: entity_id alone. The composite above leads with brain_id, which a
    // foreign-key check on entity_id cannot use, so an entity delete or merge would
    // otherwise scan every mention.
    index("memory_mentions_entity_fk_idx").on(table.entityId),
    // Re-running enrichment on unchanged text must not duplicate spans.
    uniqueIndex("memory_mentions_span_unique").on(
      table.memoryId,
      table.entityId,
      table.field,
      table.startOffset
    ),
    check("memory_mentions_offsets", sql`"end_offset" > "start_offset"`),
    check("memory_mentions_field", sql`"field" IN ('title', 'summary', 'content')`),
  ]
);

/**
 * Cached graph metrics per node. Recomputing PageRank/communities on every
 * request is the O(N) trap the performance rules forbid, so the worker writes
 * this table and readers treat it as a stale-tolerant cache: absent rows mean
 * "not computed yet", never "metric is zero".
 */
export const brainGraphMetrics = pgTable(
  "brain_graph_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brainId: uuid("brain_id").notNull().references(() => brains.id, { onDelete: "cascade" }),
    nodeKind: brainGraphNodeKindEnum("node_kind").notNull(),
    /** Not an FK: one column has to point at either memories or brain_entities. */
    nodeId: uuid("node_id").notNull(),
    degree: integer("degree").notNull().default(0),
    weightedDegree: real("weighted_degree").notNull().default(0),
    pagerank: real("pagerank").notNull().default(0),
    /** Label-propagation community id, stable within one computation run. */
    communityId: integer("community_id"),
    componentId: integer("component_id"),
    isBridge: boolean("is_bridge").notNull().default(false),
    isOrphan: boolean("is_orphan").notNull().default(false),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("brain_graph_metrics_node_unique").on(table.brainId, table.nodeKind, table.nodeId),
    index("brain_graph_metrics_brain_rank_idx").on(table.brainId, table.pagerank),
    index("brain_graph_metrics_brain_kind_idx").on(table.brainId, table.nodeKind),
  ]
);

/** Point-in-time health rollup so the UI can show a trend without a full rescan. */
export const brainHealthSnapshots = pgTable(
  "brain_health_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brainId: uuid("brain_id").notNull().references(() => brains.id, { onDelete: "cascade" }),
    totalMemories: integer("total_memories").notNull().default(0),
    staleCount: integer("stale_count").notNull().default(0),
    contradictionCount: integer("contradiction_count").notNull().default(0),
    duplicateCount: integer("duplicate_count").notNull().default(0),
    orphanCount: integer("orphan_count").notNull().default(0),
    weakClusterCount: integer("weak_cluster_count").notNull().default(0),
    missingEntityCount: integer("missing_entity_count").notNull().default(0),
    lowConfidenceImportantCount: integer("low_confidence_important_count").notNull().default(0),
    avgConfidence: real("avg_confidence").notNull().default(0),
    /** 0..1 composite. Deterministic function of the counters above. */
    score: real("score").notNull().default(0),
    /** Counter breakdown only — never memory titles or content. */
    details: jsonb("details"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("brain_health_snapshots_brain_time_idx").on(table.brainId, table.createdAt),
  ]
);

/**
 * Retrieval telemetry feeding the ranking feedback loop (P10).
 *
 * Privacy: `queryHash` is a salted SHA-256 of the normalized query — the raw
 * query text is NEVER stored, because Brain content must not leak into
 * analytics. The hash exists only to group events from one retrieval.
 */
export const brainRetrievalEvents = pgTable(
  "brain_retrieval_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brainId: uuid("brain_id").notNull().references(() => brains.id, { onDelete: "cascade" }),
    memoryId: uuid("memory_id").notNull().references(() => memories.id, { onDelete: "cascade" }),
    queryHash: text("query_hash"),
    /** Which surface produced the event: `brain_context`, `brain_search`, ... */
    tool: text("tool").notNull(),
    outcome: brainRetrievalOutcomeEnum("outcome").notNull(),
    rank: integer("rank"),
    score: real("score"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").references(() => brainAgents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("brain_retrieval_events_brain_time_idx").on(table.brainId, table.createdAt),
    index("brain_retrieval_events_memory_idx").on(table.memoryId, table.outcome),
    index("brain_retrieval_events_query_idx").on(table.brainId, table.queryHash),
  ]
);

/**
 * Human review queue. Contradictions and duplicates are surfaced here instead of
 * being auto-resolved — resolution is always an explicit user/policy decision.
 *
 * `dedupeKey` is a deterministic string built by the health service (kind plus
 * the sorted memory ids), so re-scanning updates the existing row rather than
 * flooding the queue.
 */
export const brainReviewItems = pgTable(
  "brain_review_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brainId: uuid("brain_id").notNull().references(() => brains.id, { onDelete: "cascade" }),
    kind: brainReviewKindEnum("kind").notNull(),
    status: brainReviewStatusEnum("status").notNull().default("open"),
    memoryId: uuid("memory_id").references(() => memories.id, { onDelete: "cascade" }),
    relatedMemoryId: uuid("related_memory_id").references(() => memories.id, { onDelete: "cascade" }),
    dedupeKey: text("dedupe_key").notNull(),
    /** Short machine-generated explanation, e.g. "negation + 0.71 overlap". */
    reason: text("reason").notNull(),
    /** Structured evidence (scores, shared terms) — bounded, no full content. */
    evidence: jsonb("evidence"),
    priority: real("priority").notNull().default(0.5),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("brain_review_items_dedupe_unique").on(table.brainId, table.dedupeKey),
    index("brain_review_items_brain_status_idx").on(table.brainId, table.status, table.priority),
    index("brain_review_items_memory_idx").on(table.memoryId),
  ]
);

/**
 * PHASE 2: Derived memory relationships — algorithmic intelligence layer.
 *
 * This table stores relationships discovered by the relate.ts scoring engine, distinct
 * from explicit user/agent assertions in memory_links. Every row carries full provenance
 * (origin, confidence, evidence, reason, computedBy) so agents can distinguish stated
 * facts from algorithmic inferences.
 *
 * Design invariants:
 * - Undirected: sourceMemoryId < targetMemoryId enforced by CHECK, one row per pair
 * - Tenant-isolated: brainId in every WHERE clause
 * - Reconcilable: computedBy version key, so relate-v1 only touches its own rows
 * - Idempotent: sourceHashA/B detect stale edges without re-scoring
 * - Bounded: evidence is small structured data, never full memory content
 *
 * Readers:
 * - brain_related: merges explicit + derived + retrieval, returns origin field
 * - context-engine: includes derived with explicit=false and derived_ prefix
 * - provenance/brain_explain: shows derivedRelationships with full evidence
 *
 * Non-readers (by design, explicit-only):
 * - brain_path: reasoning chains must be explicit assertions
 * - health-service: orphan/weak-cluster metrics count only explicit curation
 * - export/import: derived edges are ephemeral, rebuilt from scratch on import
 */
export const memoryDerivedLinks = pgTable(
  "memory_derived_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brainId: uuid("brain_id")
      .notNull()
      .references(() => brains.id, { onDelete: "cascade" }),

    /**
     * Canonical undirected pair: sourceMemoryId < targetMemoryId.
     * Enforced by CHECK constraint. Lookup in both directions uses two indexes.
     */
    sourceMemoryId: uuid("source_memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    targetMemoryId: uuid("target_memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),

    /** derived (1 signal family) | inferred (>= 2 independent families) */
    origin: memoryRelationOriginEnum("origin").notNull(),

    /** applied (visible to brain_related) | suggested (awaiting policy/human) */
    status: memoryRelationStatusEnum("status").notNull().default("applied"),

    /** Dominant signal family: semantic | tag | entity | project */
    relation: text("relation").notNull(),

    /** Edge strength 0..1 from relate.ts blend */
    weight: real("weight").notNull(),

    /**
     * Belief 0..1 — function of how many signal families agreed, NOT the weight.
     * Used for APPLY vs SUGGEST policy threshold.
     */
    confidence: real("confidence").notNull(),

    /**
     * Bounded structured evidence, safe to send to agents:
     * { signals: {...}, sharedTerms?: [], sharedTags?: [], sharedEntityIds?: [], similarity?: number }
     * Never contains full memory content.
     */
    evidence: jsonb("evidence"),

    /** Human-readable explanation <= 90 chars from relate.ts */
    reason: text("reason").notNull(),

    /**
     * Scorer version, e.g. "relate-v1". Reconciliation deletes only rows with
     * matching computedBy, so multiple algorithm versions can coexist safely.
     */
    computedBy: text("computed_by").notNull(),

    /**
     * memories.contentHash of each endpoint at compute time.
     * Cheap staleness detection: hash mismatch → recompute without re-scoring.
     */
    sourceHashA: text("source_hash_a"),
    sourceHashB: text("source_hash_b"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Undirected pair uniqueness at DB level
    uniqueIndex("memory_derived_links_pair_unique").on(
      table.brainId,
      table.sourceMemoryId,
      table.targetMemoryId
    ),

    // Directional lookup: "applied derived neighbors of memory X, by weight DESC"
    index("memory_derived_links_source_idx").on(
      table.brainId,
      table.sourceMemoryId,
      table.status,
      table.weight
    ),

    // Reverse direction (undirected needs both for efficient UNION scan)
    index("memory_derived_links_target_idx").on(
      table.brainId,
      table.targetMemoryId,
      table.status,
      table.weight
    ),

    // Reconciliation: "delete rows written by version V"
    index("memory_derived_links_version_idx").on(table.brainId, table.computedBy),
    // FK child indexes on both endpoints. Every index above leads with brain_id, which
    // the ON DELETE CASCADE check cannot use, so hard-deleting one memory would scan
    // every derived edge in the database.
    index("memory_derived_links_source_memory_idx").on(table.sourceMemoryId),
    index("memory_derived_links_target_memory_idx").on(table.targetMemoryId),

    // Canonical ordering enforced
    check("memory_derived_links_canonical", sql`"source_memory_id" < "target_memory_id"`),

    // Range validation
    check("memory_derived_links_weight", sql`"weight" >= 0 AND "weight" <= 1`),
    check("memory_derived_links_confidence", sql`"confidence" >= 0 AND "confidence" <= 1`),

    // No self-edges
    check("memory_derived_links_no_self", sql`"source_memory_id" <> "target_memory_id"`),
  ]
);

// Relations
export const brainsRelations = relations(brains, ({ one, many }) => ({
  owner: one(users, { fields: [brains.ownerUserId], references: [users.id] }),
  memories: many(memories),
  access: many(brainAccess),
  projects: many(brainProjects),
  entities: many(brainEntities),
  relationships: many(brainRelationships),
  auditLogs: many(brainAuditLogs),
}));

export const brainAgentsRelations = relations(brainAgents, ({ one }) => ({
  owner: one(users, { fields: [brainAgents.ownerUserId], references: [users.id] }),
  apiKey: one(apiKeys, { fields: [brainAgents.apiKeyId], references: [apiKeys.id] }),
}));

export const brainProjectsRelations = relations(brainProjects, ({ one, many }) => ({
  brain: one(brains, { fields: [brainProjects.brainId], references: [brains.id] }),
  memories: many(memories),
}));

export const memoriesRelations = relations(memories, ({ one, many }) => ({
  brain: one(brains, { fields: [memories.brainId], references: [brains.id] }),
  project: one(brainProjects, { fields: [memories.projectId], references: [brainProjects.id] }),
  createdByUser: one(users, { fields: [memories.createdBy], references: [users.id] }),
  createdByAgentRel: one(brainAgents, { fields: [memories.createdByAgent], references: [brainAgents.id] }),
  versions: many(memoryVersions),
  tags: many(memoryTagMap),
}));

export const memoryVersionsRelations = relations(memoryVersions, ({ one }) => ({
  memory: one(memories, { fields: [memoryVersions.memoryId], references: [memories.id] }),
}));

export const memoryTagsRelations = relations(memoryTags, ({ one, many }) => ({
  brain: one(brains, { fields: [memoryTags.brainId], references: [brains.id] }),
  memories: many(memoryTagMap),
}));

export const memoryTagMapRelations = relations(memoryTagMap, ({ one }) => ({
  memory: one(memories, { fields: [memoryTagMap.memoryId], references: [memories.id] }),
  tag: one(memoryTags, { fields: [memoryTagMap.tagId], references: [memoryTags.id] }),
}));

export const brainEntitiesRelations = relations(brainEntities, ({ one, many }) => ({
  brain: one(brains, { fields: [brainEntities.brainId], references: [brains.id] }),
  outgoing: many(brainRelationships, { relationName: "source" }),
  incoming: many(brainRelationships, { relationName: "target" }),
}));

export const brainRelationshipsRelations = relations(brainRelationships, ({ one }) => ({
  brain: one(brains, { fields: [brainRelationships.brainId], references: [brains.id] }),
  source: one(brainEntities, { fields: [brainRelationships.sourceEntityId], references: [brainEntities.id], relationName: "source" }),
  target: one(brainEntities, { fields: [brainRelationships.targetEntityId], references: [brainEntities.id], relationName: "target" }),
}));

export const brainAuditLogsRelations = relations(brainAuditLogs, ({ one }) => ({
  brain: one(brains, { fields: [brainAuditLogs.brainId], references: [brains.id] }),
}));

export type Brain = typeof brains.$inferSelect;
export type NewBrain = typeof brains.$inferInsert;
export type BrainAgent = typeof brainAgents.$inferSelect;
export type NewBrainAgent = typeof brainAgents.$inferInsert;
export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;
export type MemoryVersion = typeof memoryVersions.$inferSelect;
export type MemoryTag = typeof memoryTags.$inferSelect;
export type BrainProject = typeof brainProjects.$inferSelect;
export type NewBrainProject = typeof brainProjects.$inferInsert;
export type BrainEntity = typeof brainEntities.$inferSelect;
export type NewBrainEntity = typeof brainEntities.$inferInsert;
export type BrainRelationship = typeof brainRelationships.$inferSelect;
export type NewBrainRelationship = typeof brainRelationships.$inferInsert;
export type BrainAuditLog = typeof brainAuditLogs.$inferSelect;
export type MemoryTagMap = typeof memoryTagMap.$inferSelect;

export const memoryLinksRelations = relations(memoryLinks, ({ one }) => ({
  brain: one(brains, { fields: [memoryLinks.brainId], references: [brains.id] }),
  sourceMemory: one(memories, {
    fields: [memoryLinks.sourceMemoryId],
    references: [memories.id],
    relationName: "linkSource",
  }),
  targetMemory: one(memories, {
    fields: [memoryLinks.targetMemoryId],
    references: [memories.id],
    relationName: "linkTarget",
  }),
  targetEntity: one(brainEntities, {
    fields: [memoryLinks.targetEntityId],
    references: [brainEntities.id],
  }),
}));

export type MemoryLink = typeof memoryLinks.$inferSelect;
export type NewMemoryLink = typeof memoryLinks.$inferInsert;

export const memoryMentionsRelations = relations(memoryMentions, ({ one }) => ({
  brain: one(brains, { fields: [memoryMentions.brainId], references: [brains.id] }),
  memory: one(memories, { fields: [memoryMentions.memoryId], references: [memories.id] }),
  entity: one(brainEntities, { fields: [memoryMentions.entityId], references: [brainEntities.id] }),
}));

export const brainRetrievalEventsRelations = relations(brainRetrievalEvents, ({ one }) => ({
  brain: one(brains, { fields: [brainRetrievalEvents.brainId], references: [brains.id] }),
  memory: one(memories, { fields: [brainRetrievalEvents.memoryId], references: [memories.id] }),
}));

export const brainReviewItemsRelations = relations(brainReviewItems, ({ one }) => ({
  brain: one(brains, { fields: [brainReviewItems.brainId], references: [brains.id] }),
  memory: one(memories, { fields: [brainReviewItems.memoryId], references: [memories.id] }),
}));

export type MemoryMention = typeof memoryMentions.$inferSelect;
export type NewMemoryMention = typeof memoryMentions.$inferInsert;
export type BrainGraphMetric = typeof brainGraphMetrics.$inferSelect;
export type NewBrainGraphMetric = typeof brainGraphMetrics.$inferInsert;
export type BrainHealthSnapshot = typeof brainHealthSnapshots.$inferSelect;
export type NewBrainHealthSnapshot = typeof brainHealthSnapshots.$inferInsert;
export type BrainRetrievalEvent = typeof brainRetrievalEvents.$inferSelect;
export type NewBrainRetrievalEvent = typeof brainRetrievalEvents.$inferInsert;
export type BrainReviewItem = typeof brainReviewItems.$inferSelect;
export type NewBrainReviewItem = typeof brainReviewItems.$inferInsert;
