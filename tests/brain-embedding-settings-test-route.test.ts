import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { AuthError } from "@/lib/auth/session";
import { EMBEDDING_DIMENSIONS } from "@/lib/db/schema";

/**
 * The "Test" endpoint is the operator's safety net: it embeds a tiny sample with the key
 * about to be saved (or the stored one) and REPORTS the width the model returns BEFORE a
 * backfill ever runs. There is no expected width — every OpenRouter model has its own. It
 * is master-gated, it never echoes the key, and every failure — bad CSRF, upstream error —
 * comes back as a soft `{ok:false}` with a 200 so the UI can render it inline. The width is
 * auto-detected via `detect.ts`, which builds the provider (mocked here) in auto mode.
 */

vi.mock("@/lib/auth/api-key", () => ({ requireMasterOrApiKey: vi.fn() }));
vi.mock("@/lib/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/security")>();
  return { ...actual, validateCsrf: vi.fn() };
});
vi.mock("@/lib/brain/embedding/config", () => ({ loadEmbeddingConfig: vi.fn() }));
vi.mock("@/lib/brain/embedding/openrouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/brain/embedding/openrouter")>();
  return { ...actual, OpenRouterEmbeddingProvider: vi.fn() };
});

const { requireMasterOrApiKey } = await import("@/lib/auth/api-key");
const { validateCsrf } = await import("@/lib/security");
const { loadEmbeddingConfig } = await import("@/lib/brain/embedding/config");
const { OpenRouterEmbeddingProvider, OpenRouterEmbeddingError } = await import(
  "@/lib/brain/embedding/openrouter"
);
const { POST } = await import("@/app/api/brain/embedding-settings/test/route");

const STORED = {
  provider: "openrouter" as const,
  model: "openai/text-embedding-3-small",
  dimensions: EMBEDDING_DIMENSIONS,
  enabled: true,
  apiKey: "sk-or-stored-key",
};

/** A width-N vector, for a well-formed provider reply. */
function vectorOf(dims: number): Float32Array {
  return Float32Array.from({ length: dims }, () => 0.1);
}

/** Point the mocked provider constructor at a given embed() behaviour. */
function stubProvider(embed: (texts: string[]) => Promise<Float32Array[]>) {
  vi.mocked(OpenRouterEmbeddingProvider).mockImplementation(
    () => ({ embed }) as unknown as InstanceType<typeof OpenRouterEmbeddingProvider>
  );
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/brain/embedding-settings/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(requireMasterOrApiKey).mockReset().mockResolvedValue({} as never);
  vi.mocked(validateCsrf).mockReset().mockResolvedValue(true);
  vi.mocked(loadEmbeddingConfig).mockReset().mockResolvedValue(STORED);
  vi.mocked(OpenRouterEmbeddingProvider).mockReset();
  stubProvider(async () => [vectorOf(EMBEDDING_DIMENSIONS)]);
});

describe("POST /api/brain/embedding-settings/test", () => {
  it("reports a correct-width embedding as ok, echoing the model but never the key", async () => {
    const res = await POST(postRequest({ apiKey: "sk-or-typed-secret", model: "m" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toEqual({ ok: true, model: "m", dimensions: EMBEDDING_DIMENSIONS });
    // The typed key is validated but must never come back out.
    expect(JSON.stringify(json)).not.toContain("typed-secret");
  });

  it("validates the just-typed key in preference to the stored one", async () => {
    await POST(postRequest({ apiKey: "sk-or-typed-secret" }));
    const arg = vi.mocked(OpenRouterEmbeddingProvider).mock.calls[0][0];
    expect(arg.apiKey).toBe("sk-or-typed-secret");
    // Auto-detect mode: the probe pins NO width, so it accepts whatever the model returns.
    expect(arg.dimensions).toBeNull();
  });

  it("falls back to the stored key when the field is left blank", async () => {
    await POST(postRequest({ model: "m" }));
    const arg = vi.mocked(OpenRouterEmbeddingProvider).mock.calls[0][0];
    expect(arg.apiKey).toBe("sk-or-stored-key");
  });

  it("rejects an invalid CSRF token as a soft failure without embedding", async () => {
    vi.mocked(validateCsrf).mockResolvedValue(false);
    const res = await POST(postRequest({ apiKey: "sk-or-x" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.ok).toBe(false);
    expect(requireMasterOrApiKey).not.toHaveBeenCalled();
    expect(OpenRouterEmbeddingProvider).not.toHaveBeenCalled();
  });

  it("is master-gated: a non-master caller never embeds", async () => {
    vi.mocked(requireMasterOrApiKey).mockRejectedValue(new AuthError("Forbidden", 403));
    const res = await POST(postRequest({ apiKey: "sk-or-x" }));
    expect(res.status).toBe(403);
    expect(OpenRouterEmbeddingProvider).not.toHaveBeenCalled();
  });

  it("reports ok:false when there is no key to test at all", async () => {
    vi.mocked(loadEmbeddingConfig).mockResolvedValue({ ...STORED, apiKey: null });
    const res = await POST(postRequest({ model: "m" }));
    const json = await res.json();
    expect(json.data.ok).toBe(false);
    expect(json.data.error).toMatch(/no api key/i);
    expect(OpenRouterEmbeddingProvider).not.toHaveBeenCalled();
  });

  it("reports a model's non-standard native width as ok, enabling non-1536 models", async () => {
    // The whole point of the fix: a model like voyage-code-4 returns 1024-d vectors, and
    // Test must report that width as a success rather than rejecting it.
    stubProvider(async () => [vectorOf(1024)]);
    const res = await POST(postRequest({ apiKey: "sk-or-x", model: "voyageai/voyage-code-4" }));
    const json = await res.json();
    expect(json.data.ok).toBe(true);
    expect(json.data.dimensions).toBe(1024);
    expect(json.data.model).toBe("voyageai/voyage-code-4");
  });

  it("reports an empty embedding as a soft failure the operator can see", async () => {
    stubProvider(async () => [vectorOf(0)]);
    const res = await POST(postRequest({ apiKey: "sk-or-x" }));
    const json = await res.json();
    expect(json.data.ok).toBe(false);
    expect(json.data.error).toMatch(/empty vector/i);
  });

  it("maps an upstream provider error to a soft failure, never echoing the key", async () => {
    stubProvider(async () => {
      throw new OpenRouterEmbeddingError("HTTP 401: invalid api key", 401);
    });
    const res = await POST(postRequest({ apiKey: "sk-or-super-secret" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.ok).toBe(false);
    expect(json.data.error).toMatch(/invalid api key/);
    expect(JSON.stringify(json)).not.toContain("super-secret");
  });
});
