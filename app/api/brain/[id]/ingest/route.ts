import { NextRequest } from "next/server";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { validateCsrf } from "@/shared/lib/security";
import { requireBrainContext } from "@brain/infrastructure/access";
import { enforceBrainRateLimit, requireUuid } from "@brain/infrastructure/http";
import { runBrainIngest } from "@brain/infrastructure/ingest-runner";
import {
  ingestBodySchema,
  optionalJsonBody,
  responseFormat,
  textResponse,
} from "@brain/infrastructure/session-http";
import { renderIngestReport } from "@brain/application/commands/ingest";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * POST /api/brain/[id]/ingest — writeback outside the session lifecycle.
 *
 * Identical machinery to `session/end`, different occasion. `session/end` is what a hook
 * fires when a conversation closes; this is for anything else that wants the same gates:
 * a mid-conversation flush, a batch of turns replayed from a log, or an agent that already
 * knows what it wants kept and sends `candidates` instead of a transcript.
 *
 * Same scope (`brain.ingest`), same clamps, same `commit: false` preview. The only visible
 * difference is the audit verb — `memory.ingest` rather than `session.end` — so the trail
 * distinguishes "a conversation ended and was harvested" from "something pushed material in".
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const brainId = requireUuid((await params).id, "id");
    const { userId, principal } = await requireBrainContext(request, brainId, ["brain.ingest"], {
      write: true,
    });
    await enforceBrainRateLimit(userId, "ingest", 5);

    const body = ingestBodySchema.parse(await optionalJsonBody(request));
    const report = await runBrainIngest({
      brainId,
      userId,
      principal,
      operation: "memory.ingest",
      turns: body.turns,
      candidates: body.candidates,
      options: {
        sessionId: body.sessionId,
        projectId: body.projectId,
        tags: body.tags,
        minSalience: body.minSalience,
        minImportance: body.minImportance,
        sampleRate: body.sampleRate,
        maxWrites: body.maxWrites,
        commit: body.commit,
      },
    });

    if (responseFormat(request) === "text") return textResponse(renderIngestReport(report));
    return apiSuccess({ report, text: renderIngestReport(report) });
  } catch (error) {
    return handleApiError(error);
  }
}
