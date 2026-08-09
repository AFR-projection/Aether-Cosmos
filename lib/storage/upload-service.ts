import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  files,
  uploadParts,
  uploadSessions,
  users,
  type UploadSessionStatus,
} from "@/lib/db/schema";
import {
  abortMultipartUpload,
  buildR2Key,
  completeMultipartUpload,
  createMultipartUploadSession,
  deleteR2Object,
  getPresignedMultipartPartUrl,
  getPresignedUploadUrl,
  headObject,
} from "@/lib/storage/r2";
import {
  assertFileUploadTransition,
  assertUploadSessionTransition,
} from "@/lib/storage/upload-state";

export const MULTIPART_MIN_SIZE_BYTES = 64 * 1024 * 1024;
export const MULTIPART_MIN_PART_SIZE_BYTES = 64 * 1024 * 1024;
export const MULTIPART_MAX_PARTS = 10_000;

export class UploadServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400
  ) {
    super(message);
    this.name = "UploadServiceError";
  }
}

export type UploadInitInput = {
  userId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  folderId: string | null;
  idempotencyKey: string;
  encrypted: boolean;
  encryptionMeta: Record<string, unknown> | null;
  checksumSha256?: string;
  expiresAt: Date;
};

export type UploadInitResult = {
  sessionId: string;
  fileId: string;
  objectKey: string;
  uploadType: "single" | "multipart";
  status: UploadSessionStatus;
  totalSizeBytes: number;
  partSizeBytes: number | null;
  partCount: number;
  uploadId: string | null;
  uploadUrl: string | null;
};

export type UploadPartInput = {
  partNumber: number;
  etag: string;
  checksumSha256?: string;
};

function roundUpToMiB(bytes: number): number {
  const mib = 1024 * 1024;
  return Math.ceil(bytes / mib) * mib;
}

/** Choose a bounded part count without making retries needlessly expensive. */
export function calculateMultipartPartSize(sizeBytes: number): number {
  return roundUpToMiB(
    Math.max(MULTIPART_MIN_PART_SIZE_BYTES, Math.ceil(sizeBytes / MULTIPART_MAX_PARTS))
  );
}

export function shouldUseMultipart(sizeBytes: number): boolean {
  return sizeBytes >= MULTIPART_MIN_SIZE_BYTES;
}

export function calculateMultipartPartCount(sizeBytes: number, partSizeBytes: number): number {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new UploadServiceError("INVALID_SIZE", "Upload size must be a positive safe integer");
  }
  if (!Number.isSafeInteger(partSizeBytes) || partSizeBytes <= 0) {
    throw new UploadServiceError("INVALID_PART_SIZE", "Multipart part size is invalid");
  }
  const count = Math.ceil(sizeBytes / partSizeBytes);
  if (count > MULTIPART_MAX_PARTS) {
    throw new UploadServiceError("TOO_MANY_PARTS", "Upload exceeds the multipart part limit");
  }
  return count;
}

function assertSameInit(existing: typeof uploadSessions.$inferSelect, input: UploadInitInput, file: typeof files.$inferSelect) {
  if (
    file.name !== input.filename ||
    file.sizeBytes !== input.sizeBytes ||
    file.folderId !== input.folderId ||
    existing.objectKey !== buildR2Key(input.userId, file.id, input.filename)
  ) {
    throw new UploadServiceError(
      "IDEMPOTENCY_KEY_REUSED",
      "Idempotency key is already associated with a different upload",
      409
    );
  }
}

