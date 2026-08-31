/**
 * Production health monitoring daemon with alerting.
 *
 * Runs periodic health checks and sends alerts via multiple channels when issues
 * are detected. Designed to run as a background process or cron job.
 *
 * Usage:
 *   npm run monitor:health           # one-shot check
 *   npm run monitor:health -- --loop # continuous monitoring
 */

import { db } from "@/shared/infrastructure/db";
import { eq, and, sql, count } from "drizzle-orm";
import { brains, memories, mailSenders } from "@/shared/infrastructure/db/schema";
import { getRedis } from "@/shared/infrastructure/cache/redis";

export type HealthStatus = "healthy" | "degraded" | "critical";

export type HealthCheckResult = {
  name: string;
  status: HealthStatus;
  message: string;
  details?: Record<string, unknown>;
  timestamp: Date;
};

export type HealthReport = {
  overall: HealthStatus;
  checks: HealthCheckResult[];
  timestamp: Date;
};

/**
 * Database connectivity and basic query performance.
 */
export async function checkDatabase(): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    await db.execute(sql`SELECT 1 as ok`);
    const latency = Date.now() - start;

    if (latency > 5000) {
      return {
        name: "database",
        status: "degraded",
        message: `Database responding slowly (${latency}ms)`,
        details: { latency },
        timestamp: new Date(),
      };
    }

    return {
      name: "database",
      status: "healthy",
      message: `Connected (${latency}ms)`,
      details: { latency },
      timestamp: new Date(),
    };
  } catch (error) {
    return {
      name: "database",
      status: "critical",
      message: `Database connection failed: ${error instanceof Error ? error.message : String(error)}`,
      timestamp: new Date(),
    };
  }
}

/**
 * Redis connectivity (if not disabled).
 *
 * Uses the app's shared ioredis client so this check exercises the same
 * connection the rest of the platform relies on. The client is a singleton —
 * never disconnect it here.
 */
export async function checkRedis(): Promise<HealthCheckResult> {
  if (process.env.REDIS_DISABLED === "true") {
    return {
      name: "redis",
      status: "healthy",
      message: "Redis disabled (in-memory mode)",
      timestamp: new Date(),
    };
  }

  const client = getRedis();
  if (!client) {
    return {
      name: "redis",
      status: "critical",
      message: "Redis client unavailable (connection previously failed)",
      timestamp: new Date(),
    };
  }

  try {
    if (client.status !== "ready") {
      await client.connect();
    }

    const start = Date.now();
    await client.ping();
    const latency = Date.now() - start;

    if (latency > 1000) {
      return {
        name: "redis",
        status: "degraded",
        message: `Redis responding slowly (${latency}ms)`,
        details: { latency },
        timestamp: new Date(),
      };
    }

    return {
      name: "redis",
      status: "healthy",
      message: `Connected (${latency}ms)`,
      details: { latency },
      timestamp: new Date(),
    };
  } catch (error) {
    return {
      name: "redis",
      status: "critical",
      message: `Redis connection failed: ${error instanceof Error ? error.message : String(error)}`,
      timestamp: new Date(),
    };
  }
}

/**
 * R2 storage availability.
 */
export async function checkStorage(): Promise<HealthCheckResult> {
  try {
    const { S3Client, HeadBucketCommand } = await import("@aws-sdk/client-s3");

    const client = new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
      },
    });

    const start = Date.now();
    await client.send(new HeadBucketCommand({ Bucket: process.env.R2_BUCKET_NAME ?? "" }));
    const latency = Date.now() - start;

    return {
      name: "storage",
      status: "healthy",
      message: `R2 accessible (${latency}ms)`,
      details: { latency },
      timestamp: new Date(),
    };
  } catch (error) {
    return {
      name: "storage",
      status: "critical",
      message: `R2 storage unavailable: ${error instanceof Error ? error.message : String(error)}`,
      timestamp: new Date(),
    };
  }
}

/**
 * Email delivery readiness (verified senders).
 */
