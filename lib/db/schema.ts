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
  ]
);

export const activityLogs = pgTable(
  "activity_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    action: activityActionEnum("action").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    metadata: jsonb("metadata"),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("activity_logs_user_time_idx").on(table.userId, table.createdAt),
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