async function reserveAndCreate(input: UploadInitInput): Promise<UploadInitResult> {
  const multipart = shouldUseMultipart(input.sizeBytes);
  const partSizeBytes = multipart ? calculateMultipartPartSize(input.sizeBytes) : null;
  const partCount = partSizeBytes
    ? calculateMultipartPartCount(input.sizeBytes, partSizeBytes)
    : 1;

  const created = await db.transaction(async (tx) => {
    const [reserved] = await tx
      .update(users)
      .set({ reservedBytes: sql`${users.reservedBytes} + ${input.sizeBytes}` })
      .where(
        and(
          eq(users.id, input.userId),
          sql`${users.usedBytes} + ${users.reservedBytes} + ${input.sizeBytes} <= ${users.quotaBytes}`
        )
      )
      .returning({ id: users.id });

    if (!reserved) {
      throw new UploadServiceError("QUOTA_EXCEEDED", "Storage quota exceeded", 400);
    }

    const [file] = await tx
      .insert(files)
      .values({
        userId: input.userId,
        folderId: input.folderId,
        name: input.filename,
        mimeType: input.encrypted ? "application/octet-stream" : input.mimeType,
        sizeBytes: input.sizeBytes,
        r2Key: buildR2Key(input.userId, crypto.randomUUID()),
        status: "created",
        checksumSha256: input.checksumSha256 ?? null,
        encrypted: input.encrypted,
        encryptionMeta: input.encryptionMeta,
      })
      .returning();

    // Replace the temporary key with the immutable file-ID key once the ID is
    // known. This update is inside the same transaction as the reservation.
    const objectKey = buildR2Key(input.userId, file.id);
    const [updatedFile] = await tx
      .update(files)
      .set({ r2Key: objectKey, updatedAt: new Date() })
      .where(eq(files.id, file.id))
      .returning();

    const [session] = await tx
      .insert(uploadSessions)
      .values({
        fileId: updatedFile.id,
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        uploadType: multipart ? "multipart" : "single",
        objectKey,
        totalSizeBytes: input.sizeBytes,
        partSizeBytes,
        expectedChecksumSha256: input.checksumSha256 ?? null,
        expiresAt: input.expiresAt,
      })
      .returning();

    return { file: updatedFile, session, partSizeBytes, partCount };
  });

  let uploadId: string | null = null;
  if (multipart) {
    try {
      uploadId = await createMultipartUploadSession(created.file.r2Key, created.file.mimeType);
      try {
        await db
          .update(uploadSessions)
          .set({ r2UploadId: uploadId, updatedAt: new Date() })
          .where(eq(uploadSessions.id, created.session.id));
      } catch (error) {
        await abortMultipartUpload(created.file.r2Key, uploadId);
        throw error;
      }
    } catch (error) {
      await failAndReleaseReservation(created.session.id, input.userId, "R2_INIT_FAILED", error);
      throw error;
    }
  }

  return {
    sessionId: created.session.id,
    fileId: created.file.id,
    objectKey: created.file.r2Key,
    uploadType: created.session.uploadType,
    status: created.session.status,
    totalSizeBytes: created.session.totalSizeBytes,
    partSizeBytes: created.partSizeBytes,
    partCount: created.partCount,
    uploadId,
    uploadUrl: multipart
      ? null
      : await getPresignedUploadUrl(created.file.r2Key, created.file.mimeType, input.sizeBytes),
  };
}

export async function initUpload(input: UploadInitInput): Promise<UploadInitResult> {
  const [existingSession] = await db
    .select()
    .from(uploadSessions)
    .where(and(eq(uploadSessions.userId, input.userId), eq(uploadSessions.idempotencyKey, input.idempotencyKey)))
    .limit(1);

  if (!existingSession) {
    try {
      return await reserveAndCreate(input);
    } catch (error) {
      const pg = error as { code?: string; constraint?: string };
      if (pg.code !== "23505" || pg.constraint !== "upload_sessions_user_idempotency_unique") {
        throw error;
      }
      // A concurrent retry won the unique-key race. Read and return its
      // existing session instead of creating a duplicate file.
    }
  }

  const [session] = existingSession
    ? [existingSession]
    : await db
        .select()
        .from(uploadSessions)
        .where(and(eq(uploadSessions.userId, input.userId), eq(uploadSessions.idempotencyKey, input.idempotencyKey)))
        .limit(1);
  if (!session) throw new UploadServiceError("UPLOAD_NOT_FOUND", "Upload session not found", 404);

  const [file] = await db.select().from(files).where(eq(files.id, session.fileId)).limit(1);
  if (!file) throw new UploadServiceError("UPLOAD_NOT_FOUND", "Upload file not found", 404);
  assertSameInit(session, input, file);

  if (session.status === "expired" || session.status === "cancelled") {
    throw new UploadServiceError("UPLOAD_NOT_RESUMABLE", "This upload session cannot be resumed", 409);
  }

  let uploadId = session.r2UploadId;
  if (session.uploadType === "multipart" && !uploadId) {
    uploadId = await createMultipartUploadSession(file.r2Key, file.mimeType);
    await db
      .update(uploadSessions)
      .set({ r2UploadId: uploadId, updatedAt: new Date() })
      .where(eq(uploadSessions.id, session.id));
  }

  const partSizeBytes = session.partSizeBytes;
  return {
    sessionId: session.id,
    fileId: file.id,
    objectKey: file.r2Key,
    uploadType: session.uploadType,
    status: session.status,
    totalSizeBytes: session.totalSizeBytes,
    partSizeBytes,
    partCount: partSizeBytes
      ? calculateMultipartPartCount(session.totalSizeBytes, partSizeBytes)
      : 1,
    uploadId,
    uploadUrl:
      session.uploadType === "single"
        ? await getPresignedUploadUrl(file.r2Key, file.mimeType, file.sizeBytes)
        : null,
  };
}