export async function checkEmail(): Promise<HealthCheckResult> {
  try {
    const [result] = await db
      .select({ count: count() })
      .from(mailSenders)
      .where(and(eq(mailSenders.isActive, true), eq(mailSenders.status, "ok")));

    const senderCount = result?.count ?? 0;

    if (senderCount === 0) {
      return {
        name: "email",
        status: "degraded",
        message: "No verified email senders configured",
        details: { senderCount: 0 },
        timestamp: new Date(),
      };
    }

    return {
      name: "email",
      status: "healthy",
      message: `${senderCount} verified sender(s) ready`,
      details: { senderCount },
      timestamp: new Date(),
    };
  } catch (error) {
    return {
      name: "email",
      status: "degraded",
      message: `Email check failed: ${error instanceof Error ? error.message : String(error)}`,
      timestamp: new Date(),
    };
  }
}

/**
 * Brain health: orphan count, avg links, stale memories.
 */
export async function checkBrainHealth(): Promise<HealthCheckResult> {
  try {
    const [brainsResult] = await db.select({ count: count() }).from(brains);
    const brainCount = brainsResult?.count ?? 0;

    if (brainCount === 0) {
      return {
        name: "brain_health",
        status: "healthy",
        message: "No brains yet",
        details: { brainCount: 0 },
        timestamp: new Date(),
      };
    }

    // Count stale memories (>180 days)
    const staleThreshold = new Date();
    staleThreshold.setDate(staleThreshold.getDate() - 180);

    const [staleResult] = await db
      .select({ count: count() })
      .from(memories)
      .where(
        and(
          sql`${memories.lastAccessedAt} < ${staleThreshold}`,
          eq(memories.validityState, "active")
        )
      );

    const staleCount = staleResult?.count ?? 0;
    const [totalResult] = await db.select({ count: count() }).from(memories);
    const totalMemories = totalResult?.count ?? 0;

    if (totalMemories > 0 && staleCount / totalMemories > 0.5) {
      return {
        name: "brain_health",
        status: "degraded",
        message: `${Math.round((staleCount / totalMemories) * 100)}% of memories are stale (>180 days)`,
        details: { staleCount, totalMemories, brainCount },
        timestamp: new Date(),
      };
    }

    return {
      name: "brain_health",
      status: "healthy",
      message: `${brainCount} brain(s), ${totalMemories} memories, ${staleCount} stale`,
      details: { brainCount, totalMemories, staleCount },
      timestamp: new Date(),
    };
  } catch (error) {
    return {
      name: "brain_health",
      status: "degraded",
      message: `Brain health check failed: ${error instanceof Error ? error.message : String(error)}`,
      timestamp: new Date(),
    };
  }
}

/**
 * System resource usage (if available).
 */
export async function checkSystemResources(): Promise<HealthCheckResult> {
  try {
    const { freemem, totalmem } = await import("os");
    const freeMemMB = Math.round(freemem() / 1024 / 1024);
    const totalMemMB = Math.round(totalmem() / 1024 / 1024);
    const usedPercent = Math.round(((totalMemMB - freeMemMB) / totalMemMB) * 100);

    if (usedPercent > 90) {
      return {
        name: "resources",
        status: "critical",
        message: `Memory usage at ${usedPercent}% (${freeMemMB}MB free of ${totalMemMB}MB)`,
        details: { freeMemMB, totalMemMB, usedPercent },
        timestamp: new Date(),
      };
    }

    if (usedPercent > 80) {
      return {
        name: "resources",
        status: "degraded",
        message: `Memory usage at ${usedPercent}% (${freeMemMB}MB free of ${totalMemMB}MB)`,
        details: { freeMemMB, totalMemMB, usedPercent },
        timestamp: new Date(),
      };
    }

    return {
      name: "resources",
      status: "healthy",
      message: `Memory at ${usedPercent}% (${freeMemMB}MB free of ${totalMemMB}MB)`,
      details: { freeMemMB, totalMemMB, usedPercent },
      timestamp: new Date(),
    };
  } catch {
    return {
      name: "resources",
      status: "healthy",
      message: "Resource check skipped",
      timestamp: new Date(),
    };
  }
}

/**
 * Run all health checks and aggregate results.
 */
