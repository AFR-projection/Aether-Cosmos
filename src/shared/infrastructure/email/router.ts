import { db } from "@/shared/infrastructure/db";
import { mailSenders, type MailSender } from "@/shared/infrastructure/db/schema";
import { eq, sql } from "drizzle-orm";
import { getAdminSettings } from "@/shared/lib/settings/admin-settings";
import { recordEmailLog } from "./log";

/**
 * Smart sender router. Given the pool of Gmail senders, it decides — per send —
 * which sender is safe to use, then keeps per-sender accounting so the pool
 * self-balances and self-heals:
 *
 *   • Daily send cap — each sender has a rolling 24h budget (its own dailyLimit,
 *     or the global default). A sender that hit its cap is skipped until reset.
 *   • Cooldown — after N consecutive failures a sender is rested for a while, so
 *     one flaky/blocked account doesn't sink every send. A success clears it.
 *   • Least-recently-used rotation — among equally-eligible senders (same
 *     priority tier) the one used longest ago goes first, spreading volume.
 *
 * All accounting lives in the mail_senders row (see schema) so it survives
 * restarts and is shared across app instances.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type RouterConfig = {
  defaultDailyLimit: number;
  failureThreshold: number;
  cooldownMs: number;
};

export async function getRouterConfig(): Promise<RouterConfig> {
  const s = await getAdminSettings();
  return {
    defaultDailyLimit: s.emailDailyLimitPerSender,
    failureThreshold: s.emailFailureThreshold,
    cooldownMs: s.emailCooldownMinutes * 60 * 1000,
  };
}

/** Effective daily cap for a sender: its own override, or the global default. */
export function effectiveDailyLimit(sender: MailSender, cfg: RouterConfig): number {
  return sender.dailyLimit > 0 ? sender.dailyLimit : cfg.defaultDailyLimit;
}

/**
 * How many messages a sender has sent in the CURRENT day window. If the window
 * has rolled over (sentCountResetAt older than 24h, or unset), the effective
 * count is 0 — the persisted reset happens lazily in noteSuccess/noteFailure.
 */
export function currentDailyCount(sender: MailSender, now: number): number {
  const resetAt = sender.sentCountResetAt?.getTime();
  if (!resetAt || now - resetAt >= DAY_MS) return 0;
  return sender.dailySentCount;
}

export type Eligibility =
  | { eligible: true }
  | { eligible: false; reason: "inactive" | "errored" | "cooldown" | "daily_limit" };

/** Pure predicate: can this sender be used right now? */
export function checkEligibility(sender: MailSender, cfg: RouterConfig, now: number): Eligibility {
  if (!sender.isActive) return { eligible: false, reason: "inactive" };
  if (sender.status === "error") return { eligible: false, reason: "errored" };
  if (sender.cooldownUntil && sender.cooldownUntil.getTime() > now) {
    return { eligible: false, reason: "cooldown" };
  }
  if (currentDailyCount(sender, now) >= effectiveDailyLimit(sender, cfg)) {
    return { eligible: false, reason: "daily_limit" };
  }
  return { eligible: true };
}

/**
 * Order the eligible senders best-first: lower priority number wins (matches the
 * rest of the app's priority convention), then least-recently-used, then oldest
 * created for a stable tiebreak. Ineligible senders are dropped.
 */
export function selectSenders(
  senders: MailSender[],
  cfg: RouterConfig,
  now: number
): MailSender[] {
  return senders
    .filter((s) => checkEligibility(s, cfg, now).eligible)
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      const aUsed = a.lastUsedAt?.getTime() ?? 0;
      const bUsed = b.lastUsedAt?.getTime() ?? 0;
      if (aUsed !== bUsed) return aUsed - bUsed; // least-recently-used first
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
}

/**
 * Record a successful send: bump the daily counter (rolling the window if it
 * expired), stamp lastUsedAt, and clear any failure streak / cooldown.
 */
export async function noteSuccess(sender: MailSender, now: number): Promise<void> {
  const resetAt = sender.sentCountResetAt?.getTime();
  const windowExpired = !resetAt || now - resetAt >= DAY_MS;

  await db
    .update(mailSenders)
    .set({
      dailySentCount: windowExpired ? 1 : sql`${mailSenders.dailySentCount} + 1`,
      sentCountResetAt: windowExpired ? new Date(now) : sender.sentCountResetAt,
      lastUsedAt: new Date(now),
      consecutiveFailures: 0,
      cooldownUntil: null,
      updatedAt: new Date(now),
    })
    .where(eq(mailSenders.id, sender.id));
}

/**
 * Record a failed send: increment the failure streak and, once it reaches the
 * threshold, put the sender on cooldown so the router rests it.
 */
export async function noteFailure(
  sender: MailSender,
  cfg: RouterConfig,
  now: number
): Promise<void> {
  const failures = sender.consecutiveFailures + 1;
  const tripped = failures >= cfg.failureThreshold;

  if (tripped) {
    recordEmailLog("warn", "deliver", `Sender ${sender.email} cooling down after ${failures} failures`, {
      email: sender.email,
      senderId: sender.id,
      cooldownMinutes: Math.round(cfg.cooldownMs / 60000),
    });
  }

  await db
    .update(mailSenders)
    .set({
      consecutiveFailures: failures,
      cooldownUntil: tripped ? new Date(now + cfg.cooldownMs) : sender.cooldownUntil,
      updatedAt: new Date(now),
    })
    .where(eq(mailSenders.id, sender.id));
}
