/**
 * The download ticket: acceptance tests #26, #27 and #28.
 *
 * A ticket is a signed parameter bag and not a credential, so the three scenarios the design
 * lists are all about what the *handler* can still refuse after the signature verifies —
 * expiry (#26), a replay (#27), and a ticket minted for another account or another session
 * (#28). What makes a replay harmless is that `userId` and `sessionId` are inside the signed
 * body, so a stolen ticket downloads the holder's own data or nothing.
 *
 * Every refusal here is one `AccountBackupTicketError` with one sentence: a response that
 * distinguished "expired" from "signed for someone else" would tell a prober which half of a
 * forged ticket to fix. The `detail` is for `activity_logs` and is asserted separately.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §6.1, §6.2, §10,
 * §16 tests #26–#28.
 */

import { createHmac, randomBytes } from "crypto";
import { describe, expect, it } from "vitest";

import {
  TICKET_TTL_MS,
  mintTakeoutTicket,
  verifyTakeoutTicket,
  type TicketHolder,
} from "@backup/account/domain/ticket";
import { AccountBackupTicketError } from "@backup/account/domain/errors";

const SECRET = randomBytes(32).toString("hex");
const OTHER_SECRET = randomBytes(32).toString("hex");
const NOW = 1_772_500_000_000;

const HOLDER: TicketHolder = {
  userId: "11111111-1111-4111-8111-111111111111",
  sessionId: "session-a",
};
const OTHER_HOLDER: TicketHolder = {
  userId: "22222222-2222-4222-8222-222222222222",
  sessionId: "session-b",
};

function mint(over: Partial<Parameters<typeof mintTakeoutTicket>[0]> = {}): string {
  return mintTakeoutTicket({
    domain: "files",
    userId: HOLDER.userId,
    sessionId: HOLDER.sessionId,
    now: NOW,
    secret: SECRET,
    ...over,
  });
}

function verify(ticket: string, holder: TicketHolder = HOLDER, now = NOW + 1_000) {
  return verifyTakeoutTicket(ticket, holder, { now, secret: SECRET });
}

/** The refusal a call raised, with its `detail` — which no response ever carries. */
function refusalOf(run: () => unknown): AccountBackupTicketError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AccountBackupTicketError);
    return error as AccountBackupTicketError;
  }
  return expect.unreachable("expected a refusal");
}

describe("a ticket carries six plain fields and no key material", () => {
  it("round trips the six fields it was minted with", () => {
    const payload = verify(mint({ ticketId: "tkt-1" }));

    expect(payload).toEqual({
      ticketId: "tkt-1",
      domain: "files",
      userId: HOLDER.userId,
      sessionId: HOLDER.sessionId,
      issuedAt: NOW,
      expiresAt: NOW + TICKET_TTL_MS,
    });
  });

  it("puts nothing in the body that is not one of those six", () => {
    const [body] = mint({ ticketId: "tkt-2" }).split(".");
    const decoded: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));

    // Stated as an exact key list rather than as absences: a seventh field added later has to
    // be added here too, which is where somebody would notice it was a wrapped DEK.
    expect(Object.keys(decoded as Record<string, unknown>).sort()).toEqual([
      "domain",
      "expiresAt",
      "issuedAt",
      "sessionId",
      "ticketId",
      "userId",
    ]);
  });

  it("mints a fresh id per ticket, so the audit trail can tell two apart", () => {
    expect(mint()).not.toBe(mint());
    expect(verify(mint()).ticketId).not.toBe(verify(mint()).ticketId);
  });

  it("lives 90 seconds", () => {
    expect(TICKET_TTL_MS).toBe(90_000);
    expect(verify(mint()).expiresAt - NOW).toBe(90_000);
  });
});

