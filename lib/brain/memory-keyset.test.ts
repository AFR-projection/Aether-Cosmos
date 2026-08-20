import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { memoryKeysetBefore } from "@/lib/brain/memory-service";

const dialect = new PgDialect();
const CURSOR = {
  createdAt: new Date("2026-08-20T10:11:12.345Z"),
  id: "11111111-2222-4333-8444-555555555555",
};

describe("memory keyset predicate", () => {
  const { sql, params } = dialect.sqlToQuery(memoryKeysetBefore(CURSOR));

  it("compares the (created_at, id) tuple, not created_at alone", () => {
    // Filtering on created_at alone loses every memory that shares a millisecond
    // with the cursor row.
    expect(sql).toContain('"created_at"');
    expect(sql).toContain('"id"');
    expect(sql.replace(/\s+/g, " ")).toMatch(/\(.*created_at.*,.*id.*\) < \(/);
  });

  it("casts both sides so the row-value types line up", () => {
    expect(sql).toContain("::timestamptz");
    expect(sql).toContain("::uuid");
  });

  it("binds the cursor values as parameters", () => {
    expect(params).toEqual([CURSOR.createdAt.toISOString(), CURSOR.id]);
  });
});
