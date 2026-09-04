import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * Where the app believes a request came from.
 *
 * `resolveClientIp` is the key behind every per-IP limit in the product — the
 * login throttle, the registration cap, OTP verification, share views — and it is
 * the `ip` column of every audit row and the value session IP binding compares
 * against. It used to read `CF-Connecting-IP` first and then the FIRST public
 * entry of `X-Forwarded-For`, both of which the caller writes: a single
 * `CF-Connecting-IP: 1.2.3.4` header (or a fresh value per request) moved all of
 * those buckets to an address of the attacker's choosing. No per-IP limit bound
 * anything, and the audit log recorded whatever was typed.
 *
 * The one thing that makes header trust sound here is the deployment: port 3000
 * is not published, so nginx is the only peer. `X-Real-IP` is set from
 * `$remote_addr` (overwrite), and `X-Forwarded-For` is `$proxy_add_x_forwarded_for`
 * (the client's chain with the real peer APPENDED) — so the last hop is the only
 * one the client cannot write.
 */

const db = vi.hoisted(() => ({}));
vi.mock("@/shared/infrastructure/db", () => ({ db }));
vi.mock("@/shared/lib/auth/audit", () => ({ logActivity: async () => undefined }));
vi.mock("@/shared/lib/access-tracking", () => ({
  getIpLocation: async () => null,
  parseUserAgent: () => ({ browser: "Unknown", os: "Unknown", device: "Unknown" }),
}));

const { resolveClientIp, getClientIp } = await import("@/shared/lib/auth/session");

const CLIENT_LIE = "1.2.3.4";
const REAL_PEER = "203.0.113.9";

afterEach(() => {
  delete process.env.TRUST_CLOUDFLARE_HEADERS;
});

describe("resolveClientIp ignores headers the caller can forge", () => {
  it("prefers X-Real-IP, which nginx overwrites", () => {
    expect(
      resolveClientIp({
        cfConnectingIp: CLIENT_LIE,
        xForwardedFor: `${CLIENT_LIE}, ${REAL_PEER}`,
        xRealIp: REAL_PEER,
      })
    ).toBe(REAL_PEER);
  });

  it("ignores CF-Connecting-IP unless the operator says Cloudflare is in front", () => {
    // Nothing strips this header for a direct-to-nginx deployment, so on its own
    // it is just a string the caller sent.
    expect(resolveClientIp({ cfConnectingIp: CLIENT_LIE, xRealIp: REAL_PEER })).toBe(REAL_PEER);
    expect(resolveClientIp({ cfConnectingIp: CLIENT_LIE })).toBe("unknown");
  });

  it("honours CF-Connecting-IP once TRUST_CLOUDFLARE_HEADERS is set", () => {
    process.env.TRUST_CLOUDFLARE_HEADERS = "true";
    expect(resolveClientIp({ cfConnectingIp: CLIENT_LIE, xRealIp: REAL_PEER })).toBe(CLIENT_LIE);
  });

  it("does not treat any other value of the flag as consent", () => {
    process.env.TRUST_CLOUDFLARE_HEADERS = "1";
    expect(resolveClientIp({ cfConnectingIp: CLIENT_LIE, xRealIp: REAL_PEER })).toBe(REAL_PEER);
  });

  it("takes the LAST X-Forwarded-For hop, never the first", () => {
    // nginx appends the peer, so everything left of the final entry is text the
    // caller chose.
    expect(
      resolveClientIp({ xForwardedFor: `${CLIENT_LIE}, 198.51.100.7, ${REAL_PEER}` })
    ).toBe(REAL_PEER);
  });

  it("cannot be pushed off the end of the chain by a trailing junk hop", () => {
    // A forged trailing entry that is not an address is skipped, not accepted, and
    // the search keeps walking left rather than falling back to the first hop.
    expect(
      resolveClientIp({ xForwardedFor: `${CLIENT_LIE}, ${REAL_PEER}, not-an-ip` })
    ).toBe(REAL_PEER);
  });

  it("falls back to the forwarded chain only when X-Real-IP is absent or junk", () => {
    expect(resolveClientIp({ xForwardedFor: `${CLIENT_LIE}, ${REAL_PEER}` })).toBe(REAL_PEER);
    expect(
      resolveClientIp({ xRealIp: "localhost", xForwardedFor: `${CLIENT_LIE}, ${REAL_PEER}` })
    ).toBe(REAL_PEER);
  });

  it("answers 'unknown' rather than something forgeable when no proxy header survives", () => {
    expect(resolveClientIp({})).toBe("unknown");
    expect(resolveClientIp({ xRealIp: "", xForwardedFor: "  ,  " })).toBe("unknown");
    expect(resolveClientIp({ xForwardedFor: "banana" })).toBe("unknown");
  });
});

describe("resolveClientIp normalises what it accepts", () => {
  it("drops a port from a v4 address", () => {
    expect(resolveClientIp({ xRealIp: "203.0.113.9:54321" })).toBe(REAL_PEER);
  });

  it("unwraps a bracketed v6 address, with or without a port", () => {
    expect(resolveClientIp({ xRealIp: "[2001:db8::1]:443" })).toBe("2001:db8::1");
    expect(resolveClientIp({ xRealIp: "[2001:DB8::1]" })).toBe("2001:db8::1");
  });

  it("keeps the v4-mapped form a dual-stack listener hands over", () => {
    expect(resolveClientIp({ xRealIp: "::ffff:203.0.113.9" })).toBe("::ffff:203.0.113.9");
  });

  it("lowercases and trims, so one caller is one rate-limit key", () => {
    // `2001:DB8::1` and `2001:db8::1` used to be two separate buckets.
    expect(resolveClientIp({ xRealIp: "  2001:DB8::1  " })).toBe("2001:db8::1");
  });

  it("refuses an octet over 255 instead of keying a limit on nonsense", () => {
    expect(resolveClientIp({ xRealIp: "999.1.1.1", xForwardedFor: REAL_PEER })).toBe(REAL_PEER);
  });
});

describe("getClientIp reads the same three headers off a Request", () => {
  function req(headers: Record<string, string>) {
    return new Request("http://localhost/api/auth/login", { headers });
  }

  it("uses X-Real-IP over a forged CF-Connecting-IP and a forged first XFF hop", () => {
    expect(
      getClientIp(
        req({
          "cf-connecting-ip": CLIENT_LIE,
          "x-forwarded-for": `${CLIENT_LIE}, ${REAL_PEER}`,
          "x-real-ip": REAL_PEER,
        })
      )
    ).toBe(REAL_PEER);
  });

  it("gives a caller sending nothing but lies a single shared bucket", () => {
    // "unknown" is deliberately one key: a spoofable header would have given the
    // same caller a fresh, unlimited budget on every request.
    expect(getClientIp(req({ "cf-connecting-ip": CLIENT_LIE }))).toBe("unknown");
    expect(getClientIp(req({ "cf-connecting-ip": "5.6.7.8" }))).toBe("unknown");
  });
});