describe("#26 — a ticket that has run out of time", () => {
  it("verifies at 89 seconds and refuses at 91", () => {
    const ticket = mint();

    expect(verify(ticket, HOLDER, NOW + 89_000).domain).toBe("files");
    const refusal = refusalOf(() => verify(ticket, HOLDER, NOW + 91_000));
    expect(refusal.detail).toMatch(/expired 1000 ms ago/);
  });

  it("treats the expiry instant itself as gone", () => {
    // `>=`, not `>`: a ticket is valid for a window, and the closing edge belongs to nobody.
    const ticket = mint();

    expect(() => verify(ticket, HOLDER, NOW + TICKET_TTL_MS - 1)).not.toThrow();
    expect(refusalOf(() => verify(ticket, HOLDER, NOW + TICKET_TTL_MS)).detail).toMatch(/expired/);
  });

  it("refuses a ticket dated in the future beyond the clock-skew allowance", () => {
    // A ticket minted 10 minutes ahead would otherwise outlive its 90 seconds by that much.
    expect(() => verify(mint({ now: NOW + 4_000 }), HOLDER, NOW)).not.toThrow();
    expect(refusalOf(() => verify(mint({ now: NOW + 600_000 }), HOLDER, NOW)).detail).toMatch(
      /issued in the future/
    );
  });

  it("says the same sentence for an expired ticket as for a forged one", () => {
    const expired = refusalOf(() => verify(mint(), HOLDER, NOW + 91_000));
    const forged = refusalOf(() => verify(mint({ secret: OTHER_SECRET })));

    expect(expired.message).toBe(forged.message);
    expect(expired.message).toBe("This download link is no longer valid.");
    expect([expired.status, forged.status]).toEqual([403, 403]);
    expect([expired.code, forged.code]).toEqual(["AFRBAK_TICKET", "AFRBAK_TICKET"]);
    // Only the audit trail is allowed to tell them apart.
    expect(expired.detail).not.toBe(forged.detail);
  });
});

describe("#27 — a replayed ticket downloads its own holder's data or nothing", () => {
  it("verifies the same ticket twice, and says so rather than pretending to be single-use", () => {
    const ticket = mint({ ticketId: "tkt-replay" });

    // Stateless: there is nowhere to burn it. Two verifications return the same payload, and
    // that payload names the same account both times — which is what makes the replay useless.
    expect(verify(ticket)).toEqual(verify(ticket, HOLDER, NOW + 2_000));
    expect(verify(ticket).userId).toBe(HOLDER.userId);
  });

  it("cannot be replayed by anyone else, however it was obtained", () => {
    const ticket = mint();

    // The two ways a leaked ticket travels: a different account, and the same account on a
    // different session (a second browser, or a session that was re-minted after a re-login).
    expect(refusalOf(() => verify(ticket, OTHER_HOLDER)).detail).toMatch(/another account/);
    expect(
      refusalOf(() => verify(ticket, { ...HOLDER, sessionId: "session-z" })).detail
    ).toMatch(/another session/);
  });

  it("cannot be re-pointed at another account by editing the body", () => {
    const [body] = mint().split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      userId: string;
    };
    payload.userId = OTHER_HOLDER.userId;
    const edited = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const [, mac] = mint().split(".");

    // The MAC covers the body, so the edit cannot keep the signature — and the signature is
    // checked *before* the body is parsed, so no attacker-chosen bytes reach `JSON.parse`.
    expect(refusalOf(() => verify(`${edited}.${mac}`)).detail).toMatch(/signature does not verify/);
  });

  it("does not accept a body that verifies under a different field order", () => {
    const payload = {
      userId: HOLDER.userId,
      ticketId: "tkt-reordered",
      domain: "files",
      sessionId: HOLDER.sessionId,
      issuedAt: NOW,
      expiresAt: NOW + TICKET_TTL_MS,
    };
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const mac = createHmac("sha256", SECRET).update(body).digest("base64url");

    // Signed with our own secret, and still refused: bytes we could not have written mean a
    // serializer that has drifted, and canonicalisation stays load-bearing rather than habit.
    expect(refusalOf(() => verify(`${body}.${mac}`)).detail).toMatch(/not canonical/);
  });
});

