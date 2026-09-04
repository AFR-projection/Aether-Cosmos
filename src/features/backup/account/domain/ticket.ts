/**
 * The download ticket: a signed parameter bag, and deliberately not a credential.
 *
 * A browser download is a plain navigation, so the click that starts it cannot carry a CSRF
 * token or a JSON body. What it can carry is a path segment, and this is what goes in it. The
 * shape is `base64url(canonical(payload)) || "." || base64url(HMAC-SHA256)`.
 *
 * **There is no key material inside.** Not a wrapped DEK, not a salt, nothing — the DEK for the
 * archive does not exist yet when the ticket is minted; it is created inside the GET handler as
 * the stream begins. The payload is six plain fields: `{ ticketId, domain, userId, sessionId,
 * issuedAt, expiresAt }`.
 *
 * **Stateless, 90 seconds, and not single-use — and it is not claimed to be.** Nothing stateless
 * can be burned after one use, so this file does not pretend otherwise. What makes a replay
 * harmless is the handler, not the ticket: `GET` runs the full `requireAuth()`, then requires
 * `ticket.userId` to equal the authenticated user **and** `ticket.sessionId` to equal the session
 * the request actually arrived on. So a replayed ticket downloads the holder's own data, which
 * the holder could get by clicking again. The cost of a replay is egress and CPU, and that is
 * what the rate limit on `prepare` is for.
 *
 * The signing key is the app secret — the same one that signs staged login tokens — not
 * `BACKUP_MASTER_KEY`. Two reasons, both binding: a ticket is session-scoped ephemera whose
 * secret *should* rotate with sessions, while `BACKUP_MASTER_KEY` must not rotate casually
 * (§4.1); and the fewer places that touch the archive master key, the smaller the surface that
 * can leak it. A rotated app secret invalidates in-flight tickets, which lasts 90 seconds and is
 * indistinguishable from the sessions it also invalidates.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §6.1, §6.2, §10.
 */

import { createHmac, randomUUID, timingSafeEqual } from "crypto";

import { appSecret } from "@/shared/lib/security/app-secret";
import { canonicalBytes } from "@backup/account/domain/canonical";
import { AccountBackupTicketError } from "@backup/account/domain/errors";
import type { BackupDomain } from "@backup/domain/types";

/** Long enough to cover the gap between a click and a navigation; short enough to not matter. */
export const TICKET_TTL_MS = 90_000;

/** Guards the parser against a pathological path segment before any parsing happens. */
const MAX_TICKET_CHARS = 512;

export interface TakeoutTicketPayload {
  ticketId: string;
  domain: BackupDomain;
  userId: string;
  sessionId: string;
  /** Epoch milliseconds. */
  issuedAt: number;
  expiresAt: number;
}

export interface MintTicketInput {
  domain: BackupDomain;
  userId: string;
  sessionId: string;
  /** Injected so a test can put a ticket on either side of its expiry without waiting. */
  now?: number;
  ttlMs?: number;
  ticketId?: string;
  secret?: string;
}

