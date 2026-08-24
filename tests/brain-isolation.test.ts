import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { keyHasScope } from "@/lib/auth/api-key";
import {
  BRAIN_API_SCOPES,
  brainScopeSatisfied,
  DEFAULT_BRAIN_AGENT_SCOPES,
} from "@/lib/brain/constants";
import { parseBrainArchive, planImport } from "@/lib/brain/import-service";

/**
 * §46 — multi-tenant isolation. Mandatory, and the reason this file exists rather
 * than a comment claiming isolation works.
 *
 * Two kinds of assertion:
 *
 *  - behavioural, for the scope algebra, archive parsing and reference resolution,
 *    which are pure functions and can be called directly;
 *  - structural, for the query and route layers, where the real guarantee is
 *    "brain_id is in the WHERE clause" and "the route resolved authorization before
 *    touching data". Those need a database to exercise end to end, so here they are
 *    enforced against the source itself. A new route that forgets `requireBrainContext`
 *    fails this suite instead of shipping.
 */

const ROOT = join(__dirname, "..");

function readAll(dir: string, predicate: (path: string) => boolean): { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (predicate(full)) out.push({ path: relative(ROOT, full).split(sep).join("/"), source: readFileSync(full, "utf8") });
    }
  };
  walk(dir);
  return out;
}

const brainRoutes = readAll(join(ROOT, "app", "api", "brain"), (path) => path.endsWith("route.ts"));
const brainServices = readAll(
  join(ROOT, "lib", "brain"),
  (path) => path.endsWith(".ts") && !path.endsWith(".test.ts")
);

/** Routes that are not scoped to a single brain, and so cannot check one. */
const NON_BRAIN_SCOPED = new Set(["app/api/brain/route.ts", "app/api/brain/mcp/route.ts"]);

