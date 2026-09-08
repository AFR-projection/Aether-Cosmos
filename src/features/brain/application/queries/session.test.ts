import { beforeEach, describe, expect, it, vi } from "vitest";

const recallBrainContext = vi.fn();
let rows: Array<{
  id: string;
  type: string;
  title: string;
  summary: string | null;
  content: string;
  importance: number;
}> = [];
const reads: { where: unknown; limit: number | null }[] = [];

vi.mock("./recall", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./recall")>()),
  recallBrainContext: (...args: unknown[]) => recallBrainContext(...args),
}));

function selectChain() {
  const call = { where: null as unknown, limit: null as number | null };
  const chain = {
    from: () => chain,
    where(condition: unknown) {
      call.where = condition;
      return chain;
    },
    orderBy: () => chain,
    limit(value: number) {
      call.limit = value;
      return chain;
    },
    then<T>(resolve: (value: typeof rows) => T) {
      reads.push(call);
      return Promise.resolve(rows).then(resolve);
    },
  };
  return chain;
}

function describeSql(node: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const walk = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (["string", "number", "boolean", "bigint"].includes(typeof value)) {
      parts.push(String(value));
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if ("queryChunks" in record) walk(record.queryChunks);
    if ("value" in record) walk(record.value);
    else if (typeof record.name === "string") parts.push(record.name);
  };
  walk(node);
  return parts.join(" ");
}

vi.mock("@/shared/infrastructure/db", () => ({ db: { select: () => selectChain() } }));

const { buildSessionStart, buildSessionTurn, MAX_EXCLUDE, TURN_SNIPPET_CHARS } =
  await import("./session");

const BRAIN = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";

function recallItem(id: string) {
  return {
    id,
    type: "fact",
    title: `Memory ${id}`,
    summary: null,
    content: "Durable context",
    importance: 0.6,
    confidence: 0.8,
    projectId: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  rows = [];
  reads.length = 0;
  recallBrainContext.mockReset();
  recallBrainContext.mockResolvedValue({
    directives: [recallItem("directive")],
    relevant: [recallItem("shared")],
    important: [recallItem("shared"), recallItem("important")],
    recent: [recallItem("recent")],
    graph: [],
    contextText: "Brain context:\n\n- durable context",
    truncated: false,
  });
});

describe("brain session packages", () => {
  it("preserves a supplied id and deduplicates start memory ids", async () => {
    const result = await buildSessionStart({
      brainId: BRAIN,
      brainName: "Personal",
      sessionId: " session-one ",
      topic: " deploy ",
      projectId: PROJECT,
    });

    expect(result.sessionId).toBe("session-one");
    expect(result.topic).toBe("deploy");
    expect(result.memoryIds).toEqual(["directive", "shared", "important", "recent"]);
    expect(result.text).toContain("Treat the standing instructions as binding");
    expect(recallBrainContext).toHaveBeenCalledWith(
      expect.objectContaining({ brainId: BRAIN, query: "deploy", projectId: PROJECT })
    );
  });

  it("mints an id when the client does not supply one", async () => {
    const result = await buildSessionStart({ brainId: BRAIN, brainName: "Personal" });

    expect(result.sessionId).toMatch(/^sess_[0-9a-f-]{36}$/i);
  });

  it("returns no DB payload for a prompt without search terms", async () => {
    const result = await buildSessionTurn({ brainId: BRAIN, prompt: "?" });

    expect(result.text).toBe("");
    expect(result.memoryIds).toEqual([]);
    expect(reads).toHaveLength(0);
  });

  it("filters by project and a capped unique exclusion list", async () => {
    const repeated = Array.from({ length: MAX_EXCLUDE + 20 }, (_, index) =>
      `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`
    );

    await buildSessionTurn({
      brainId: BRAIN,
      sessionId: "turn-session",
      prompt: "postgres production deployment",
      projectId: PROJECT,
      exclude: [repeated[0]!, repeated[0]!, ...repeated],
    });

    const sql = describeSql(reads[0]?.where);
    expect(sql).toContain(PROJECT);
    expect(sql).toContain(repeated[0]!);
    expect(sql).not.toContain(repeated.at(-1)!);
    expect(reads[0]?.limit).toBe(3);
  });

  it("renders new memories and clips long snippets", async () => {
    rows = [
      {
        id: "33333333-3333-4333-8333-333333333333",
        type: "fact",
        title: "Deploy target",
        summary: null,
        content: `  ${"x".repeat(TURN_SNIPPET_CHARS + 40)}  `,
        importance: 0.75,
      },
    ];

    const result = await buildSessionTurn({
      brainId: BRAIN,
      sessionId: "turn-session",
      prompt: "deploy target",
    });

    expect(result.sessionId).toBe("turn-session");
    expect(result.memoryIds).toEqual([rows[0]!.id]);
    expect(result.memories[0]?.snippet).toHaveLength(TURN_SNIPPET_CHARS);
    expect(result.memories[0]?.snippet.endsWith("…")).toBe(true);
    expect(result.text).toContain("Deploy target");
  });

  it("returns an empty string when the query finds no new memory", async () => {
    const result = await buildSessionTurn({ brainId: BRAIN, prompt: "postgres deployment" });

    expect(result.text).toBe("");
    expect(result.memories).toEqual([]);
  });
});
