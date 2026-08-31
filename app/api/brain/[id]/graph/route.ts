import { NextRequest } from "next/server";
import { z } from "zod";
import { apiSuccess, handleApiError } from "@/shared/api/response";
import { requireBrainContext } from "@brain/infrastructure/access";
import { enforceBrainRateLimit, requireUuid } from "@brain/infrastructure/http";
import {
  buildBrainGraphSnapshot,
  GRAPH_EDGE_LIMIT_DEFAULT,
  GRAPH_EDGE_LIMIT_MAX,
  GRAPH_NODE_LIMIT_DEFAULT,
  GRAPH_NODE_LIMIT_MAX,
} from "@brain/application/queries/graph-snapshot";

type RouteParams = { params: Promise<{ id: string }> };

const querySchema = z.object({
  /** `false` drops memory nodes and memory links, leaving the entity graph only. */
  includeMemories: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  nodeLimit: z.coerce.number().int().min(1).max(GRAPH_NODE_LIMIT_MAX).default(GRAPH_NODE_LIMIT_DEFAULT),
  edgeLimit: z.coerce.number().int().min(1).max(GRAPH_EDGE_LIMIT_MAX).default(GRAPH_EDGE_LIMIT_DEFAULT),
});

/**
 * GET /api/brain/[id]/graph — the whole graph in one bounded snapshot.
 *
 * Separate from /entities and /relationships on purpose: those are 100-row list
 * endpoints, and a force layout drawn from a 100-row page shows a graph that does
 * not exist. This one is rate-limited (a snapshot is several thousand rows, unlike
 * the other reads) and clamps its own caps so a hand-typed limit cannot ask for
 * the entire table.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const brainId = requireUuid((await params).id, "id");
    const { userId } = await requireBrainContext(request, brainId, ["brain.read"]);
    await enforceBrainRateLimit(userId, "graph", 2);

    const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const snapshot = await buildBrainGraphSnapshot({ brainId, ...query });

    return apiSuccess(snapshot);
  } catch (error) {
    return handleApiError(error);
  }
}
