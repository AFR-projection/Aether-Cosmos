import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { AuthError } from "@/lib/auth/session";

/**
 * The route is a thin, SECURITY-critical shell over the config service: it must reject a
 * missing CSRF token and a non-master caller before touching anything, must never let the
 * client set the width (the server auto-detects it), and must return the scrubbed public
 * shape — never the key. The service itself is unit-tested in config.test.ts; here every
 * DB- or network-touching dependency is mocked so the test exercises only the route's own
 * guard rails.
 */

vi.mock("@/lib/auth/api-key", () => ({ requireMasterOrApiKey: vi.fn() }));
vi.mock("@/lib/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/security")>();
  return { ...actual, validateCsrf: vi.fn() };
});
vi.mock("@/lib/brain/embedding/config", () => ({
  getPublicEmbeddingConfig: vi.fn(),
  updateEmbeddingConfig: vi.fn(),
  loadEmbeddingConfig: vi.fn(),
  clearStoredEmbeddings: vi.fn(),
}));
vi.mock("@/lib/brain/embedding/detect", () => ({ detectEmbeddingDimension: vi.fn() }));

const { requireMasterOrApiKey } = await import("@/lib/auth/api-key");
const { validateCsrf } = await import("@/lib/security");
const { getPublicEmbeddingConfig, updateEmbeddingConfig, loadEmbeddingConfig, clearStoredEmbeddings } =
  await import("@/lib/brain/embedding/config");
const { detectEmbeddingDimension } = await import("@/lib/brain/embedding/detect");
const { GET, PUT } = await import("@/app/api/brain/embedding-settings/route");

const PUBLIC_SHAPE = {
  provider: "openrouter",
  model: "openai/text-embedding-3-small",
  dimensions: 1536,
  enabled: true,
  hasApiKey: true,
};

/** The server-side config loadEmbeddingConfig returns (starts disabled, with a stored key). */
const STORED_CONFIG = {
  provider: "openrouter",
  model: "openai/text-embedding-3-small",
  dimensions: 1536,
  enabled: false,
  apiKey: "sk-or-stored",
};

function putRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/brain/embedding-settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(requireMasterOrApiKey).mockReset().mockResolvedValue({} as never);
  vi.mocked(validateCsrf).mockReset().mockResolvedValue(true);
  vi.mocked(getPublicEmbeddingConfig).mockReset().mockResolvedValue(PUBLIC_SHAPE);
  vi.mocked(updateEmbeddingConfig).mockReset().mockResolvedValue(PUBLIC_SHAPE);
  vi.mocked(loadEmbeddingConfig).mockReset().mockResolvedValue({ ...STORED_CONFIG });
  vi.mocked(clearStoredEmbeddings).mockReset().mockResolvedValue(0);
  vi.mocked(detectEmbeddingDimension).mockReset().mockResolvedValue(1536);
});

