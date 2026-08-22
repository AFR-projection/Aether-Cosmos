/**
 * The application version, safe to import from client components.
 *
 * Kept as a literal rather than read from `package.json` so it never pulls the
 * whole manifest (including the dependency list) into the browser bundle.
 * `lib/app-version.test.ts` fails if this drifts from `package.json`, so
 * `package.json` remains the single place a release is declared.
 *
 * Release history:
 *   0.1 — storage, upload, Cloudflare R2
 *   0.2 — auth, mail router, sharing
 *   0.3 — Second Brain 1.0 (memories, knowledge graph, MCP server)
 *   0.4 — Second Brain 2.0 (retrieval, enrichment, context engine, health, provenance)
 */
export const APP_VERSION = "0.4.0";

/** Display form, e.g. for a settings row or an about dialog. */
export const APP_VERSION_LABEL = `v${APP_VERSION}`;
