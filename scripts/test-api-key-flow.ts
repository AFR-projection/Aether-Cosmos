/**
 * API key smoke test — uses DB directly (no session login needed).
 * Usage: npx tsx scripts/test-api-key-flow.ts [baseUrl]
 */
import "./load-env";
import { eq } from "drizzle-orm";
import { db } from "../lib/db";
import { users } from "../lib/db/schema";
import {
  authenticateApiKey,
  createApiKey,
  createMasterApiKey,
  deleteApiKey,
  deleteMasterApiKey,
  keyHasScope,
  keyHasAdminArea,
} from "../lib/auth/api-key";

const BASE = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");

function assert(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ✓ ${name}`);
    return;
  }
  console.error(`  ✗ ${name}${detail ? `: ${detail}` : ""}`);
  process.exitCode = 1;
}

async function main() {
  console.log(`\nAPI Key smoke test → ${BASE}\n`);

  const [user] = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(eq(users.status, "active"))
    .limit(1);

  if (!user) {
    console.error("No active user in database — cannot run test");
    process.exit(1);
  }

  console.log(`Using user: ${user.username}\n`);

  // ── Unit-level auth tests ──
  const key = await createApiKey(user.id, "smoke-test", ["read", "upload", "download", "write"]);
  assert("createApiKey returns sk_ prefix", key.rawKey.startsWith("sk_"));

  const session = await authenticateApiKey(key.rawKey, ["read"]);
  assert("authenticateApiKey succeeds", session.authMethod === "api_key");
  assert("keyHasScope read", keyHasScope(session.apiKeyScopes, "read"));
  assert("keyHasScope upload", keyHasScope(session.apiKeyScopes, "upload"));

  try {
    await authenticateApiKey(key.rawKey, ["delete"]);
    assert("missing scope throws", false, "should have thrown 403");
  } catch (e) {
    assert("missing delete scope → 403", e instanceof Error && e.message.includes("Missing scope"));
  }

  // ── HTTP tests with Bearer token ──
  async function api(path: string, bearer?: string) {
    const headers: Record<string, string> = {};
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const res = await fetch(`${BASE}${path}`, { headers });
    const json = await res.json();
    return { status: res.status, json };
  }

  const me = await api("/api/v1/me", key.rawKey);
  assert(
    "GET /api/v1/me",
    me.status === 200 && me.json.success && me.json.data?.connected === true,
    me.json.error
  );

  const docs = await api("/api/v1/docs", key.rawKey);
  assert("GET /api/v1/docs", docs.status === 200 && docs.json.success, docs.json.error);

  const connect = await api("/api/v1/connect", key.rawKey);
  assert(
    "GET /api/v1/connect",
    connect.status === 200 &&
      connect.json.success &&
      connect.json.data?.mcp?.remoteUrl?.includes("/api/mcp"),
    connect.json.error
  );

  const files = await api("/api/files?limit=1", key.rawKey);
  assert("GET /api/files", files.status === 200 && files.json.success, files.json.error);

  const folders = await api("/api/folders", key.rawKey);
  assert("GET /api/folders", folders.status === 200 && folders.json.success, folders.json.error);

  const search = await api("/api/search?limit=1", key.rawKey);
  assert("GET /api/search", search.status === 200 && search.json.success, search.json.error);

  const bad = await api("/api/v1/me", "sk_totally_invalid_key_12345678901234567890");
  assert("Invalid key → 401", bad.status === 401, `got ${bad.status}`);

  const noAuth = await api("/api/v1/me");
  assert("No auth → 401", noAuth.status === 401, `got ${noAuth.status}`);

  // ── Cleanup ──
  const deleted = await deleteApiKey(user.id, key.id);
  assert("deleteApiKey", deleted);

  const after = await api("/api/v1/me", key.rawKey);
  assert("Revoked key → 401", after.status === 401, `got ${after.status}`);

  // ── Master key tests ──
  const [master] = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(eq(users.role, "master"))
    .limit(1);

  if (master) {
    console.log(`\nMaster tests (${master.username}):\n`);
    const mkey = await createMasterApiKey(master.id, "smoke-master", ["supreme"]);
    assert("createMasterApiKey returns skm_ prefix", mkey.rawKey.startsWith("skm_"));
    assert("keyHasAdminArea users", keyHasAdminArea(mkey.scopes, "users"));
    assert("keyHasScope supreme → read", keyHasScope(mkey.scopes, "read"));

    const mMe = await api("/api/v1/me", mkey.rawKey);
    assert(
      "GET /api/v1/me (master)",
      mMe.status === 200 && mMe.json.data?.tier === "master",
      mMe.json.error
    );

    const stats = await api("/api/admin/stats", mkey.rawKey);
    assert("GET /api/admin/stats (supreme)", stats.status === 200 && stats.json.success, stats.json.error);

    const usersApi = await api("/api/admin/users", mkey.rawKey);
    assert("GET /api/admin/users (supreme)", usersApi.status === 200 && usersApi.json.success, usersApi.json.error);

    await deleteMasterApiKey(master.id, mkey.id);
    const mAfter = await api("/api/v1/me", mkey.rawKey);
    assert("Revoked master key → 401", mAfter.status === 401, `got ${mAfter.status}`);
  } else {
    console.log("\n(no master account — skipping master key tests)\n");
  }

  console.log("\n" + (process.exitCode ? "FAILED" : "ALL TESTS PASSED") + "\n");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => process.exit(process.exitCode ?? 0));
