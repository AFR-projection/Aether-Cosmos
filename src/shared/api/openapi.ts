import { appPublicUrl } from "@/shared/lib/env/runtime";
import { API_V1_ENDPOINTS } from "@/shared/api/v1-docs";
import { MASTER_API_ENDPOINTS } from "@/shared/api/master-v1-docs";
import { APP_NAME } from "@/shared/lib/app-version";

export function buildOpenApiSpec(includeAdmin = false) {
  const baseUrl = appPublicUrl() || "https://aether.example.com";
  const endpoints = includeAdmin
    ? [...API_V1_ENDPOINTS, ...MASTER_API_ENDPOINTS.filter((e) => e.path.startsWith("/api/admin"))]
    : API_V1_ENDPOINTS;

  const paths: Record<string, Record<string, unknown>> = {};

  for (const ep of endpoints) {
    const pathKey = ep.path.replace(/:id/g, "{id}");
    if (!paths[pathKey]) paths[pathKey] = {};

    paths[pathKey][ep.method.toLowerCase()] = {
      summary: ep.description,
      operationId: `${ep.method.toLowerCase()}${pathKey.replace(/[^a-zA-Z0-9]/g, "_")}`,
      tags: ep.path.startsWith("/api/admin") ? ["Admin"] : ["Storage"],
      security: [{ bearerAuth: [] }],
      responses: {
        "200": { description: "Success" },
        "401": { description: "Unauthorized" },
        "403": { description: "Missing scope" },
      },
    };
  }

  return {
    openapi: "3.0.3",
    info: {
      title: includeAdmin ? `${APP_NAME} — Master API` : `${APP_NAME} API`,
      version: "1.0.0",
      description: includeAdmin
        ? "Full platform API including admin routes. Requires skm_ master key with appropriate scopes."
        : "Storage API for files, folders, search, and upload. Requires sk_ API key.",
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Bearer sk_… (user) or skm_… (master)",
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths,
  };
}
