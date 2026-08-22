import { describe, it, expect, beforeEach, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import {
  BrainConflictError,
  BrainProjectNotFoundError,
  BrainValidationError,
} from "./errors";

/**
 * Projects group the memories of one piece of work, and are the unit `brain_recall`
 * can be narrowed to.
 *
 * Two properties are asserted here rather than assumed. Every statement carries the
 * brain id next to the project id, so a project id from the wire resolves to nothing
 * in a brain that does not own it. And deleting a project is *not* a cascade: the FK
 * on `memories.project_id` is ON DELETE SET NULL, so the work ends and the knowledge
 * stays — the service must therefore never delete memories itself.
 *
 * The database is a recording fake; the assertions are about predicates and refused
 * writes, not about how Postgres answers.
 */

type Rows = Record<string, unknown[][]>;
type WriteCall = {
  verb: "insert" | "update" | "delete";
  table: string;
  values?: Record<string, unknown>;
  where?: unknown;
};
type ReadCall = { table: string; columns: string[]; limit: number | null; where: unknown; order: unknown };

/** Flatten a Drizzle predicate into a searchable string (columns hold circular refs). */
function describeSql(node: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();

  const walk = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
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

const reads: ReadCall[] = [];
const writes: WriteCall[] = [];
const joins: unknown[] = [];
let rows: Rows = {};
const cursors = new Map<string, number>();
/** Recorded so a "one grouped join, not a count per project" claim can be checked. */
let groupedBy: unknown = null;

function selectChain(columns: string[]) {
  const call: ReadCall = { table: "", columns, limit: null, where: null, order: null };
  const chain = {
    from(table: unknown) {
      call.table = getTableName(table as never);
      return chain;
    },
    leftJoin(_table: unknown, condition: unknown) {
      joins.push(condition);
      return chain;
    },
    where(condition: unknown) {
      call.where = condition;
      return chain;
    },
    groupBy(...args: unknown[]) {
      groupedBy = args;
      return chain;
    },
    orderBy(...args: unknown[]) {
      call.order = args;
      return chain;
    },
    limit(value: number) {
      call.limit = value;
      return chain;
    },
    then<T>(resolve: (value: unknown[]) => T) {
      reads.push(call);
      const index = cursors.get(call.table) ?? 0;
      cursors.set(call.table, index + 1);
      return Promise.resolve(rows[call.table]?.[index] ?? []).then(resolve);
    },
  };
  return chain;
}

vi.mock("@/lib/db", () => ({
  db: {
    select: (projection?: Record<string, unknown>) => selectChain(Object.keys(projection ?? {})),
    insert(table: unknown) {
      const call: WriteCall = { verb: "insert", table: getTableName(table as never) };
      const chain = {
        values(values: Record<string, unknown>) {
          call.values = values;
          return chain;
        },
        returning() {
          writes.push(call);
          return Promise.resolve(rows.__insert?.[0] ?? [{ id: "project-new", ...call.values }]);
        },
      };
      return chain;
    },
    update(table: unknown) {
      const call: WriteCall = { verb: "update", table: getTableName(table as never) };
      const chain = {
        set(patch: Record<string, unknown>) {
          call.values = patch;
          return chain;
        },
        where(condition: unknown) {
          call.where = condition;
          return chain;
        },
        returning() {
          writes.push(call);
          return Promise.resolve(rows.__update?.[0] ?? [{ id: "project-1", ...call.values }]);
        },
      };
      return chain;
    },
    delete(table: unknown) {
      const call: WriteCall = { verb: "delete", table: getTableName(table as never) };
      const chain = {
        where(condition: unknown) {
          call.where = condition;
          return chain;
        },
        returning() {
          writes.push(call);
          return Promise.resolve(rows.__delete?.[0] ?? []);
        },
      };
      return chain;
    },
  },
}));

const {
  listProjects,
  requireProject,
  createProject,
  updateProject,
  deleteProject,
  exportProjects,
  MAX_PROJECTS_PER_BRAIN,
} = await import("./project-service");

const BRAIN = "11111111-1111-4111-8111-111111111111";
const OTHER_BRAIN = "99999999-9999-4999-8999-999999999999";
const PROJECT = "22222222-2222-4222-8222-222222222222";

const PROJECT_TABLE = getTableName(schema.brainProjects);
const MEMORY_TABLE = getTableName(schema.memories);

const projectRow = (overrides: Record<string, unknown> = {}) => ({
  id: PROJECT,
  brainId: BRAIN,
  name: "Second Brain 2.0",
  description: null,
  status: "active",
  ...overrides,
});

const readOf = (table: string, index = 0): ReadCall | undefined =>
  reads.filter((call) => call.table === table)[index];

beforeEach(() => {
  reads.length = 0;
  writes.length = 0;
  joins.length = 0;
  rows = {};
  groupedBy = null;
  cursors.clear();
});

describe("listProjects", () => {
  it("returns each project with its live memory count, from one grouped query", async () => {
    // A count per project is O(projects) round trips; the join keeps it at one.
    rows[PROJECT_TABLE] = [
      [
        { project: projectRow(), memoryCount: 12 },
        { project: projectRow({ id: "p2", name: "Docs" }), memoryCount: 0 },
      ],
    ];

    const projects = await listProjects({ brainId: BRAIN });

    expect(projects).toEqual([
      { ...projectRow(), memoryCount: 12 },
      { ...projectRow({ id: "p2", name: "Docs" }), memoryCount: 0 },
    ]);
    expect(reads).toHaveLength(1);
    expect(groupedBy).not.toBeNull();
  });

  it("counts only memories that are still there", async () => {
    // The join condition, not the WHERE, is what excludes soft-deleted rows — putting
    // it in the WHERE would drop empty projects from the list entirely.
    await listProjects({ brainId: BRAIN });

    expect(joins).toHaveLength(1);
    const on = describeSql(joins[0]);
    expect(on).toContain("project_id");
    expect(on).toContain("deleted_at");
  });

  it("scopes to the brain and can narrow to one status", async () => {
    await listProjects({ brainId: BRAIN, status: "archived" });

    const predicate = describeSql(readOf(PROJECT_TABLE)!.where);
    expect(predicate).toContain(BRAIN);
    expect(predicate).toContain("archived");
  });

  it("orders by status then most recently touched", async () => {
    await listProjects({ brainId: BRAIN });

    const order = describeSql(readOf(PROJECT_TABLE)!.order);
    expect(order).toContain("status");
    expect(order).toContain("updated_at");
  });
});

describe("requireProject", () => {
  it("reads by project id AND brain id, one row", async () => {
    rows[PROJECT_TABLE] = [[projectRow()]];

    const project = await requireProject(BRAIN, PROJECT);

    expect(project.name).toBe("Second Brain 2.0");
    const read = readOf(PROJECT_TABLE)!;
    const predicate = describeSql(read.where);
    expect(predicate).toContain(PROJECT);
    expect(predicate).toContain(BRAIN);
    expect(read.limit).toBe(1);
  });

  it("reports a project from another brain as simply not found", async () => {
    rows[PROJECT_TABLE] = [[]];

    const error = await requireProject(BRAIN, PROJECT).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrainProjectNotFoundError);
    expect((error as BrainProjectNotFoundError).status).toBe(404);
    expect((error as BrainProjectNotFoundError).code).toBe("BRAIN_PROJECT_NOT_FOUND");
  });
});

describe("createProject", () => {
  it("counts this brain's projects first, then writes the row", async () => {
    rows[PROJECT_TABLE] = [[{ total: 4 }]];

    await createProject({ brainId: BRAIN, name: "  Second Brain 2.0  " });

    expect(describeSql(readOf(PROJECT_TABLE)!.where)).toContain(BRAIN);
    expect(writes[0].values).toEqual({
      brainId: BRAIN,
      name: "Second Brain 2.0",
      description: null,
      status: "active",
    });
  });

  it("refuses a blank name before it even counts", async () => {
    const error = await createProject({ brainId: BRAIN, name: "   " }).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(BrainValidationError);
    expect((error as Error).message).toBe("Project name is required");
    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
  });
});

describe("createProject — the per-brain cap", () => {
  it("refuses past the cap, and writes nothing", async () => {
    rows[PROJECT_TABLE] = [[{ total: MAX_PROJECTS_PER_BRAIN }]];

    const error = await createProject({ brainId: BRAIN, name: "One more" }).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(BrainConflictError);
    expect((error as BrainConflictError).status).toBe(409);
    expect((error as Error).message).toBe(
      `Maximum ${MAX_PROJECTS_PER_BRAIN} projects per brain`
    );
    expect(writes).toEqual([]);
  });

  it("allows the last slot under the cap", async () => {
    rows[PROJECT_TABLE] = [[{ total: MAX_PROJECTS_PER_BRAIN - 1 }]];

    await createProject({ brainId: BRAIN, name: "Docs" });
    expect(writes).toHaveLength(1);
  });

  it("treats an empty count as zero rather than crashing", async () => {
    rows[PROJECT_TABLE] = [[]];

    await createProject({ brainId: BRAIN, name: "Docs" });
    expect(writes).toHaveLength(1);
  });

  it("keeps a supplied status and trims the description", async () => {
    rows[PROJECT_TABLE] = [[{ total: 0 }]];

    await createProject({
      brainId: BRAIN,
      name: "Docs",
      description: "  rewrite  ",
      status: "done",
    });

    expect(writes[0].values).toMatchObject({ description: "rewrite", status: "done" });
  });

  it("stores a whitespace-only description as null", async () => {
    rows[PROJECT_TABLE] = [[{ total: 0 }]];

    await createProject({ brainId: BRAIN, name: "Docs", description: "   " });
    expect(writes[0].values!.description).toBeNull();
  });
});

describe("updateProject", () => {
  it("verifies the project is in this brain before patching", async () => {
    rows[PROJECT_TABLE] = [[]];

    await expect(
      updateProject({ brainId: BRAIN, projectId: PROJECT, data: { name: "Docs" } })
    ).rejects.toBeInstanceOf(BrainProjectNotFoundError);
    expect(writes).toEqual([]);
  });

  it("patches only what was sent, filtered by project and brain", async () => {
    rows[PROJECT_TABLE] = [[projectRow()]];
    rows.__update = [[projectRow({ status: "done" })]];

    const updated = await updateProject({
      brainId: BRAIN,
      projectId: PROJECT,
      data: { status: "done" },
    });

    expect(updated.status).toBe("done");
    expect(Object.keys(writes[0].values!).sort()).toEqual(["status", "updatedAt"]);
    const predicate = describeSql(writes[0].where);
    expect(predicate).toContain(PROJECT);
    expect(predicate).toContain(BRAIN);
  });

  it("refuses an empty patch and a blank rename", async () => {
    rows[PROJECT_TABLE] = [[projectRow()], [projectRow()]];

    await expect(
      updateProject({ brainId: BRAIN, projectId: PROJECT, data: {} })
    ).rejects.toThrow("No fields to update");
    await expect(
      updateProject({ brainId: BRAIN, projectId: PROJECT, data: { name: "  " } })
    ).rejects.toThrow("Project name cannot be empty");
    expect(writes).toEqual([]);
  });

  it("reports a project that vanished mid-update as not found", async () => {
    rows[PROJECT_TABLE] = [[projectRow()]];
    rows.__update = [[]];

    await expect(
      updateProject({ brainId: BRAIN, projectId: PROJECT, data: { name: "Docs" } })
    ).rejects.toBeInstanceOf(BrainProjectNotFoundError);
  });
});

describe("deleteProject — the work ends, the knowledge stays", () => {
  it("deletes the project row by id and brain, and nothing else", async () => {
    // `memories.project_id` is ON DELETE SET NULL, so the memories detach themselves.
    // A service-side delete of memories here would destroy knowledge on a rename-sized
    // action; the assertion is that no statement touches the memories table.
    rows.__delete = [[{ id: PROJECT }]];

    expect(await deleteProject(BRAIN, PROJECT)).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].table).toBe(PROJECT_TABLE);
    expect(writes.some((write) => write.table === MEMORY_TABLE)).toBe(false);
    const predicate = describeSql(writes[0].where);
    expect(predicate).toContain(PROJECT);
    expect(predicate).toContain(BRAIN);
  });

  it("returns false for a project another brain owns", async () => {
    rows.__delete = [[]];
    expect(await deleteProject(BRAIN, PROJECT)).toBe(false);
  });
});

