import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

/**
 * SSRF policy for user-supplied webhook callback URLs.
 *
 * A webhook URL is an instruction to the server "connect here and POST this".
 * Any user can create one, so it is a request-forgery primitive unless the
 * target is constrained. The old guard was a three-entry denylist
 * (`169.254.169.254`, `*.internal`) which missed every RFC 1918 literal over
 * https, every alternate loopback encoding (`127.1`, `2130706433`,
 * `0177.0.0.1`, `[::ffff:127.0.0.1]`), and did nothing about a hostname that
 * simply resolves to a private address.
 *
 * This module inverts the model: the target must be provably public.
 *
 *   1. `parseWebhookUrl`          — scheme/shape policy, synchronous, safe for forms.
 *   2. `assertSafeWebhookTarget`  — resolves the host and requires EVERY answer
 *                                   to be a public address, so a rebinding name
 *                                   with one private A record is rejected.
 *   3. `fetchWebhook`             — validates, then follows redirects manually so
 *                                   a 302 into the metadata service cannot ride
 *                                   through on a URL that passed step 2.
 *
 * Residual risk, stated plainly: between our `dns.lookup` and undici's own
 * connect there is a small window in which a hostile authoritative server can
 * flip the record. Closing it entirely means pinning the resolved IP into the
 * socket (and hand-managing TLS SNI), which is out of proportion here. Every
 * redirect hop is re-validated, so the window is one lookup wide per hop.
 */

export class WebhookTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookTargetError";
  }
}

/** Hostname suffixes that only ever name internal infrastructure. */
const BLOCKED_HOST_SUFFIXES = [".internal", ".local", ".localhost", ".home.arpa", ".lan"];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"]);

/**
 * Non-public IPv4/IPv6 space. Beyond the obvious private ranges this covers
 * CGNAT (100.64/10), the 0.0.0.0/8 "this host" trick, IETF reserved blocks and
 * multicast — all of which reach something inside the perimeter or crash a
 * connector in an interesting way.
 */
function buildBlockList(): BlockList {
  const list = new BlockList();
  for (const [net, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) {
    list.addSubnet(net, prefix, "ipv4");
  }
  list.addAddress("255.255.255.255", "ipv4");

  for (const [net, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["64:ff9b::", 96],
    ["100::", 64],
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ] as const) {
    list.addSubnet(net, prefix, "ipv6");
  }
  return list;
}

const BLOCKED = buildBlockList();

/** `[::1]` → `::1`; leaves everything else alone. */
export function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * `::ffff:127.0.0.1` and its normalized twin `::ffff:7f00:1` are loopback
 * wearing an IPv6 coat. Unwrap to the embedded IPv4 so the v4 rules apply.
 */
function unwrapMappedIpv4(addr: string): string | null {
  const lower = addr.toLowerCase();
  if (!lower.startsWith("::ffff:")) return null;
  const tail = lower.slice(7);
  if (isIP(tail) === 4) return tail;
  const hextets = tail.split(":");
  if (hextets.length !== 2) return null;
  const [hi, lo] = hextets.map((h) => parseInt(h, 16));
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
}

/** True when the literal address is anything other than public internet space. */
export function isBlockedAddress(raw: string): boolean {
  const addr = stripBrackets(raw.trim());
  const family = isIP(addr);
  if (family === 0) return true; // not a literal we can reason about → refuse
  if (family === 4) return BLOCKED.check(addr, "ipv4");

  const mapped = unwrapMappedIpv4(addr);
  if (mapped) return BLOCKED.check(mapped, "ipv4");
  return BLOCKED.check(addr, "ipv6");
}

/**
 * Loopback over http is a developer convenience, not a production feature: on a
 * VPS `http://localhost:6379` is the app's own Redis. It is therefore opt-in via
 * `WEBHOOK_ALLOW_LOCALHOST=1` and implicit outside production.
 */
export function loopbackAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WEBHOOK_ALLOW_LOCALHOST === "1") return true;
  if (env.WEBHOOK_ALLOW_LOCALHOST === "0") return false;
  return env.NODE_ENV !== "production";
}

export interface ParsedWebhookUrl {
  ok: true;
  /** Serialized, normalized URL — store THIS, not the raw input. */
  url: string;
  hostname: string;
  /** The host is a loopback name/literal explicitly permitted by policy. */
  loopback: boolean;
}