async function getLockedSession(sessionId: string, userId: string, tx: typeof db) {
  const [session] = await tx
    .select()
    .from(uploadSessions)
    .where(and(eq(uploadSessions.id, sessionId), eq(uploadSessions.userId, userId)))
    .limit(1)
    .for("update");
  if (!session) throw new UploadServiceError("UPLOAD_NOT_FOUND", "Upload session not found", 404);

  const [file] = await tx.select().from(files).where(eq(files.id, session.fileId)).limit(1).for("update");
  if (!file) throw new UploadServiceError("UPLOAD_NOT_FOUND", "Upload file not found", 404);
  return { session, file };
}

async function beginUpload(sessionId: string, userId: string) {
  return db.transaction(async (tx) => {
    const { session, file } = await getLockedSession(sessionId, userId, tx);
    if (session.expiresAt <= new Date()) {
      throw new UploadServiceError("UPLOAD_EXPIRED", "Upload session expired", 410);
    }
    if (session.status === "completed" && file.status === "ready") return { session, file };
    if (session.status === "failed") {
      assertUploadSessionTransition(session.status, "uploading");
      assertFileUploadTransition(file.status, "uploading");
      if (session.reservationReleased) {
        const [reserved] = await tx
          .update(users)
          .set({ reservedBytes: sql`${users.reservedBytes} + ${session.totalSizeBytes}` })
          .where(
            and(
              eq(users.id, userId),
              sql`${users.usedBytes} + ${users.reservedBytes} + ${session.totalSizeBytes} <= ${users.quotaBytes}`
            )
          )
          .returning({ id: users.id });
        if (!reserved) throw new UploadServiceError("QUOTA_EXCEEDED", "Storage quota exceeded", 400);
        await tx.update(uploadSessions).set({ reservationReleased: false, updatedAt: new Date() }).where(eq(uploadSessions.id, session.id));
      }
      await tx.update(uploadSessions).set({ status: "uploading", retryCount: sql`${uploadSessions.retryCount} + 1`, updatedAt: new Date() }).where(eq(uploadSessions.id, session.id));
      await tx.update(files).set({ status: "uploading", failureCode: null, failureMessage: null, updatedAt: new Date() }).where(eq(files.id, file.id));
      return { session: { ...session, status: "uploading" as const }, file: { ...file, status: "uploading" as const } };
    }
    if (session.status === "created") {
      assertUploadSessionTransition(session.status, "uploading");
      if (file.status === "created") assertFileUploadTransition(file.status, "uploading");
      await tx.update(uploadSessions).set({ status: "uploading", startedAt: session.startedAt ?? new Date(), updatedAt: new Date() }).where(eq(uploadSessions.id, session.id));
      if (file.status === "created") await tx.update(files).set({ status: "uploading", updatedAt: new Date() }).where(eq(files.id, file.id));
      return { session: { ...session, status: "uploading" as const }, file: { ...file, status: "uploading" as const } };
    }
    if (session.status !== "uploading" && session.status !== "verifying") {
      throw new UploadServiceError("UPLOAD_STATE_INVALID", `Upload session is ${session.status}`, 409);
    }
    return { session, file };
  });
}

