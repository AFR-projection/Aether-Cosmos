import { NextRequest } from "next/server";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { validateCsrf } from "@/shared/lib/security";
import { requireBrainContext } from "@brain/infrastructure/access";
import { enforceBrainRateLimit, requireUuid } from "@brain/infrastructure/http";
import { logBrainAudit } from "@brain/infrastructure/audit";
import {
  optionalJsonBody,
  responseFormat,
  sessionStartBodySchema,
  textResponse,
} from "@brain/infrastructure/session-http";
import { buildSessionStart } from "@brain/application/queries/session";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * POST /api/brain/[id]/session/start — the context an agent should already have before
 * its first turn.
 *
 * This is the endpoint that makes the brain *active*. MCP cannot push into a running
 * conversation, so the push has to come from the client: a SessionStart hook calls this
 * once and prints the answer, and the host prepends it to the system prompt. The agent
 * therefore begins knowing the standing rules without having decided to look them up —
 * which is the whole difference between a memory and a database.
 *
 * `brain.read`, not `brain.search`: the payload is the brain's own standing instructions
 * plus recent context, which is what a read grant is for.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const brainId = requireUuid((await params).id, "id");
    const { userId, brain, principal } = await requireBrainContext(request, brainId, [
      "brain.read",
    ]);
    await enforceBrainRateLimit(userId, "session", 3);

    const body = sessionStartBodySchema.parse(await optionalJsonBody(request));
    const session = await buildSessionStart({
      brainId,
      brainName: brain.name,
      sessionId: body.sessionId,
      topic: body.topic,
      projectId: body.projectId,
      charBudget: body.charBudget,
    });

    await logBrainAudit({
      brainId,
      principalType: principal.type,
      principalId: principal.id,
      operation: "session.start",
      resourceType: "session",
      resourceId: session.sessionId,
      metadata: {
        agent: principal.agentName,
        topic: session.topic,
        directives: session.directiveCount,
        memories: session.memoryIds.length,
      },
    });

    if (responseFormat(request) === "text") return textResponse(session.text);

    return apiSuccess({
      sessionId: session.sessionId,
      brain: { id: brain.id, name: brain.name },
      projectId: session.projectId,
      topic: session.topic,
      directiveCount: session.directiveCount,
      // The client carries this back as `exclude` on every turn: that is what keeps the
      // per-turn payload from repeating what the agent was already shown here.
      memoryIds: session.memoryIds,
      text: session.text,
      recall: session.recall,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
