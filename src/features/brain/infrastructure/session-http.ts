import type { NextRequest } from "next/server";
import { z } from "zod";
import { MEMORY_TYPES } from "@brain/domain/constants";
import { BrainValidationError } from "@brain/domain/errors";
import { TURN_ROLES } from "@brain/domain/ingest/salience";
import { MAX_CANDIDATES_PER_CALL, MAX_WRITES_PER_CALL } from "@brain/application/commands/ingest";
import { MAX_EXCLUDE } from "@brain/application/queries/session";

/**
 * The shared edge for the conversation-lifecycle and ingest routes.
 *
 * These endpoints are called by a *shell hook*, not by the web app, and that changes what
 * the edge has to do:
 *
 * - **`?format=text`.** A hook's contract with its host is stdout. Making the caller pipe
 *   JSON through `jq` to find the one string it needs is a footgun in a config file the
 *   user pastes once and never looks at again, so every lifecycle route can answer in
 *   plain text. `json` stays the default, because that is what the rest of the API does.
 * - **Shared schemas.** `session/end` and `ingest` take the same transcript and the same
 *   tuning knobs. A route file cannot export extra symbols (Next validates the module's
 *   exports), so the schemas live here rather than in whichever route defined them first.
 *
 * Nothing here authorizes anything: these routes go through `requireBrainContext` like
 * every other /api/brain route, so there is exactly one place that decides who may call.
 */

export type ResponseFormat = "text" | "json";

/**
 * `?format=text` wins if present; otherwise a client that only accepts `text/plain`
 * gets text. A curl with no Accept header gets `*​/*` and so gets JSON.
 */
export function responseFormat(request: NextRequest): ResponseFormat {
  const explicit = request.nextUrl.searchParams.get("format");
  if (explicit === "text") return "text";
  if (explicit === "json") return "json";

  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("text/plain") && !accept.includes("application/json")) return "text";
  return "json";
}

/**
 * Plain text, never cached. `no-store` matters: a session-start payload is specific to one
 * conversation, and a proxy replaying it into another one would be a cross-session leak.
 */
export function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** A hook-supplied session id. Free-form because `memories.source_id` is `text`. */
export const sessionIdSchema = z.string().trim().min(1).max(200);

export const conversationTurnSchema = z.object({
  role: z.enum(TURN_ROLES).default("user"),
  text: z.string().min(1).max(20_000),
});

/**
 * An explicit candidate: an agent that already knows what it wants kept can skip mining
 * and name the title and type itself.
 */
export const ingestCandidateSchema = z.object({
  title: z.string().trim().max(300).nullish(),
  content: z.string().min(1).max(20_000),
  type: z.enum(MEMORY_TYPES).nullish(),
  summary: z.string().trim().max(1000).nullish(),
  importance: z.number().min(0).max(1).nullish(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).nullish(),
  projectId: z.string().uuid().nullish(),
  role: z.enum(TURN_ROLES).nullish(),
  turnIndex: z.number().int().min(0).max(100_000).nullish(),
});

/**
 * The gates, as knobs. Every one of them can only make the pipeline *stricter* than its
 * default — the clamps that guarantee that live in `ingestCandidates`, so a caller cannot
 * widen them by talking to the route directly instead of the tool.
 */
export const ingestTuningSchema = z.object({
  projectId: z.string().uuid().nullish(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).nullish(),
  minSalience: z.number().min(0).max(1).optional(),
  minImportance: z.number().min(0).max(1).optional(),
  sampleRate: z.number().min(0).max(1).optional(),
  maxWrites: z.number().int().min(0).max(MAX_WRITES_PER_CALL).optional(),
  commit: z.boolean().optional(),
});

/** `turns` or `candidates` — at least one, and the transcript is bounded at the edge too. */
export const ingestBodySchema = ingestTuningSchema
  .extend({
    sessionId: sessionIdSchema.nullish(),
    turns: z.array(conversationTurnSchema).max(200).optional(),
    candidates: z.array(ingestCandidateSchema).max(MAX_CANDIDATES_PER_CALL).optional(),
  })
  .refine((body) => (body.turns?.length ?? 0) + (body.candidates?.length ?? 0) > 0, {
    message: "Provide at least one turn or candidate",
    path: ["turns"],
  });

export const sessionStartBodySchema = z.object({
  sessionId: sessionIdSchema.nullish(),
  topic: z.string().trim().max(500).nullish(),
  projectId: z.string().uuid().nullish(),
  charBudget: z.number().int().min(500).max(20_000).optional(),
});

export const sessionTurnBodySchema = z.object({
  sessionId: sessionIdSchema.nullish(),
  prompt: z.string().max(20_000),
  exclude: z.array(z.string().uuid()).max(MAX_EXCLUDE).optional(),
  projectId: z.string().uuid().nullish(),
  limit: z.number().int().min(1).max(5).optional(),
});

/** An absent body is an empty object: `session/turn` with no prompt is a valid no-op. */
export async function optionalJsonBody(request: NextRequest): Promise<unknown> {
  const raw = await request.text();
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Otherwise a malformed hook payload reads as a server fault instead of a client one.
    throw new BrainValidationError("Request body must be valid JSON");
  }
}
