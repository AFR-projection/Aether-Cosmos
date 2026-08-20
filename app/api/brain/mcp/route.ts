import { handleBrainMcpRequest } from "@/lib/brain/mcp/handler";

/**
 * POST /api/brain/mcp — the Second Brain MCP endpoint (Streamable HTTP).
 *
 * External agents (OpenClaw, Hermes, Claude Desktop, any MCP client) connect here
 * with `Authorization: Bearer sk_…` using an agent key minted under a brain.
 * Stateless, so no Mcp-Session-Id is issued or needed.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleBrainMcpRequest(request);
}

export async function POST(request: Request) {
  return handleBrainMcpRequest(request);
}

export async function DELETE(request: Request) {
  return handleBrainMcpRequest(request);
}

export async function OPTIONS(request: Request) {
  return handleBrainMcpRequest(request);
}