describe("case 1 — every brain-scoped route authorizes before it reads", () => {
  it("calls a requireBrain* helper", () => {
    const offenders = brainRoutes
      .filter((route) => !NON_BRAIN_SCOPED.has(route.path))
      .filter((route) => !/requireBrain(Context|OwnerContext)\(/.test(route.source))
      .map((route) => route.path);

    expect(offenders).toEqual([]);
  });

  it("validates the brain id from the route params rather than trusting it as text", () => {
    const offenders = brainRoutes
      .filter((route) => !NON_BRAIN_SCOPED.has(route.path))
      .filter((route) => !/requireUuid\(/.test(route.source))
      .map((route) => route.path);

    expect(offenders).toEqual([]);
  });
});

describe("case 2 — a brain id never comes from the request body", () => {
  it("no brain route reads brainId out of a parsed body", () => {
    const offenders = brainRoutes
      .filter((route) => /body\.brainId|body\?\.brainId/.test(route.source))
      .map((route) => route.path);

    expect(offenders).toEqual([]);
  });
});

describe("case 3 — every brain-table query is brain-scoped", () => {
  const BRAIN_TABLES = [
    "memories",
    "memoryVersions",
    "memoryTags",
    "brainProjects",
    "brainEntities",
    "brainRelationships",
    "memoryLinks",
    // PHASE 2: computed edges are brain-owned exactly like asserted ones.
    "memoryDerivedLinks",
    "brainAuditLogs",
    "brainAgents",
  ];

  /**
   * A file "touches" a table when it names it in a Drizzle query position, not when
   * prose happens to use the same English word — `lib/brain/graph/relate.ts` talks
   * about "17 memories" in a comment and queries nothing.
   *
   * `\\b` deliberately, not `\b`: inside a template literal the single escape is a
   * backspace character, which matches nothing and made this case vacuous.
   */
  const queries = (table: string) =>
    new RegExp(`(?:from|into|insert|update|delete)\\(\\s*${table}\\b`);

  it("every service file that queries a brain table also references brainId", () => {
    const offenders = brainServices
      .filter((file) => BRAIN_TABLES.some((table) => queries(table).test(file.source)))
      .filter((file) => !/brainId/.test(file.source))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it("actually finds the brain tables it claims to check", () => {
    // Guards the assertion above against silently matching nothing again.
    for (const table of BRAIN_TABLES) {
      const touching = brainServices.filter((file) => queries(table).test(file.source));
      expect(touching.length, `no service file queries ${table}`).toBeGreaterThan(0);
    }
  });
});

describe("case 4 — storage scopes never reach the brain", () => {
  it("storage full does not satisfy any brain scope", () => {
    for (const scope of BRAIN_API_SCOPES) {
      expect(keyHasScope(["full"], scope)).toBe(false);
      expect(brainScopeSatisfied(["full"], scope)).toBe(false);
    }
  });

  it("storage read and write do not satisfy any brain scope", () => {
    for (const scope of BRAIN_API_SCOPES) {
      expect(keyHasScope(["read", "write"], scope)).toBe(false);
    }
  });

  it("a brain scope does not satisfy a storage scope", () => {
    expect(keyHasScope(["brain.read", "brain.write"], "read")).toBe(false);
    expect(keyHasScope(["brain.full"], "write")).toBe(false);
  });
});

describe("case 5 — brain scopes do not escalate", () => {
  it("read implies nothing", () => {
    for (const scope of BRAIN_API_SCOPES.filter((value) => value !== "brain.read")) {
      expect(brainScopeSatisfied(["brain.read"], scope)).toBe(false);
    }
  });

  it("write implies only link, never anything destructive or bulk", () => {
    expect(brainScopeSatisfied(["brain.write"], "brain.link")).toBe(true);
    for (const scope of ["brain.delete", "brain.export", "brain.import", "brain.consolidate"]) {
      expect(brainScopeSatisfied(["brain.write"], scope)).toBe(false);
    }
  });

  it("the default agent grant carries nothing destructive or bulk", () => {
    for (const scope of ["brain.delete", "brain.export", "brain.import", "brain.consolidate"]) {
      expect(DEFAULT_BRAIN_AGENT_SCOPES).not.toContain(scope);
      expect(brainScopeSatisfied(DEFAULT_BRAIN_AGENT_SCOPES, scope)).toBe(false);
    }
  });
});

describe("case 6 — MCP tools resolve a grant before every operation", () => {
  const tools = readFileSync(join(ROOT, "lib", "brain", "mcp", "tools.ts"), "utf8");

  it("every registered tool calls requireGrant", () => {
    const bodies = tools.split(/server\.registerTool\(/).slice(1);
    expect(bodies.length).toBeGreaterThan(5);

    // brain_list_brains is the one exception, and cannot leak: it reads nothing but
    // principal.grants, which is the set of grants already resolved for this key.
    const missing = bodies
      .filter((body) => !/^\s*"brain_list_brains"/.test(body))
      .filter((body) => !/requireGrant\(/.test(body))
      .map((body) => body.slice(0, 60).replace(/\s+/g, " "));

    expect(missing).toEqual([]);
  });

  it("passes the grant's brain id to services, never the caller's raw argument", () => {
    // `brainId: brainId` would hand a service whatever the agent asked for; every
    // tool must narrow through requireGrant first and pass grant.brainId.
    const suspicious = tools
      .split(/server\.registerTool\(/)
      .slice(1)
      .filter((body) => /brainId:\s*brainId/.test(body))
      .map((body) => body.slice(0, 60).replace(/\s+/g, " "));

    expect(suspicious).toEqual([]);
  });

  it("uses grant.brainId wherever it reaches a service", () => {
    const bodies = tools
      .split(/server\.registerTool\(/)
      .slice(1)
      .filter((body) => /brainId:/.test(body));
    expect(bodies.length).toBeGreaterThan(3);

    const offenders = bodies
      .filter((body) => !/grant\.brainId/.test(body))
      .map((body) => body.slice(0, 60).replace(/\s+/g, " "));

    expect(offenders).toEqual([]);
  });
});

describe("case 7 — the link table cannot hold a cross-brain or malformed edge", () => {
  const schema = readFileSync(join(ROOT, "lib", "db", "schema.ts"), "utf8");
  const linkService = readFileSync(join(ROOT, "lib", "brain", "link-service.ts"), "utf8");

  it("memory_links carries its own brain_id", () => {
    expect(schema).toMatch(/memoryLinks = pgTable\(/);
    const table = schema.slice(schema.indexOf("memoryLinks = pgTable("));
    expect(table.slice(0, 1200)).toMatch(/brainId: uuid\("brain_id"\)\.notNull\(\)/);
  });

  it("the database rejects a malformed edge, not only the service", () => {
    expect(schema).toMatch(/memory_links_one_target/);
    expect(schema).toMatch(/memory_links_target_type_matches/);
    expect(schema).toMatch(/memory_links_no_self_link/);
  });

  it("both endpoints are re-resolved inside the brain before a link is written", () => {
    expect(linkService).toMatch(/requireLiveMemory\(brainId, params\.sourceMemoryId\)/);
    expect(linkService).toMatch(/requireLiveMemory\(brainId, target\.targetMemoryId\)/);
    expect(linkService).toMatch(/requireEntityInBrain\(brainId, target\.targetEntityId\)/);
  });
});

describe("case 8 — an imported archive cannot claim ownership", () => {
  it("drops brain_id, created_by and created_by_agent from every record", async () => {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify({ format: "afrbrain", formatVersion: 1 }));
    zip.file(
      "memories.jsonl",
      JSON.stringify({
        id: "m1",
        title: "Theirs",
        content: "x",
        brainId: "00000000-0000-0000-0000-000000000001",
        createdBy: "00000000-0000-0000-0000-000000000002",
        createdByAgent: "00000000-0000-0000-0000-000000000003",
      }) + "\n"
    );

    const parsed = await parseBrainArchive(await zip.generateAsync({ type: "uint8array" }));
    const record = parsed.memories[0] as Record<string, unknown>;

    expect(record.brainId).toBeUndefined();
    expect(record.createdBy).toBeUndefined();
    expect(record.createdByAgent).toBeUndefined();
  });

  it("stamps ownership from the target brain, never from the archive", () => {
    const source = readFileSync(join(ROOT, "lib", "brain", "import-service.ts"), "utf8");
    const run = source.slice(source.indexOf("export async function runImport"));

    // Every inserted row is built with the route's brainId in scope.
    expect(run).toMatch(/brainId,/);
    expect(run).toMatch(/createdBy: principal\.agentId \? null : principal\.userId/);
    // And no insert ever copies an id straight out of the archive.
    expect(run).not.toMatch(/id: memory\.id/);
    expect(run).toMatch(/const id = randomUUID\(\)/);
  });
});

describe("case 9 — imported references cannot point outside the archive", () => {
  it("a link naming a memory the archive does not contain is dropped, not remapped", () => {
    const plan = planImport({
      sourceBrainName: null,
      exportedAt: null,
      formatVersion: 1,
      memories: [{ id: "m1", title: "A", content: "a" }],
      memoryVersions: [],
      memoryLinks: [
        { sourceMemoryId: "m1", targetType: "memory", targetMemoryId: "not-in-archive" },
      ],
      tags: [],
      projects: [],
      entities: [],
      relationships: [],
      warnings: [],
    } as never);

    expect(plan.memoryLinks).toEqual([]);
    expect(plan.dropped.linksWithMissingEnd).toBe(1);
  });
});

describe("case 10 — export carries brain content only", () => {
  it("the archive builder never reads a user, session, api key or credential table", () => {
    const source = readFileSync(join(ROOT, "lib", "brain", "export-service.ts"), "utf8");
    for (const forbidden of ["users", "sessions", "apiKeys", "mailSenders", "otpTokens", "oauth"]) {
      expect(source).not.toMatch(new RegExp(`\b${forbidden}\b`));
    }
  });

  it("the export route refuses without the export scope", () => {
    const source = readFileSync(join(ROOT, "app", "api", "brain", "[id]", "export", "route.ts"), "utf8");
    expect(source).toMatch(/"brain\.export"/);
  });

  it("the import route is owner-only and refuses without the import scope", () => {
    const source = readFileSync(join(ROOT, "app", "api", "brain", "[id]", "import", "route.ts"), "utf8");
    expect(source).toMatch(/requireBrainOwnerContext/);
    expect(source).toMatch(/"brain\.import"/);
  });
});