describe("GET /api/brain/embedding-settings", () => {
  it("returns the scrubbed public config for a master caller", async () => {
    const res = await GET(new NextRequest("http://localhost/api/brain/embedding-settings"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual(PUBLIC_SHAPE);
    // The response body can never carry the secret — only whether one exists.
    expect(json.data).not.toHaveProperty("apiKey");
    expect(JSON.stringify(json)).not.toMatch(/apiKey/);
  });

  it("is master-gated: a non-master caller never reaches the config", async () => {
    vi.mocked(requireMasterOrApiKey).mockRejectedValue(new AuthError("Forbidden", 403));
    const res = await GET(new NextRequest("http://localhost/api/brain/embedding-settings"));
    expect(res.status).toBe(403);
    expect(getPublicEmbeddingConfig).not.toHaveBeenCalled();
  });
});

describe("PUT /api/brain/embedding-settings", () => {
  it("rejects a request with an invalid CSRF token before writing", async () => {
    vi.mocked(validateCsrf).mockResolvedValue(false);
    const res = await PUT(putRequest({ model: "m", enabled: true }));
    expect(res.status).toBe(403);
    // No auth check, no write: CSRF is the very first gate.
    expect(requireMasterOrApiKey).not.toHaveBeenCalled();
    expect(updateEmbeddingConfig).not.toHaveBeenCalled();
  });

  it("is master-gated: a non-master caller never writes", async () => {
    vi.mocked(requireMasterOrApiKey).mockRejectedValue(new AuthError("Forbidden", 403));
    const res = await PUT(putRequest({ enabled: true }));
    expect(res.status).toBe(403);
    expect(updateEmbeddingConfig).not.toHaveBeenCalled();
  });

  it("ignores a client-supplied width and stores the server-detected one instead", async () => {
    // A client that tries to set the dimension must be ignored; the width comes from
    // probing the model server-side, never from the request body.
    vi.mocked(detectEmbeddingDimension).mockResolvedValue(1024);
    const res = await PUT(
      putRequest({ provider: "openrouter", model: "voyageai/voyage-code-4", enabled: true, apiKey: "sk-or-x", dimensions: 42 })
    );
    expect(res.status).toBe(200);
    const arg = vi.mocked(updateEmbeddingConfig).mock.calls[0][0];
    expect(arg.provider).toBe("openrouter");
    expect(arg.model).toBe("voyageai/voyage-code-4");
    expect(arg.enabled).toBe(true);
    expect(arg.apiKey).toBe("sk-or-x");
    // The detected width is persisted; the client's bogus 42 never reaches the service.
    expect(arg.dimensions).toBe(1024);
    expect(arg.dimensions).not.toBe(42);
  });

  it("re-embeds: a changed model clears the stored vectors and reports it", async () => {
    // STORED_CONFIG.model is the default; switching to a voyage model at a new width means
    // the old vectors are unusable, so they are wiped and the client is told to backfill.
    vi.mocked(detectEmbeddingDimension).mockResolvedValue(1024);
    vi.mocked(clearStoredEmbeddings).mockResolvedValue(12);
    const res = await PUT(putRequest({ model: "voyageai/voyage-code-4", enabled: true, apiKey: "sk-or-x" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(clearStoredEmbeddings).toHaveBeenCalledTimes(1);
    expect(json.data.reembedRequired).toBe(true);
    expect(json.data.embeddingsCleared).toBe(12);
  });

  it("does not probe or clear when merely disabling", async () => {
    await PUT(putRequest({ enabled: false }));
    expect(detectEmbeddingDimension).not.toHaveBeenCalled();
    expect(clearStoredEmbeddings).not.toHaveBeenCalled();
    // A plain disable must not pass a width, leaving the stored one intact.
    const arg = vi.mocked(updateEmbeddingConfig).mock.calls[0][0];
    expect(arg.dimensions).toBeUndefined();
  });

  it("refuses to enable without any key rather than saving a broken config", async () => {
    // No stored key and none typed → 400, nothing written, no network probe.
    vi.mocked(loadEmbeddingConfig).mockResolvedValue({ ...STORED_CONFIG, apiKey: null });
    const res = await PUT(putRequest({ enabled: true }));
    expect(res.status).toBe(400);
    expect(detectEmbeddingDimension).not.toHaveBeenCalled();
    expect(updateEmbeddingConfig).not.toHaveBeenCalled();
  });

  it("surfaces a model-check failure as a 400 without writing", async () => {
    vi.mocked(detectEmbeddingDimension).mockRejectedValue(new Error("HTTP 401: invalid api key"));
    const res = await PUT(putRequest({ enabled: true, apiKey: "sk-or-bad" }));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toMatch(/invalid api key/);
    expect(updateEmbeddingConfig).not.toHaveBeenCalled();
  });

  it("returns the scrubbed public shape, never echoing the key just written", async () => {
    const res = await PUT(putRequest({ apiKey: "sk-or-super-secret", enabled: true }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toMatchObject(PUBLIC_SHAPE);
    expect(json.data).not.toHaveProperty("apiKey");
    expect(JSON.stringify(json)).not.toContain("super-secret");
  });

  it("omitting apiKey leaves it undefined so the stored key is untouched", async () => {
    await PUT(putRequest({ enabled: false }));
    const arg = vi.mocked(updateEmbeddingConfig).mock.calls[0][0];
    expect(arg.apiKey).toBeUndefined();
  });

  it("accepts an explicit null apiKey as a clear", async () => {
    await PUT(putRequest({ apiKey: null }));
    const arg = vi.mocked(updateEmbeddingConfig).mock.calls[0][0];
    expect(arg.apiKey).toBeNull();
  });

  it("rejects a non-openrouter provider at validation", async () => {
    const res = await PUT(putRequest({ provider: "acme" }));
    expect(res.status).toBe(400);
    expect(updateEmbeddingConfig).not.toHaveBeenCalled();
  });

  it("rejects an over-long API key at validation", async () => {
    const res = await PUT(putRequest({ apiKey: "s".repeat(401) }));
    expect(res.status).toBe(400);
    expect(updateEmbeddingConfig).not.toHaveBeenCalled();
  });
});