export async function signMultipartParts(
  sessionId: string,
  userId: string,
  requestedParts: number[]
): Promise<{ partNumber: number; sizeBytes: number; url: string }[]> {
  const started = await beginUpload(sessionId, userId);
  if (started.session.uploadType !== "multipart" || !started.session.r2UploadId || !started.session.partSizeBytes) {
    throw new UploadServiceError("NOT_MULTIPART", "This upload does not use multipart upload", 400);
  }

  const partCount = calculateMultipartPartCount(started.session.totalSizeBytes, started.session.partSizeBytes);
  const uniqueParts = [...new Set(requestedParts)];
  if (uniqueParts.length === 0 || uniqueParts.some((part) => part < 1 || part > partCount)) {
    throw new UploadServiceError("INVALID_PARTS", "Requested part number is invalid", 400);
  }

  const existing = await db
    .select({ partNumber: uploadParts.partNumber })
    .from(uploadParts)
    .where(and(eq(uploadParts.uploadSessionId, sessionId), inArray(uploadParts.partNumber, uniqueParts)));
  const known = new Set(existing.map((part) => part.partNumber));
  const missing = uniqueParts.filter((part) => !known.has(part));
  if (missing.length > 0) {
    await db.insert(uploadParts).values(missing.map((partNumber) => ({
      uploadSessionId: sessionId,
      partNumber,
      sizeBytes: Math.min(started.session.partSizeBytes!, started.session.totalSizeBytes - (partNumber - 1) * started.session.partSizeBytes!),
    })));
  }

  return Promise.all(uniqueParts.map(async (partNumber) => ({
    partNumber,
    sizeBytes: Math.min(started.session.partSizeBytes!, started.session.totalSizeBytes - (partNumber - 1) * started.session.partSizeBytes!),
    url: await getPresignedMultipartPartUrl(started.file.r2Key, started.session.r2UploadId!, partNumber),
  })));
}

export async function commitUploadedPart(
  sessionId: string,
  userId: string,
  partNumber: number,
  etag: string,
  checksumSha256?: string
) {
  if (!etag || etag.length > 512) throw new UploadServiceError("INVALID_PART", "Part ETag is invalid", 400);
  return db.transaction(async (tx) => {
    const { session } = await getLockedSession(sessionId, userId, tx);
    if (session.uploadType !== "multipart") throw new UploadServiceError("NOT_MULTIPART", "This upload does not use multipart upload", 400);
    if (session.status === "completed") return { partNumber, status: "uploaded" as const };
    if (session.status !== "uploading" && session.status !== "created") throw new UploadServiceError("UPLOAD_STATE_INVALID", `Upload session is ${session.status}`, 409);
    const [part] = await tx.select().from(uploadParts).where(and(eq(uploadParts.uploadSessionId, sessionId), eq(uploadParts.partNumber, partNumber))).limit(1).for("update");
    if (!part) throw new UploadServiceError("PART_NOT_SIGNED", "Part was not issued by this upload session", 400);
    await tx.update(uploadParts).set({ etag, checksumSha256: checksumSha256 ?? null, status: "uploaded", attempts: sql`${uploadParts.attempts} + 1`, uploadedAt: new Date(), updatedAt: new Date(), lastError: null }).where(eq(uploadParts.id, part.id));
    return { partNumber, status: "uploaded" as const };
  });
}

async function claimVerification(sessionId: string, userId: string) {
  return db.transaction(async (tx) => {
    const { session, file } = await getLockedSession(sessionId, userId, tx);
    if (session.status === "completed" && file.status === "ready") return "completed" as const;
    if (session.status === "verifying" || file.status === "verifying") return "in_progress" as const;
    if (session.status !== "uploading" && session.status !== "created") {
      throw new UploadServiceError("UPLOAD_STATE_INVALID", `Upload session is ${session.status}`, 409);
    }
    if (file.status !== "uploading" && file.status !== "created") {
      throw new UploadServiceError("UPLOAD_STATE_INVALID", `File is ${file.status}`, 409);
    }
    if (session.status === "created") assertUploadSessionTransition("created", "uploading");
    assertUploadSessionTransition("uploading", "verifying");
    if (file.status === "created") assertFileUploadTransition("created", "uploading");
    assertFileUploadTransition("uploading", "verifying");
    await tx.update(uploadSessions).set({ status: "verifying", startedAt: session.startedAt ?? new Date(), updatedAt: new Date() }).where(eq(uploadSessions.id, session.id));
    await tx.update(files).set({ status: "verifying", updatedAt: new Date() }).where(eq(files.id, file.id));
    return "claimed" as const;
  });
}

