/**
 * Temporal Edges Admin API Route
 *
 * POST /api/admin/brain/:brainId/temporal-edges
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import {
  detectAllTemporalEdges,
  updateTemporalEdgesForMemory,
} from "@/lib/brain/graph/temporal-edges";

async function requireAdmin() {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { brainId: string } }
) {
  const authError = await requireAdmin();
  if (authError) return authError;

  try {
    const { brainId } = params;
    const body = await request.json();

    if (body.memoryId) {
      // Incremental update for single memory
      const edgesCreated = await updateTemporalEdgesForMemory(
        body.memoryId,
        body.config
      );

      return NextResponse.json({
        mode: "incremental",
        memoryId: body.memoryId,
        edgesCreated,
      });
    } else {
      // Full detection for entire brain
      const result = await detectAllTemporalEdges(brainId, body.config);

      return NextResponse.json({
        mode: "full",
        brainId,
        ...result,
      });
    }
  } catch (error) {
    console.error("Temporal edge detection failed:", error);
    return NextResponse.json(
      {
        error: "Detection failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
