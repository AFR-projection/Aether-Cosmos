import { NextRequest } from "next/server";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { validateCsrf } from "@/shared/lib/security";
import { requireBrainContext } from "@brain/infrastructure/access";
import { enforceBrainRateLimit, requireUuid } from "@brain/infrastructure/http";
import {
  optionalJsonBody,
  responseFormat,
  sessionTurnBodySchema,
  textResponse,
} from "@brain/infrastructure/session-http";
import { buildSessionTurn } from "@brain/application/queries/session";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * POST /api/brain/[id]/session/turn — what the brain knows about *this* prompt.
 *
 * The one endpoint here that runs on every single user message, which decides everything
 * about it:
 *
 * - **It usually answers with nothing.** No match, or nothing the agent has not already
 *   been shown, and the body is empty. A hook that prints nothing costs zero tokens, so
 *   the common turn is free rather than merely cheap.
 * - **It is not audited.** One row per prompt would bury the audit trail — the thing a
 *   user reads to find out what an agent *did* — under thousands of rows recording that a
 *   search happened. `session.start` and `session.end` bracket the conversation; the
 *   memories written at the end are the durable record of what came out of it.
 * - **Precision over recall.** Matching is AND across the prompt's terms. A payload
 *   nobody asked for is worse than no payload: the agent cannot tell that the brain
 *   guessed, so a wrong memory here becomes a wrong premise in the answer.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const brainId = requireUuid((await params).id, "id");
    const { userId } = await requireBrainContext(request, brainId, ["brain.search"]);
    await enforceBrainRateLimit(userId, "session", 1);

    const body = sessionTurnBodySchema.parse(await optionalJsonBody(request));
    const turn = await buildSessionTurn({
      brainId,
      sessionId: body.sessionId,
      prompt: body.prompt,
      exclude: body.exclude,
      projectId: body.projectId,
      limit: body.limit,
    });

    if (responseFormat(request) === "text") return textResponse(turn.text);

    return apiSuccess({
      sessionId: turn.sessionId,
      memoryIds: turn.memoryIds,
      memories: turn.memories,
      text: turn.text,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