async function markVerificationFailed(sessionId: string, userId: string, code: string, error: unknown) {
  const message = error instanceof Error ? error.message : "Upload verification failed";
  await db.transaction(async (tx) => {
    const { session, file } = await getLockedSession(sessionId, userId, tx);
    if (session.status === "completed" || file.status === "ready") return;
    if (session.status === "verifying") assertUploadSessionTransition("verifying", "failed");
    if (file.status === "verifying") assertFileUploadTransition("verifying", "failed");
    await tx.update(uploadSessions).set({ status: "failed", failureCode: code, failureMessage: message, updatedAt: new Date() }).where(eq(uploadSessions.id, session.id));
    await tx.update(files).set({ status: "failed", failureCode: code, failureMessage: message, updatedAt: new Date() }).where(eq(files.id, file.id));
  });
}

export async function completeUpload(
  sessionId: string,
  userId: string,
  parts: UploadPartInput[] = [],
  checksumSha256?: string
): Promise<{ sessionId: string; fileId: string; name: string; status: "ready" }> {
  const started = await beginUpload(sessionId, userId);
  if (started.session.status === "completed" && started.file.status === "ready") {
    return { sessionId, fileId: started.file.id, name: started.file.name, status: "ready" };
  }

  const claim = await claimVerification(sessionId, userId);
  if (claim === "completed") {
    const current = await getUpload(sessionId, userId);
    return { sessionId, fileId: current.fileId, name: current.name, status: "ready" };
  }
  if (claim === "in_progress") {
    throw new UploadServiceError("FINALIZATION_IN_PROGRESS", "Upload finalization is already in progress", 409);
  }

  try {
    if (started.session.uploadType === "multipart") {
      if (!started.session.r2UploadId || !started.session.partSizeBytes) {
        throw new UploadServiceError("MULTIPART_NOT_INITIALIZED", "Multipart upload is not initialized", 409);
      }
      const partCount = calculateMultipartPartCount(started.session.totalSizeBytes, started.session.partSizeBytes);
      const expectedParts = new Set(Array.from({ length: partCount }, (_, index) => index + 1));
      const unique = new Map(parts.map((part) => [part.partNumber, part]));
      if (unique.size !== partCount || [...expectedParts].some((part) => !unique.has(part))) {
        throw new UploadServiceError("INCOMPLETE_PARTS", "All multipart parts are required", 400);
      }
      const signedParts = await db
        .select({ partNumber: uploadParts.partNumber })
        .from(uploadParts)
        .where(and(eq(uploadParts.uploadSessionId, sessionId), inArray(uploadParts.partNumber, [...unique.keys()])));
      if (signedParts.length !== unique.size) {
        throw new UploadServiceError("PART_NOT_SIGNED", "One or more parts were not issued by this upload session", 400);
      }
      await db.transaction(async (tx) => {
        for (const part of unique.values()) {
          const expectedSize = Math.min(started.session.partSizeBytes!, started.session.totalSizeBytes - (part.partNumber - 1) * started.session.partSizeBytes!);
          if (part.etag.length > 512 || expectedSize <= 0) throw new UploadServiceError("INVALID_PART", "Invalid multipart part", 400);
          await tx.insert(uploadParts).values({ uploadSessionId: sessionId, partNumber: part.partNumber, sizeBytes: expectedSize, etag: part.etag, checksumSha256: part.checksumSha256 ?? null, status: "uploaded", attempts: 1, uploadedAt: new Date() }).onConflictDoUpdate({
            target: [uploadParts.uploadSessionId, uploadParts.partNumber],
            set: { etag: part.etag, checksumSha256: part.checksumSha256 ?? null, status: "uploaded", attempts: sql`${uploadParts.attempts} + 1`, uploadedAt: new Date(), updatedAt: new Date(), lastError: null },
          });
        }
      });
      await completeMultipartUpload(started.file.r2Key, started.session.r2UploadId, [...unique.values()]);
    }

    const head = await headObject(started.file.r2Key);
    if (head.contentLength !== started.session.totalSizeBytes) {
      throw new UploadServiceError("SIZE_MISMATCH", "Stored object size does not match upload size", 422);
    }
    const expectedChecksum = checksumSha256 ?? started.session.expectedChecksumSha256;
    if (expectedChecksum && head.checksumSha256 && expectedChecksum !== head.checksumSha256) {
      throw new UploadServiceError("CHECKSUM_MISMATCH", "Stored object checksum does not match", 422);
    }

    return await db.transaction(async (tx) => {
      const { session, file } = await getLockedSession(sessionId, userId, tx);
      if (session.status === "completed" && file.status === "ready") {
        return { sessionId, fileId: file.id, name: file.name, status: "ready" as const };
      }
      assertUploadSessionTransition(session.status, "completed");
      assertFileUploadTransition(file.status, "ready");
      const now = new Date();
      await tx.update(files).set({ status: "ready", checksumSha256: expectedChecksum ?? file.checksumSha256, completedAt: now, verifiedAt: now, failureCode: null, failureMessage: null, updatedAt: now }).where(eq(files.id, file.id));
      await tx.update(uploadSessions).set({ status: "completed", completedAt: now, updatedAt: now }).where(eq(uploadSessions.id, session.id));
      if (!session.reservationReleased) {
        await tx.update(users).set({ reservedBytes: sql`GREATEST(0, ${users.reservedBytes} - ${session.totalSizeBytes})`, usedBytes: sql`${users.usedBytes} + ${session.totalSizeBytes}` }).where(eq(users.id, userId));
        await tx.update(uploadSessions).set({ reservationReleased: true, updatedAt: now }).where(eq(uploadSessions.id, session.id));
      }
      return { sessionId, fileId: file.id, name: file.name, status: "ready" as const };
    });
  } catch (error) {
    await markVerificationFailed(sessionId, userId, error instanceof UploadServiceError ? error.code : "FINALIZATION_FAILED", error);
    throw error;
  }
}