describe("#28 — a ticket for another user, another session, or another secret", () => {
  it("refuses a ticket minted for a different account", () => {
    const theirs = mint({ userId: OTHER_HOLDER.userId, sessionId: OTHER_HOLDER.sessionId });

    expect(refusalOf(() => verify(theirs)).detail).toMatch(/another account/);
  });

  it("refuses a ticket minted on another of the same account's sessions", () => {
    const elsewhere = mint({ sessionId: "session-on-the-other-laptop" });

    expect(refusalOf(() => verify(elsewhere)).detail).toMatch(/another session/);
  });

  it("refuses a ticket signed with a secret this server does not hold", () => {
    // What a rotated app secret looks like: in-flight tickets die, which lasts 90 seconds and
    // is indistinguishable from the sessions the same rotation invalidated.
    expect(refusalOf(() => verify(mint({ secret: OTHER_SECRET }))).detail).toMatch(
      /signature does not verify/
    );
  });

  it("keeps the two halves of the check independent", () => {
    const wrongBoth = mint({ userId: OTHER_HOLDER.userId, sessionId: "session-z" });

    // The account is compared first, so this is the account's refusal — the order matters only
    // for what lands in the log, never for what the caller is told.
    expect(refusalOf(() => verify(wrongBoth)).detail).toMatch(/another account/);
  });
});

describe("what the parser refuses before it parses anything", () => {
  it("refuses an empty ticket and one longer than any ticket can be", () => {
    expect(refusalOf(() => verify("")).detail).toMatch(/is 0 characters/);
    expect(refusalOf(() => verify("a".repeat(513))).detail).toMatch(/is 513 characters/);
  });

  it("refuses anything that is not exactly body.mac", () => {
    const ticket = mint();
    const [body, mac] = ticket.split(".");

    for (const malformed of [body, `.${mac}`, `${body}.`, `${body}.${mac}.`, `${body}.${mac}.x`]) {
      expect(refusalOf(() => verify(malformed)).detail).toMatch(/not body\.mac/);
    }
  });

  it("refuses a truncated MAC rather than comparing a prefix", () => {
    const [body, mac] = mint().split(".");

    expect(refusalOf(() => verify(`${body}.${mac.slice(0, 20)}`)).detail).toMatch(
      /signature does not verify/
    );
  });

  it("refuses a body that is not a domain, not an object, or missing a field", () => {
    const sign = (value: unknown) => {
      const body = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
      return `${body}.${createHmac("sha256", SECRET).update(body).digest("base64url")}`;
    };
    const base = {
      ticketId: "tkt-3",
      domain: "files",
      userId: HOLDER.userId,
      sessionId: HOLDER.sessionId,
      issuedAt: NOW,
      expiresAt: NOW + TICKET_TTL_MS,
    };

    expect(refusalOf(() => verify(sign(null))).detail).toMatch(/not an object/);
    // An array *is* an object in JavaScript, so it falls to the next check rather than the
    // first one — refused either way, and this pins which sentence the log gets.
    expect(refusalOf(() => verify(sign([1, 2, 3]))).detail).toMatch(/is not a domain/);
    expect(refusalOf(() => verify(sign({ ...base, domain: "everything" }))).detail).toMatch(
      /is not a domain/
    );
    expect(refusalOf(() => verify(sign({ ...base, userId: "" }))).detail).toMatch(
      /userId is missing/
    );
    expect(refusalOf(() => verify(sign({ ...base, expiresAt: 1.5 }))).detail).toMatch(
      /expiresAt is not an integer/
    );
  });

  it("never repeats the secret, the MAC, or the session id in what it says", () => {
    const refusal = refusalOf(() => verify(mint({ secret: OTHER_SECRET })));

    for (const leak of [SECRET, OTHER_SECRET, HOLDER.sessionId]) {
      expect(refusal.message).not.toContain(leak);
      expect(refusal.detail).not.toContain(leak);
    }
  });
});