function sign(body: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

/**
 * The canonical body, and the reason it goes through the archive's own serializer.
 *
 * A ticket is verified by re-serializing what was parsed and comparing MACs, so writer and
 * verifier must agree on every byte — the same requirement the header has, met by the same
 * module rather than by two `JSON.stringify` calls that happen to agree today.
 */
function ticketBody(payload: TakeoutTicketPayload): string {
  return canonicalBytes({
    ticketId: payload.ticketId,
    domain: payload.domain,
    userId: payload.userId,
    sessionId: payload.sessionId,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  }).toString("base64url");
}

export function mintTakeoutTicket(input: MintTicketInput): string {
  const issuedAt = input.now ?? Date.now();
  const payload: TakeoutTicketPayload = {
    ticketId: input.ticketId ?? randomUUID(),
    domain: input.domain,
    userId: input.userId,
    sessionId: input.sessionId,
    issuedAt,
    expiresAt: issuedAt + (input.ttlMs ?? TICKET_TTL_MS),
  };
  const body = ticketBody(payload);
  return `${body}.${sign(body, input.secret ?? appSecret()).toString("base64url")}`;
}

export interface TicketHolder {
  userId: string;
  sessionId: string;
}

export interface VerifyTicketOptions {
  now?: number;
  secret?: string;
}

function decodeBody(body: string): TakeoutTicketPayload {
  const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new AccountBackupTicketError("ticket payload is not an object");
  }
  const raw = parsed as Record<string, unknown>;
  const domain = raw.domain;
  if (domain !== "files" && domain !== "brain") {
    throw new AccountBackupTicketError(`ticket domain ${String(domain)} is not a domain`);
  }
  for (const field of ["ticketId", "userId", "sessionId"] as const) {
    if (typeof raw[field] !== "string" || raw[field] === "") {
      throw new AccountBackupTicketError(`ticket ${field} is missing`);
    }
  }
  for (const field of ["issuedAt", "expiresAt"] as const) {
    if (typeof raw[field] !== "number" || !Number.isSafeInteger(raw[field])) {
      throw new AccountBackupTicketError(`ticket ${field} is not an integer`);
    }
  }
  return {
    ticketId: raw.ticketId as string,
    domain,
    userId: raw.userId as string,
    sessionId: raw.sessionId as string,
    issuedAt: raw.issuedAt as number,
    expiresAt: raw.expiresAt as number,
  };
}

/**
 * Verify signature, expiry, and holder — in that order, and the order is the point.
 *
 * The MAC is checked over the raw body *before* the body is parsed, so no attacker-chosen bytes
 * reach `JSON.parse` unauthenticated. Then expiry. Then the two equality checks that make a
 * replay pointless: the ticket must name the authenticated user and the session this request
 * actually arrived on.
 *
 * Every failure is one {@link AccountBackupTicketError} with one message. The `detail` says which
 * check failed and is for the audit trail only — a response that distinguished "expired" from
 * "signed for someone else" would tell a prober which half of a forged ticket to fix.
 */
export function verifyTakeoutTicket(
  ticket: string,
  holder: TicketHolder,
  options: VerifyTicketOptions = {}
): TakeoutTicketPayload {
  if (ticket.length === 0 || ticket.length > MAX_TICKET_CHARS) {
    throw new AccountBackupTicketError(`ticket is ${ticket.length} characters`);
  }
  const dot = ticket.indexOf(".");
  if (dot <= 0 || dot === ticket.length - 1 || ticket.indexOf(".", dot + 1) !== -1) {
    throw new AccountBackupTicketError("ticket is not body.mac");
  }

  const body = ticket.slice(0, dot);
  const presented = Buffer.from(ticket.slice(dot + 1), "base64url");
  const expected = sign(body, options.secret ?? appSecret());
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    throw new AccountBackupTicketError("ticket signature does not verify");
  }

  let payload: TakeoutTicketPayload;
  try {
    payload = decodeBody(body);
  } catch (err) {
    if (err instanceof AccountBackupTicketError) throw err;
    throw new AccountBackupTicketError("ticket payload is not readable");
  }

  // Re-serializing and comparing catches a body that verified under a *different* field order or
  // a dropped null — bytes we could not have written, and therefore a signing key that is not
  // ours or a serializer that has drifted. Cheap, and it keeps `canonical` load-bearing.
  if (ticketBody(payload) !== body) {
    throw new AccountBackupTicketError("ticket body is not canonical");
  }

  const now = options.now ?? Date.now();
  if (now >= payload.expiresAt) {
    throw new AccountBackupTicketError(`ticket expired ${now - payload.expiresAt} ms ago`);
  }
  if (payload.issuedAt > now + 5_000) {
    throw new AccountBackupTicketError("ticket is issued in the future");
  }
  if (payload.userId !== holder.userId) {
    throw new AccountBackupTicketError("ticket belongs to another account");
  }
  if (payload.sessionId !== holder.sessionId) {
    throw new AccountBackupTicketError("ticket belongs to another session");
  }
  return payload;
}
