import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseWebhookUrl,
  isBlockedAddress,
  loopbackAllowed,
  assertSafeWebhookTarget,
  fetchWebhook,
  WebhookTargetError,
  type AddressLookup,
} from "@/shared/infrastructure/webhooks/ssrf";

/**
 * Pins the SSRF policy for user-supplied webhook URLs.
 *
 * The guard this replaced was a three-entry denylist, so the cases below are
 * written as the bypasses that used to work: private literals over https,
 * alternate loopback encodings, a hostname that merely RESOLVES inside the
 * perimeter, and a redirect into the metadata service. Each one must fail
 * closed, and the legitimate `https://hooks.example.com/x` case must still pass.
 */

const publicAnswer: AddressLookup = async () => [{ address: "93.184.216.34", family: 4 }];

describe("isBlockedAddress", () => {
  it("blocks every private / reserved IPv4 range", () => {
    for (const addr of [
      "0.0.0.0",
      "10.0.0.7",
      "100.64.1.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isBlockedAddress(addr), addr).toBe(true);
    }
  });

  it("allows public IPv4", () => {
    expect(isBlockedAddress("93.184.216.34")).toBe(false);
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
    expect(isBlockedAddress("172.32.0.1")).toBe(false); // just outside 172.16/12
  });

  it("blocks IPv6 loopback, ULA, link-local and multicast", () => {
    for (const addr of ["::", "::1", "[::1]", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1"]) {
      expect(isBlockedAddress(addr), addr).toBe(true);
    }
  });

  it("unwraps IPv4-mapped IPv6 instead of trusting the coat", () => {
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:7f00:1")).toBe(true);
    expect(isBlockedAddress("::ffff:a00:1")).toBe(true); // 10.0.0.1
    expect(isBlockedAddress("::ffff:5db8:d822")).toBe(false); // 93.184.216.34
  });

  it("refuses anything that is not a parseable literal", () => {
    expect(isBlockedAddress("example.com")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });
});

describe("parseWebhookUrl", () => {
  it("accepts a normal https endpoint", () => {
    const r = parseWebhookUrl("https://hooks.example.com/ingest?x=1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toBe("https://hooks.example.com/ingest?x=1");
      expect(r.loopback).toBe(false);
    }
  });

  it("rejects private literals over https — the old denylist let these through", () => {
    for (const raw of [
      "https://10.0.0.5/hook",
      "https://192.168.1.10/hook",
      "https://172.16.0.1/hook",
      "https://169.254.169.254/latest/meta-data/",
      "https://[fd00::1]/hook",
    ]) {
      const r = parseWebhookUrl(raw, { allowLoopback: true });
      expect(r.ok, raw).toBe(false);
    }
  });

  it("rejects alternate loopback encodings", () => {
    // The WHATWG parser normalizes most of these to 127.0.0.1; the rest are
    // refused as malformed numeric hosts. Either way: not ok.
    for (const raw of [
      "http://127.1/hook",
      "http://2130706433/hook",
      "http://0177.0.0.1/hook",
      "http://0x7f.1/hook",
      "http://0.0.0.0/hook",
      "https://[::]/hook",
      "https://[::ffff:127.0.0.1]/hook",
    ]) {
      const r = parseWebhookUrl(raw, { allowLoopback: false });
      expect(r.ok, raw).toBe(false);
    }
  });

  it("gates plain loopback on policy rather than on hope", () => {
    expect(parseWebhookUrl("http://localhost:3000/hook", { allowLoopback: true }).ok).toBe(true);
    expect(parseWebhookUrl("http://127.0.0.1/hook", { allowLoopback: true }).ok).toBe(true);
    // Production: localhost:6379 is the app's own Redis, not a callback target.
    expect(parseWebhookUrl("http://localhost:6379/hook", { allowLoopback: false }).ok).toBe(false);
    expect(parseWebhookUrl("https://localhost/hook", { allowLoopback: false }).ok).toBe(false);
  });

  it("keeps http off the public internet", () => {
    expect(parseWebhookUrl("http://example.com/hook").ok).toBe(false);
  });

  it("rejects internal-only name suffixes", () => {
    for (const raw of [
      "https://db.internal/hook",
      "https://metadata.google.internal/x",
      "https://nas.local/hook",
      "https://printer.lan/hook",
      "https://thing.home.arpa/hook",
    ]) {
      expect(parseWebhookUrl(raw).ok, raw).toBe(false);
    }
  });

  it("rejects non-http schemes, credentials and garbage", () => {
    expect(parseWebhookUrl("ftp://example.com").ok).toBe(false);
    expect(parseWebhookUrl("javascript:alert(1)").ok).toBe(false);
    expect(parseWebhookUrl("file:///etc/passwd").ok).toBe(false);
    expect(parseWebhookUrl("not a url").ok).toBe(false);
    expect(parseWebhookUrl("https://user:pass@example.com/hook").ok).toBe(false);
  });
});

describe("assertSafeWebhookTarget — DNS is where rebinding is caught", () => {
  it("accepts a name that resolves entirely to public space", async () => {
    const parsed = await assertSafeWebhookTarget("https://hooks.example.com/x", {
      lookup: publicAnswer,
    });
    expect(parsed.hostname).toBe("hooks.example.com");
  });

  it("rejects a name that resolves to a private address", async () => {
    const lookup: AddressLookup = async () => [{ address: "10.1.2.3", family: 4 }];
    await expect(
      assertSafeWebhookTarget("https://sneaky.example.com/x", { lookup })
    ).rejects.toThrow(WebhookTargetError);
  });

  it("requires EVERY answer to be public, not just one", async () => {
    // The classic rebinding shape: one real record, one pointing inside.
    const lookup: AddressLookup = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ];
    await expect(
      assertSafeWebhookTarget("https://rebind.example.com/x", { lookup })
    ).rejects.toThrow(/private address/);
  });

  it("treats an unresolvable or empty answer as a refusal", async () => {
    await expect(
      assertSafeWebhookTarget("https://nope.example.com/x", { lookup: async () => [] })
    ).rejects.toThrow(/could not be resolved/);
    await expect(
      assertSafeWebhookTarget("https://nope.example.com/x", {
        lookup: async () => {
          throw new Error("ENOTFOUND");
        },
      })
    ).rejects.toThrow(/could not be resolved/);
  });

  it("does not resolve a public IP literal — it is already the answer", async () => {
    const lookup = vi.fn(publicAnswer);
    await assertSafeWebhookTarget("https://93.184.216.34/x", { lookup });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("still enforces the shape policy before any lookup", async () => {
    const lookup = vi.fn(publicAnswer);
    await expect(
      assertSafeWebhookTarget("http://example.com/x", { lookup })
    ).rejects.toThrow(WebhookTargetError);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("loopbackAllowed", () => {
  it("is opt-in in production and implicit elsewhere", () => {
    expect(loopbackAllowed({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(false);
    expect(loopbackAllowed({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe(true);
    expect(
      loopbackAllowed({ NODE_ENV: "production", WEBHOOK_ALLOW_LOCALHOST: "1" } as NodeJS.ProcessEnv)
    ).toBe(true);
    expect(
      loopbackAllowed({ NODE_ENV: "test", WEBHOOK_ALLOW_LOCALHOST: "0" } as NodeJS.ProcessEnv)
    ).toBe(false);
  });
});

describe("fetchWebhook — redirects are the other half of the hole", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubFetch(handler: (url: string, init: RequestInit) => Response) {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      return handler(url, init ?? {});
    }) as unknown as typeof fetch;
    return calls;
  }

  it("delivers to a validated public target", async () => {
    const calls = stubFetch(() => new Response("ok", { status: 200 }));
    const res = await fetchWebhook(
      "https://hooks.example.com/x",
      { method: "POST", body: "{}" },
      { lookup: publicAnswer }
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual(["https://hooks.example.com/x"]);
  });

  it("never follows a redirect into the metadata service", async () => {
    const calls = stubFetch((url) =>
      url.includes("hooks.example.com")
        ? new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data/" },
          })
        : new Response("SECRET", { status: 200 })
    );

    await expect(
      fetchWebhook("https://hooks.example.com/x", { method: "POST", body: "{}" }, {
        lookup: publicAnswer,
      })
    ).rejects.toThrow(WebhookTargetError);
    // The second hop must never have been attempted.
    expect(calls).toHaveLength(1);
  });

  it("re-resolves each hop, so a public redirect target that points inward fails", async () => {
    stubFetch((url) =>
      url.includes("first.example.com")
        ? new Response(null, { status: 307, headers: { location: "https://second.example.com/x" } })
        : new Response("SECRET", { status: 200 })
    );
    const lookup: AddressLookup = async (host) =>
      host === "first.example.com"
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];

    await expect(
      fetchWebhook("https://first.example.com/x", { method: "POST", body: "{}" }, { lookup })
    ).rejects.toThrow(/private address/);
  });

  it("follows a legitimate redirect and caps the chain", async () => {
    const calls = stubFetch((url) =>
      url.endsWith("/a")
        ? new Response(null, { status: 301, headers: { location: "/b" } })
        : new Response("ok", { status: 200 })
    );
    const res = await fetchWebhook(
      "https://hooks.example.com/a",
      { method: "POST", body: "{}" },
      { lookup: publicAnswer }
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual(["https://hooks.example.com/a", "https://hooks.example.com/b"]);

    stubFetch(() => new Response(null, { status: 302, headers: { location: "/loop" } }));
    await expect(
      fetchWebhook("https://hooks.example.com/loop", { method: "POST", body: "{}" }, {
        lookup: publicAnswer,
      })
    ).rejects.toThrow(/Too many redirects/);
  });

  it("asks undici not to follow redirects on our behalf", async () => {
    let seen: RequestInit | undefined;
    stubFetch((_url, init) => {
      seen = init;
      return new Response("ok", { status: 200 });
    });
    await fetchWebhook("https://hooks.example.com/x", { method: "POST" }, {
      lookup: publicAnswer,
    });
    expect(seen?.redirect).toBe("manual");
  });
});