export async function abortUpload(sessionId: string, userId: string): Promise<{ cancelled: boolean; fileId: string }> {
  const current = await getUpload(sessionId, userId);
  if (current.status === "completed" || current.fileStatus === "ready") {
    return { cancelled: false, fileId: current.fileId };
  }
  if (current.uploadType === "multipart" && current.uploadId) {
    await abortMultipartUpload(current.objectKey, current.uploadId);
  } else {
    await deleteR2Object(current.objectKey);
  }
  await db.transaction(async (tx) => {
    const { session, file } = await getLockedSession(sessionId, userId, tx);
    if (session.status === "completed" || file.status === "ready") return;
    const sessionNextStatus = session.status === "verifying" ? "failed" : "cancelled";
    const fileNextStatus = file.status === "verifying" ? "failed" : "cancelled";
    if (session.status !== sessionNextStatus) assertUploadSessionTransition(session.status, sessionNextStatus);
    if (file.status !== fileNextStatus) assertFileUploadTransition(file.status, fileNextStatus);
    await tx.update(uploadSessions).set({ status: sessionNextStatus, failureCode: sessionNextStatus === "failed" ? "CANCELLED_DURING_VERIFY" : "CANCELLED", failureMessage: "Upload cancelled", reservationReleased: true, updatedAt: new Date() }).where(eq(uploadSessions.id, session.id));
    await tx.update(files).set({ status: fileNextStatus, failureCode: "CANCELLED", failureMessage: "Upload cancelled", updatedAt: new Date() }).where(eq(files.id, file.id));
    if (!session.reservationReleased) await tx.update(users).set({ reservedBytes: sql`GREATEST(0, ${users.reservedBytes} - ${session.totalSizeBytes})` }).where(eq(users.id, userId));
  });
  return { cancelled: true, fileId: current.fileId };
}

export async function retryUpload(sessionId: string, userId: string): Promise<UploadInitResult> {
  const current = await getUpload(sessionId, userId);
  if (current.status !== "failed" || current.fileStatus !== "failed") {
    throw new UploadServiceError("UPLOAD_NOT_RETRYABLE", "Upload is not in a retryable state", 409);
  }
  await beginUpload(sessionId, userId);
  const result = await getUpload(sessionId, userId);
  return {
    sessionId,
    fileId: result.fileId,
    objectKey: result.objectKey,
    uploadType: result.uploadType,
    status: "uploading",
    totalSizeBytes: result.totalSizeBytes,
    partSizeBytes: result.partSizeBytes,
    partCount: result.partSizeBytes ? calculateMultipartPartCount(result.totalSizeBytes, result.partSizeBytes) : 1,
    uploadId: result.uploadId,
    uploadUrl: result.uploadType === "single" ? await getPresignedUploadUrl(result.objectKey, result.mimeType, result.totalSizeBytes) : null,
  };
}

