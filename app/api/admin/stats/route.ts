import { NextRequest } from "next/server";
import { eq, desc, count, sum, and, isNull, gte, sql } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { users, files, folders, activityLogs, shares, sessions } from "@/shared/infrastructure/db/schema";
import { requireMasterOrApiKey } from "@/shared/lib/auth/api-key";
import { apiSuccess, handleApiError } from "@/shared/api/response";
import { getRedis } from "@/shared/infrastructure/cache/redis";

export async function GET(request: NextRequest) {
  try {
    await requireMasterOrApiKey(request, "stats");

    // User stats
    const [userCount] = await db.select({ total: count() }).from(users);
    const [activeUsers] = await db
      .select({ total: count() })
      .from(users)
      .where(eq(users.status, "active"));
    const [suspendedUsers] = await db
      .select({ total: count() })
      .from(users)
      .where(eq(users.status, "suspended"));

    // File stats
    const [fileCount] = await db
      .select({ total: count() })
      .from(files)
      .where(isNull(files.deletedAt));
    const [noteCount] = await db
      .select({ total: count() })
      .from(files)
      .where(and(isNull(files.deletedAt), eq(files.isNote, true)));

    // Storage stats
    const [totalStorage] = await db
      .select({ total: sum(files.sizeBytes) })
      .from(files)
      .where(isNull(files.deletedAt));
    const [totalQuota] = await db
      .select({ total: sum(users.quotaBytes) })
      .from(users);

    // Folder stats
    const [folderCount] = await db
      .select({ total: count() })
      .from(folders)
      .where(isNull(folders.deletedAt));

    // Share stats
    const [shareCount] = await db.select({ total: count() }).from(shares);

    // Activity stats (7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [loginCount] = await db
      .select({ count: count() })
      .from(activityLogs)
      .where(and(eq(activityLogs.action, "login"), gte(activityLogs.createdAt, sevenDaysAgo)));
    const [uploadCount] = await db
      .select({ count: count() })
      .from(activityLogs)
      .where(and(eq(activityLogs.action, "upload"), gte(activityLogs.createdAt, sevenDaysAgo)));
    const [downloadCount] = await db
      .select({ count: count() })
      .from(activityLogs)
      .where(and(eq(activityLogs.action, "download"), gte(activityLogs.createdAt, sevenDaysAgo)));

    // Active sessions
    const [activeSessions] = await db
      .select({ total: count() })
      .from(sessions)
      .where(gte(sessions.expiresAt, new Date()));

    // Top users by storage
    const topUsers = await db
      .select({
        id: users.id,
        username: users.username,
        usedBytes: users.usedBytes,
        quotaBytes: users.quotaBytes,
        fileCount: count(files.id),
      })
      .from(users)
      .leftJoin(files, and(eq(users.id, files.userId), isNull(files.deletedAt)))
      .groupBy(users.id, users.username, users.usedBytes, users.quotaBytes)
      .orderBy(desc(users.usedBytes))
      .limit(5);

    // Recent activity
    const recentActivity = await db
      .select()
      .from(activityLogs)
      .orderBy(desc(activityLogs.createdAt))
      .limit(10);

    // Activity by type (7 days)
    const activityByType = await db
      .select({
        action: activityLogs.action,
        count: count(),
      })
      .from(activityLogs)
      .where(gte(activityLogs.createdAt, sevenDaysAgo))
      .groupBy(activityLogs.action)
      .orderBy(desc(count()));

    // Storage growth (30 days) — daily upload volume from activity logs
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const growthRaw = await db
      .select({
        day: sql<string>`to_char(${activityLogs.createdAt}, 'YYYY-MM-DD')`,
        uploads: count(),
        bytes: sql<number>`coalesce(sum((${activityLogs.metadata}->>'size')::bigint), 0)`,
      })
      .from(activityLogs)
      .where(and(eq(activityLogs.action, "upload"), gte(activityLogs.createdAt, thirtyDaysAgo)))
      .groupBy(sql`to_char(${activityLogs.createdAt}, 'YYYY-MM-DD')`)
      .orderBy(sql`to_char(${activityLogs.createdAt}, 'YYYY-MM-DD')`);

    // Fill missing days with zeros
    const growthMap = new Map(growthRaw.map((r) => [r.day, { uploads: Number(r.uploads), bytes: Number(r.bytes) }]));
    const storageGrowth: Array<{ day: string; uploads: number; bytes: number }> = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      storageGrowth.push({ day: key, ...(growthMap.get(key) ?? { uploads: 0, bytes: 0 }) });
    }

    // Storage by MIME (top categories)
    const byMimeRaw = await db
      .select({
        mimeType: files.mimeType,
        count: count(),
        bytes: sum(files.sizeBytes),
      })
      .from(files)
      .where(isNull(files.deletedAt))
      .groupBy(files.mimeType)
      .orderBy(desc(sum(files.sizeBytes)))
      .limit(15);

    const byMime = byMimeRaw.map((r) => {
      const mime = r.mimeType || "unknown";
      const category = mime.startsWith("image/")
        ? "Images"
        : mime.startsWith("video/")
          ? "Videos"
          : mime.startsWith("audio/")
            ? "Audio"
            : mime.includes("pdf") || mime.includes("document") || mime.includes("text")
              ? "Documents"
              : mime.includes("zip") || mime.includes("archive") || mime.includes("compressed")
                ? "Archives"
                : "Other";
      return {
        mimeType: mime,
        category,
        count: Number(r.count),
        bytes: Number(r.bytes ?? 0),
      };
    });

    // Aggregate by category for charts
    const byCategoryMap = new Map<string, { count: number; bytes: number }>();
    for (const row of byMime) {
      const prev = byCategoryMap.get(row.category) ?? { count: 0, bytes: 0 };
      byCategoryMap.set(row.category, {
        count: prev.count + row.count,
        bytes: prev.bytes + row.bytes,
      });
    }
    const byCategory = Array.from(byCategoryMap.entries()).map(([category, v]) => ({
      category,
      ...v,
    }));

    // ── System health ──────────────────────────────────────────────────────
    // The DB is reachable (every query above just succeeded). Probe Redis with a
    // bounded PING so a dead cache is reported rather than hanging the request.
    let redisStatus: "connected" | "disabled" | "down" = "disabled";
    if (process.env.REDIS_DISABLED !== "true") {
      const client = getRedis();
      if (client) {
        try {
          const pong = await Promise.race([
            (async () => {
              if (client.status !== "ready") await client.connect();
              return client.ping();
            })(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
          ]);
          redisStatus = pong === "PONG" ? "connected" : "down";
        } catch {
          redisStatus = "down";
        }
      } else {
        redisStatus = "down";
      }
    }

    const mem = process.memoryUsage();
    const system = {
      database: "connected" as const,
      redis: redisStatus,
      uptimeSeconds: Math.floor(process.uptime()),
      nodeVersion: process.version,
      memoryUsedMB: Math.round(mem.rss / 1024 / 1024),
      memoryHeapMB: Math.round(mem.heapUsed / 1024 / 1024),
      env: process.env.NODE_ENV ?? "development",
    };

    return apiSuccess({
      users: {
        total: userCount.total,
        active: activeUsers.total,
        suspended: suspendedUsers.total,
      },
      files: {
        total: fileCount.total,
        notes: noteCount.total,
      },
      storage: {
        used: totalStorage.total ?? 0,
        quota: totalQuota.total ?? 0,
      },
      folders: folderCount.total,
      shares: shareCount.total,
      activity: {
        logins: loginCount.count,
        uploads: uploadCount.count,
        downloads: downloadCount.count,
        byType: activityByType,
      },
      sessions: activeSessions.total,
      topUsers,
      recentActivity,
      storageGrowth,
      byMime,
      byCategory,
      system,
    });
  } catch (error) {
    return handleApiError(error);
  }
}