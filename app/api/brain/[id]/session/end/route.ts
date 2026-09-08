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
 * POST /api/brain/[id]/session/end — the conversation is over; keep what was worth keeping.
 *
 * The other half of `session/start`, and the only path in this codebase where the brain
 * decides for itself what to write down. Because of that it is gated on its own scope,
 * `brain.ingest`, which `brain.write` deliberately does not imply: an agent that could
 * already save memories does not silently acquire the ability to save them unasked.
 *
 * Everything that makes automatic writeback safe is in `ingestCandidates` — salience,
 * sampling, an importance floor, fuzzy dedupe, a hard write budget, and a merge that never
 * destroys. This route only carries a transcript in and a report out. `commit: false` runs
 * every one of those gates and writes nothing, which is the honest way to see what a hook
 * would do before letting it do it.
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
      operation: "session.end",
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
