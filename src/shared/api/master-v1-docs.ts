import { appPublicUrl } from "@/shared/lib/env/runtime";
import { MASTER_SCOPE_LABELS } from "@/shared/lib/auth/api-key";

export const MASTER_API_ENDPOINTS = [
  { method: "GET", path: "/api/v1/me", scope: "read", description: "Verify key and inspect granted powers" },
  { method: "GET", path: "/api/v1/docs", scope: "read", description: "Storage API reference" },
  { method: "GET", path: "/api/admin/stats", scope: "admin:stats", description: "Platform statistics" },
  { method: "GET", path: "/api/admin/users", scope: "admin:users", description: "List all users" },
  { method: "POST", path: "/api/admin/users", scope: "admin:users", description: "Create user" },
  { method: "PATCH", path: "/api/admin/users", scope: "admin:users", description: "Update user" },
  { method: "DELETE", path: "/api/admin/users", scope: "admin:users", description: "Delete user" },
  { method: "GET", path: "/api/admin/settings", scope: "admin:settings", description: "Read platform settings" },
  { method: "PATCH", path: "/api/admin/settings", scope: "admin:settings", description: "Update platform settings" },
  { method: "GET", path: "/api/admin/monitoring", scope: "admin:monitoring", description: "System monitoring data" },
  { method: "GET", path: "/api/admin/shares", scope: "admin:shares", description: "All share links" },
  { method: "DELETE", path: "/api/admin/shares", scope: "admin:shares", description: "Revoke share links" },
  { method: "GET", path: "/api/admin/email/senders", scope: "admin:email", description: "Gmail senders" },
  { method: "GET", path: "/api/files", scope: "full", description: "List all accessible files" },
  { method: "GET", path: "/api/search", scope: "read", description: "Search files platform-wide" },
] as const;

export function buildMasterApiDocs() {
  const baseUrl = appPublicUrl() || "https://your-domain.com";

  return {
    version: "1.0-master",
    tier: "master",
    baseUrl,
    authentication: {
      type: "bearer",
      header: "Authorization: Bearer skm_<your-master-key>",
      format: "skm_ followed by a 40-character secret (master-only prefix)",
      note: "Master keys (skm_) are separate from user keys (sk_). Only master accounts can create them.",
    },
    scopes: MASTER_SCOPE_LABELS,
    supremeScope: {
      name: "supreme",
      description: "Grants every storage + admin permission. The highest authority level.",
    },
    endpoints: MASTER_API_ENDPOINTS,
    quickStart: {
      verify: `curl -s "${baseUrl}/api/v1/me" -H "Authorization: Bearer skm_YOUR_KEY"`,
      stats: `curl -s "${baseUrl}/api/admin/stats" -H "Authorization: Bearer skm_YOUR_KEY"`,
      users: `curl -s "${baseUrl}/api/admin/users" -H "Authorization: Bearer skm_YOUR_KEY"`,
    },
  };
}

export function buildMasterAiPrompt(apiKey: string): string {
  const docs = buildMasterApiDocs();
  return [
    "MASTER Storage Platform API — SUPREME ACCESS",
    `- Base URL: ${docs.baseUrl}`,
    `- Master API Key: ${apiKey}`,
    `- Auth: Authorization: Bearer ${apiKey}`,
    `- Verify: GET ${docs.baseUrl}/api/v1/me`,
    `- Admin Stats: GET ${docs.baseUrl}/api/admin/stats`,
    `- Admin Users: GET ${docs.baseUrl}/api/admin/users`,
    "",
    "This is a MASTER key with elevated platform permissions.",
    "Scope 'supreme' grants unrestricted access to all storage + admin APIs.",
    "Always send Authorization header. Never expose this key publicly.",
  ].join("\n");
}
