import { describe, it, expect } from "vitest";
import {
  checkEligibility,
  selectSenders,
  currentDailyCount,
  effectiveDailyLimit,
  type RouterConfig,
} from "./router";
import type { MailSender } from "@/lib/db/schema";

const CFG: RouterConfig = { defaultDailyLimit: 400, failureThreshold: 3, cooldownMs: 30 * 60_000 };
const NOW = 1_700_000_000_000;

function sender(overrides: Partial<MailSender> = {}): MailSender {
  return {
    id: overrides.id ?? "s1",
    email: overrides.email ?? "a@gmail.com",
    appPasswordEncrypted: "enc",
    displayName: "A",
    fromName: "Aether Cosmos ByAFR",
    status: "ok",
    isActive: true,
    lastError: null,
    lastVerifiedAt: null,
    priority: 0,
    dailyLimit: 0,
    dailySentCount: 0,
    sentCountResetAt: null,
    lastUsedAt: null,
    consecutiveFailures: 0,
    cooldownUntil: null,
    createdAt: new Date(NOW - 1_000_000),
    updatedAt: new Date(NOW),
    ...overrides,
  } as MailSender;
}

describe("email/router eligibility", () => {
  it("accepts a healthy sender", () => {
    expect(checkEligibility(sender(), CFG, NOW).eligible).toBe(true);
  });

  it("rejects inactive / errored senders", () => {
    expect(checkEligibility(sender({ isActive: false }), CFG, NOW)).toMatchObject({ reason: "inactive" });
    expect(checkEligibility(sender({ status: "error" }), CFG, NOW)).toMatchObject({ reason: "errored" });
  });

  it("rejects a sender in active cooldown but accepts once it expires", () => {
    const cooling = sender({ cooldownUntil: new Date(NOW + 60_000) });
    expect(checkEligibility(cooling, CFG, NOW)).toMatchObject({ reason: "cooldown" });
    const expired = sender({ cooldownUntil: new Date(NOW - 60_000) });
    expect(checkEligibility(expired, CFG, NOW).eligible).toBe(true);
  });

  it("rejects a sender at its daily limit, honoring per-sender override", () => {
    const maxed = sender({ dailySentCount: 400, sentCountResetAt: new Date(NOW) });
    expect(checkEligibility(maxed, CFG, NOW)).toMatchObject({ reason: "daily_limit" });
    const overridden = sender({ dailyLimit: 10, dailySentCount: 10, sentCountResetAt: new Date(NOW) });
    expect(checkEligibility(overridden, CFG, NOW)).toMatchObject({ reason: "daily_limit" });
  });

  it("treats an expired day window as a fresh (zero) count", () => {
    const rolled = sender({ dailySentCount: 400, sentCountResetAt: new Date(NOW - 25 * 60 * 60_000) });
    expect(currentDailyCount(rolled, NOW)).toBe(0);
    expect(checkEligibility(rolled, CFG, NOW).eligible).toBe(true);
  });

  it("effectiveDailyLimit prefers the sender override over the default", () => {
    expect(effectiveDailyLimit(sender({ dailyLimit: 0 }), CFG)).toBe(400);
    expect(effectiveDailyLimit(sender({ dailyLimit: 50 }), CFG)).toBe(50);
  });
});

describe("email/router selection", () => {
  it("orders by priority, then least-recently-used", () => {
    const s = [
      sender({ id: "hi-pri-recent", priority: 0, lastUsedAt: new Date(NOW - 1000) }),
      sender({ id: "hi-pri-old", priority: 0, lastUsedAt: new Date(NOW - 999_999) }),
      sender({ id: "lo-pri", priority: 5, lastUsedAt: null }),
    ];
    const order = selectSenders(s, CFG, NOW).map((x) => x.id);
    expect(order).toEqual(["hi-pri-old", "hi-pri-recent", "lo-pri"]);
  });

  it("drops ineligible senders from the selection", () => {
    const s = [
      sender({ id: "ok" }),
      sender({ id: "cooling", cooldownUntil: new Date(NOW + 60_000) }),
      sender({ id: "maxed", dailySentCount: 400, sentCountResetAt: new Date(NOW) }),
      sender({ id: "off", isActive: false }),
    ];
    expect(selectSenders(s, CFG, NOW).map((x) => x.id)).toEqual(["ok"]);
  });

  it("returns empty when every sender is unavailable", () => {
    const s = [sender({ id: "a", status: "error" }), sender({ id: "b", isActive: false })];
    expect(selectSenders(s, CFG, NOW)).toEqual([]);
  });
});