export type ParseWebhookUrlResult = ParsedWebhookUrl | { ok: false; error: string };

/**
 * Synchronous scheme/shape policy. Does no DNS, so it is safe to call from a
 * form handler; `assertSafeWebhookTarget` is what makes the final decision.
 */
export function parseWebhookUrl(
  raw: string,
  options: { allowLoopback?: boolean } = {}
): ParseWebhookUrlResult {
  const allowLoopback = options.allowLoopback ?? loopbackAllowed();

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: "Invalid URL" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "URL must use http or https" };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Credentials in the URL are not allowed" };
  }

  const host = stripBrackets(url.hostname.toLowerCase());
  if (!host) return { ok: false, error: "Invalid URL" };

  // A host that is trying to be an IP literal must succeed at being one, or the
  // resolver and our checks can disagree about what it means.
  if ((/^[\d.]+$/.test(host) || host.startsWith("0x")) && isIP(host) !== 4) {
    return { ok: false, error: "That host is not allowed" };
  }

  const loopback = LOOPBACK_HOSTS.has(host);
  if (loopback) {
    if (!allowLoopback) return { ok: false, error: "That host is not allowed" };
    return { ok: true, url: url.toString(), hostname: host, loopback: true };
  }

  if (url.protocol === "http:") {
    return { ok: false, error: "Use https for non-local URLs" };
  }
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { ok: false, error: "That host is not allowed" };
  }
  if (isIP(host) !== 0 && isBlockedAddress(host)) {
    return { ok: false, error: "That host is not allowed" };
  }

  return { ok: true, url: url.toString(), hostname: host, loopback: false };
}

/** Narrow shape of `dns.lookup(host, {all:true})` so tests can inject answers. */
export type AddressLookup = (host: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: AddressLookup = (host) => dnsLookup(host, { all: true, verbatim: true });

export interface WebhookTargetOptions {
  allowLoopback?: boolean;
  lookup?: AddressLookup;
}

/**
 * Full check: shape policy, then resolution. Throws `WebhookTargetError` with a
 * message safe to show the user.
 *
 * EVERY resolved address must be public. Requiring all of them (rather than
 * "some public address exists") is what defeats a rebinding name that answers
 * with one public and one private record.
 */
export async function assertSafeWebhookTarget(
  raw: string,
  options: WebhookTargetOptions = {}
): Promise<ParsedWebhookUrl> {
  const parsed = parseWebhookUrl(raw, { allowLoopback: options.allowLoopback });
  if (!parsed.ok) throw new WebhookTargetError(parsed.error);

  // An explicitly permitted loopback target is already fully determined.
  if (parsed.loopback) return parsed;

  // A public IP literal needs no resolution — it is its own answer.
  if (isIP(parsed.hostname) !== 0) return parsed;

  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await (options.lookup ?? defaultLookup)(parsed.hostname);
  } catch {
    throw new WebhookTargetError("That host could not be resolved");
  }

  if (!answers.length) throw new WebhookTargetError("That host could not be resolved");
  for (const answer of answers) {
    if (isBlockedAddress(answer.address)) {
      throw new WebhookTargetError("That host resolves to a private address");
    }
  }
  return parsed;
}

/** Redirect chains are followed by hand so each hop is re-validated. */
const MAX_REDIRECTS = 3;

/**
 * `fetch` for webhook delivery. Validates the target, then follows redirects
 * manually — the default `redirect: "follow"` would let `https://evil.test`
 * answer 302 with `Location: http://169.254.169.254/…` and undici would dutifully
 * fetch it, bypassing every check above.
 */
export async function fetchWebhook(
  raw: string,
  init: RequestInit,
  options: WebhookTargetOptions = {}
): Promise<Response> {
  let target = (await assertSafeWebhookTarget(raw, options)).url;

  for (let hop = 0; ; hop++) {
    const response = await fetch(target, { ...init, redirect: "manual" });
    if (response.status < 300 || response.status > 399) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    if (hop >= MAX_REDIRECTS) {
      throw new WebhookTargetError("Too many redirects");
    }

    // Resolve relative Locations against the hop we just made, then re-run the
    // whole policy on the result.
    const next = new URL(location, target).toString();
    target = (await assertSafeWebhookTarget(next, options)).url;
  }
}
