import { describe, it, expect } from "vitest";
import { validateWebhookUrl, generateWebhookSecret } from "@/shared/infrastructure/webhooks/manage";

describe("validateWebhookUrl — SSRF / format guard", () => {
  it("accepts https URLs", () => {
    const r = validateWebhookUrl("https://example.com/hook");
    expect(r.ok).toBe(true);
  });

  it("accepts http only for loopback (local dev)", () => {
    expect(validateWebhookUrl("http://localhost:3000/hook").ok).toBe(true);
    expect(validateWebhookUrl("http://127.0.0.1/hook").ok).toBe(true);
  });

  it("rejects http to non-loopback hosts", () => {
    expect(validateWebhookUrl("http://example.com/hook").ok).toBe(false);
  });

  it("rejects the cloud metadata endpoint", () => {
    expect(validateWebhookUrl("http://169.254.169.254/latest/meta-data").ok).toBe(false);
    expect(validateWebhookUrl("https://169.254.169.254/").ok).toBe(false);
  });

  it("rejects .internal hosts", () => {
    expect(validateWebhookUrl("https://db.internal/hook").ok).toBe(false);
  });

  it("rejects non-http schemes and garbage", () => {
    expect(validateWebhookUrl("ftp://example.com").ok).toBe(false);
    expect(validateWebhookUrl("javascript:alert(1)").ok).toBe(false);
    expect(validateWebhookUrl("not a url").ok).toBe(false);
  });
});

describe("generateWebhookSecret", () => {
  it("has the whsec_ prefix and is reasonably long", () => {
    const s = generateWebhookSecret();
    expect(s.startsWith("whsec_")).toBe(true);
    expect(s.length).toBeGreaterThan(24);
  });

  it("is unique per call", () => {
    expect(generateWebhookSecret()).not.toBe(generateWebhookSecret());
  });
});
