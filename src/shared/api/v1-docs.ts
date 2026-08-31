import { appPublicUrl } from "@/shared/lib/env/runtime";
import { API_KEY_SCOPE_LABELS, type ApiKeyScope } from "@/shared/lib/auth/api-key";

export type ApiEndpointDoc = {
  method: string;
  path: string;
  scope: ApiKeyScope;
  description: string;
};

export const API_V1_ENDPOINTS: ApiEndpointDoc[] = [
  {
    method: "GET",
    path: "/api/v1/me",
    scope: "read",
    description: "Verify API key and inspect account + granted scopes",
  },
  {
    method: "GET",
    path: "/api/v1/docs",
    scope: "read",
    description: "Machine-readable API reference",
  },
  {
    method: "GET",
    path: "/api/files",
    scope: "read",
    description: "List files (supports folderId, cursor pagination)",
  },
  {
    method: "GET",
    path: "/api/files/:id",
    scope: "read",
    description: "Get file metadata and note content",
  },
  {
    method: "GET",
    path: "/api/folders",
    scope: "read",
    description: "List accessible folders",
  },
  {
    method: "GET",
    path: "/api/search",
    scope: "read",
    description: "Search files by name, content, mime type, size, date",
  },
  {
    method: "POST",
    path: "/api/upload/presign",
    scope: "upload",
    description: "Get presigned URL for single file upload",
  },
  {
    method: "POST",
    path: "/api/upload/presign-batch",
    scope: "upload",
    description: "Get presigned URLs for batch upload",
  },
  {
    method: "POST",
    path: "/api/upload/complete",
    scope: "upload",
    description: "Finalize single upload after R2 PUT",
  },
  {
    method: "POST",
    path: "/api/upload/complete-batch",
    scope: "upload",
    description: "Finalize batch upload",
  },
  {
    method: "GET",
    path: "/api/download/:id",
    scope: "download",
    description: "Download a file (redirects to presigned URL or streams)",
  },
  {
    method: "POST",
    path: "/api/download/zip",
    scope: "download",
    description: "Download multiple files as a zip archive",
  },
  {
    method: "PATCH",
    path: "/api/files",
    scope: "write",
    description: "Rename, move, favorite, restore, duplicate files",
  },
  {
    method: "PUT",
    path: "/api/files/:id",
    scope: "write",
    description: "Update note content and annotations",
  },
  {
    method: "DELETE",
    path: "/api/files",
    scope: "delete",
    description: "Soft delete a file",
  },
  {
    method: "DELETE",
    path: "/api/files/batch",
    scope: "delete",
    description: "Permanently delete multiple files",
  },
];

export function buildApiV1Docs() {
  const baseUrl = appPublicUrl() || "https://your-domain.com";

  return {
    version: "1.0",
    baseUrl,
    authentication: {
      type: "bearer",
      header: "Authorization: Bearer sk_<your-api-key>",
      format: "sk_ followed by a 40-character secret",
      csrf: "Not required for Bearer API key requests",
    },
    scopes: API_KEY_SCOPE_LABELS,
    endpoints: API_V1_ENDPOINTS,
    quickStart: {
      verify: `curl -s "${baseUrl}/api/v1/me" -H "Authorization: Bearer sk_YOUR_KEY"`,
      listFiles: `curl -s "${baseUrl}/api/files" -H "Authorization: Bearer sk_YOUR_KEY"`,
      search: `curl -s "${baseUrl}/api/search?q=report" -H "Authorization: Bearer sk_YOUR_KEY"`,
    },
    aiAgentConfig: {
      api_url: baseUrl,
      api_key: "sk_YOUR_KEY",
      auth_header: "Authorization: Bearer sk_YOUR_KEY",
      verify_endpoint: `${baseUrl}/api/v1/me`,
      docs_endpoint: `${baseUrl}/api/v1/docs`,
      instructions:
        "Use Bearer token authentication. Call GET /api/v1/me first to verify the key and see granted scopes.",
    },
  };
}

export function buildAiAgentPrompt(apiKey: string): string {
  const docs = buildApiV1Docs();
  return [
    "Storage API connection:",
    `- Base URL: ${docs.baseUrl}`,
    `- API Key: ${apiKey}`,
    `- Auth: Authorization: Bearer ${apiKey}`,
    `- Verify: GET ${docs.baseUrl}/api/v1/me`,
    `- Docs: GET ${docs.baseUrl}/api/v1/docs`,
    "",
    "Always send the Authorization header on every request.",
    "Check /api/v1/me to confirm which scopes this key has before calling other endpoints.",
  ].join("\n");
}
