import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { otpTokens, sessions, users } from "@/shared/infrastructure/db/schema";
import { cleanupExpiredSessions, cleanupExpiredOtpTokens } from "@/workers/cleanup";

/**
 * The hourly sweep now purges expired auth sessions and one-time passcodes.
 * These two rules used to have no owner at all, so the tables grew without
 * bound; this proves the purge deletes what is expired and spares what is live.
 *
 * Needs a live database — the whole point is what `DELETE ... WHERE expires_at <
 * now()` does against real Postgres, including that postgres-js reports the
 * affected-row count on `.count` (a fake builder cannot prove that). Run with:
 *   DATABASE_URL=postgres://... npx vitest run tests/cleanup-purge.test.ts
 *
 * Unlike the brain suites, a purge is global by nature: running it clears every
 * already-expired session and passcode in the database, not only the rows this
 * test inserts. That is exactly the function's job and those rows are dead
 * (no reader ever returns an expired session or passcode), so it is safe. The
 * assertions therefore check presence/absence of this test's own rows and that
 * the reported count is positive, never an exact table-wide total.
 */

const DATABASE_AVAILABLE = Boolean(process.env.DATABASE_URL);

// A remote round-trip is slower than vitest's 5s default; a leaked timeout also
// bleeds queries into the next test. Give the whole file room, like the DB suite.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const past = () => new Date(Date.now() - 60_000);
const future = () => new Date(Date.now() + 60 * 60_000);

describe.skipIf(!DATABASE_AVAILABLE)("scheduled purge of expired sessions and passcodes", () => {
  let userId: string;
  // Unique markers so the test only ever asserts on rows it created.
  const otpTag = `cleanup-purge-${crypto.randomUUID()}@example.test`;

  beforeAll(async () => {
    const [user] = await db
      .insert(users)
      .values({
        username: `cleanup-purge-${crypto.randomUUID()}`,
        passwordHash: "integration-test-not-a-real-hash",
      })
      .returning();
    userId = user.id;
  });

  afterAll(async () => {
    // Deleting the user cascades its sessions; the passcodes carry no FK.
    await db.delete(otpTokens).where(eq(otpTokens.email, otpTag));
    if (userId) await db.delete(users).where(eq(users.id, userId));
  });

  it("deletes an expired session and keeps a live one", async () => {
    const expiredId = `sess-expired-${crypto.randomUUID()}`;
    const liveId = `sess-live-${crypto.randomUUID()}`;
    await db.insert(sessions).values([
      { id: expiredId, userId, expiresAt: past() },
      { id: liveId, userId, expiresAt: future() },
    ]);

    const { deleted } = await cleanupExpiredSessions(db);

    // At least our own expired row; the driver reports a real count, not 0.
    expect(deleted).toBeGreaterThanOrEqual(1);
    const remaining = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(inArray(sessions.id, [expiredId, liveId]));
    expect(remaining.map((r) => r.id)).toEqual([liveId]);
  });

  it("deletes an expired passcode and keeps a live one", async () => {
    await db.insert(otpTokens).values([
      { email: otpTag, code: "expired", expiresAt: past() },
      { email: otpTag, code: "live", expiresAt: future() },
    ]);

    const { deleted } = await cleanupExpiredOtpTokens(db);

    expect(deleted).toBeGreaterThanOrEqual(1);
    const remaining = await db
      .select({ code: otpTokens.code })
      .from(otpTokens)
      .where(eq(otpTokens.email, otpTag));
    expect(remaining.map((r) => r.code)).toEqual(["live"]);
  });
});