export async function runHealthChecks(): Promise<HealthReport> {
  const checks = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkStorage(),
    checkEmail(),
    checkBrainHealth(),
    checkSystemResources(),
  ]);

  const criticalCount = checks.filter((c) => c.status === "critical").length;
  const degradedCount = checks.filter((c) => c.status === "degraded").length;

  let overall: HealthStatus = "healthy";
  if (criticalCount > 0) {
    overall = "critical";
  } else if (degradedCount > 0) {
    overall = "degraded";
  }

  return {
    overall,
    checks,
    timestamp: new Date(),
  };
}

/**
 * Alert channels for notifications.
 */
export interface AlertChannel {
  name: string;
  send(report: HealthReport): Promise<void>;
}

/**
 * Console logger (always enabled).
 */
export class ConsoleAlertChannel implements AlertChannel {
  name = "console";

  async send(report: HealthReport): Promise<void> {
    const icon = report.overall === "healthy" ? "✓" : report.overall === "degraded" ? "⚠" : "✗";
    console.log(`\n[Health] ${icon} Overall: ${report.overall.toUpperCase()}`);

    for (const check of report.checks) {
      const checkIcon = check.status === "healthy" ? "✓" : check.status === "degraded" ? "⚠" : "✗";
      console.log(`  ${checkIcon} ${check.name}: ${check.message}`);
    }
  }
}

/**
 * Webhook alert channel (generic HTTP POST).
 */
export class WebhookAlertChannel implements AlertChannel {
  name = "webhook";

  constructor(private url: string) {}

  async send(report: HealthReport): Promise<void> {
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: report.overall,
          timestamp: report.timestamp.toISOString(),
          checks: report.checks.map((c) => ({
            name: c.name,
            status: c.status,
            message: c.message,
            details: c.details,
          })),
        }),
      });

      if (!response.ok) {
        console.error(`[Webhook] Failed to send alert: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.error(`[Webhook] Error sending alert:`, error);
    }
  }
}

/**
 * File logger for persistent alert history.
 */
export class FileAlertChannel implements AlertChannel {
  name = "file";

  constructor(private logPath: string) {}

  async send(report: HealthReport): Promise<void> {
    try {
      const { appendFileSync } = await import("fs");
      const logLine = JSON.stringify({
        timestamp: report.timestamp.toISOString(),
        overall: report.overall,
        checks: report.checks.map((c) => ({
          name: c.name,
          status: c.status,
          message: c.message,
        })),
      }) + "\n";

      appendFileSync(this.logPath, logLine, "utf-8");
    } catch (error) {
      console.error(`[File] Error writing to ${this.logPath}:`, error);
    }
  }
}

/**
 * Monitoring service configuration.
 */
export interface MonitorConfig {
  interval: number; // seconds between checks
  alertChannels: AlertChannel[];
  alertOnDegraded: boolean;
  alertOnHealthy: boolean;
}

const DEFAULT_CONFIG: MonitorConfig = {
  interval: 300, // 5 minutes
  alertChannels: [new ConsoleAlertChannel()],
  alertOnDegraded: true,
  alertOnHealthy: false, // only alert on problems by default
};

/**
 * Main monitoring loop.
 */
export async function monitorHealth(config: Partial<MonitorConfig> = {}): Promise<void> {
  const cfg: MonitorConfig = { ...DEFAULT_CONFIG, ...config };

  console.log(`[Monitor] Starting health monitoring (interval: ${cfg.interval}s)`);
  console.log(`[Monitor] Alert channels: ${cfg.alertChannels.map((c) => c.name).join(", ")}`);

  let lastStatus: HealthStatus = "healthy";

  while (true) {
    try {
      const report = await runHealthChecks();

      // Alert logic: notify on status change, or always if configured
      const shouldAlert =
        report.overall !== lastStatus ||
        (report.overall === "critical") ||
        (report.overall === "degraded" && cfg.alertOnDegraded) ||
        (report.overall === "healthy" && cfg.alertOnHealthy);

      if (shouldAlert) {
        for (const channel of cfg.alertChannels) {
          await channel.send(report);
        }
      }

      lastStatus = report.overall;
    } catch (error) {
      console.error(`[Monitor] Health check error:`, error);
    }

    await new Promise((resolve) => setTimeout(resolve, cfg.interval * 1000));
  }
}