export async function getUpload(sessionId: string, userId: string) {
  const [session] = await db.select().from(uploadSessions).where(and(eq(uploadSessions.id, sessionId), eq(uploadSessions.userId, userId))).limit(1);
  if (!session) throw new UploadServiceError("UPLOAD_NOT_FOUND", "Upload session not found", 404);
  const [file] = await db.select().from(files).where(eq(files.id, session.fileId)).limit(1);
  if (!file) throw new UploadServiceError("UPLOAD_NOT_FOUND", "Upload file not found", 404);
  const persistedParts = await db
    .select({
      partNumber: uploadParts.partNumber,
      sizeBytes: uploadParts.sizeBytes,
      etag: uploadParts.etag,
      status: uploadParts.status,
      attempts: uploadParts.attempts,
    })
    .from(uploadParts)
    .where(eq(uploadParts.uploadSessionId, session.id));
  return { sessionId: session.id, fileId: file.id, name: file.name, mimeType: file.mimeType, objectKey: file.r2Key, status: session.status, fileStatus: file.status, uploadType: session.uploadType, uploadId: session.r2UploadId, totalSizeBytes: session.totalSizeBytes, partSizeBytes: session.partSizeBytes, retryCount: session.retryCount, failureCode: session.failureCode ?? file.failureCode, failureMessage: session.failureMessage ?? file.failureMessage, expiresAt: session.expiresAt, parts: persistedParts };
}

export async function getActiveUploads(userId: string) {
  const rows = await db.select({ session: uploadSessions, file: files }).from(uploadSessions).innerJoin(files, eq(files.id, uploadSessions.fileId)).where(and(eq(uploadSessions.userId, userId), inArray(uploadSessions.status, ["created", "uploading", "verifying", "failed"]), gt(uploadSessions.expiresAt, new Date()))).orderBy(uploadSessions.createdAt);
  return Promise.all(rows.map(async ({ session, file }) => ({
    sessionId: session.id,
    fileId: file.id,
    name: file.name,
    mimeType: file.mimeType,
    status: session.status,
    fileStatus: file.status,
    uploadType: session.uploadType,
    uploadId: session.r2UploadId,
    totalSizeBytes: session.totalSizeBytes,
    partSizeBytes: session.partSizeBytes,
    retryCount: session.retryCount,
    failureCode: session.failureCode ?? file.failureCode,
    failureMessage: session.failureMessage ?? file.failureMessage,
    expiresAt: session.expiresAt,
    parts: await db.select({ partNumber: uploadParts.partNumber, sizeBytes: uploadParts.sizeBytes, etag: uploadParts.etag, status: uploadParts.status, attempts: uploadParts.attempts }).from(uploadParts).where(eq(uploadParts.uploadSessionId, session.id)),
  })));
}

async function failAndReleaseReservation(sessionId: string, userId: string, code: string, error: unknown) {
  const message = error instanceof Error ? error.message : "Upload initialization failed";
  await db.transaction(async (tx) => {
    const { session, file } = await getLockedSession(sessionId, userId, tx);
    if (session.reservationReleased) return;
    if (session.status !== "failed") assertUploadSessionTransition(session.status, "failed");
    if (file.status !== "failed") {
      if (file.status === "created" || file.status === "uploading" || file.status === "verifying") assertFileUploadTransition(file.status, "failed");
      else return;
    }
    const now = new Date();
    await tx.update(uploadSessions).set({ status: "failed", failureCode: code, failureMessage: message, reservationReleased: true, updatedAt: now }).where(eq(uploadSessions.id, session.id));
    await tx.update(files).set({ status: "failed", failureCode: code, failureMessage: message, updatedAt: now }).where(eq(files.id, file.id));
    await tx.update(users).set({ reservedBytes: sql`GREATEST(0, ${users.reservedBytes} - ${session.totalSizeBytes})` }).where(eq(users.id, userId));
  });
}