describe("exportProjects", () => {
  it("exports one brain's projects, uncapped and in creation order", async () => {
    rows[PROJECT_TABLE] = [[projectRow(), projectRow({ id: "p2" })]];

    const projects = await exportProjects(BRAIN);

    expect(projects).toHaveLength(2);
    const read = readOf(PROJECT_TABLE)!;
    expect(describeSql(read.where)).toContain(BRAIN);
    expect(read.limit).toBeNull();
    expect(describeSql(read.order)).toContain("created_at");
  });
});

describe("the brain id is folded into every statement", () => {
  it("names this brain in each read and write, and never another one", async () => {
    rows[PROJECT_TABLE] = [
      [],
      [projectRow()],
      [{ total: 0 }],
      [projectRow()],
      [projectRow()],
    ];

    await listProjects({ brainId: BRAIN });
    await requireProject(BRAIN, PROJECT);
    await createProject({ brainId: BRAIN, name: "Docs" });
    await updateProject({ brainId: BRAIN, projectId: PROJECT, data: { name: "Docs" } });
    await deleteProject(BRAIN, PROJECT);
    await exportProjects(BRAIN);

    for (const read of reads) {
      const predicate = describeSql(read.where);
      expect(predicate, `read of ${read.table}`).toContain(BRAIN);
      expect(predicate, `read of ${read.table}`).not.toContain(OTHER_BRAIN);
    }
    for (const write of writes) {
      const evidence = `${describeSql(write.where)} ${JSON.stringify(write.values ?? {})}`;
      expect(evidence, `${write.verb} into ${write.table}`).toContain(BRAIN);
      expect(evidence, `${write.verb} into ${write.table}`).not.toContain(OTHER_BRAIN);
    }
    expect(reads).toHaveLength(5);
    expect(writes).toHaveLength(3);
  });
});

