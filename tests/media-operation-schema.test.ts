import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const migration = readFileSync(
  join(ROOT, "drizzle", "0030_media_metadata.sql"),
  "utf8",
);
const rollback = readFileSync(
  join(ROOT, "drizzle", "0030_media_metadata_rollback.sql"),
  "utf8",
);
const schema = readFileSync(
  join(ROOT, "src", "shared", "infrastructure", "db", "schema.ts"),
  "utf8",
);

describe("durable media operation schema", () => {
  it("persists operation identity, exact source state, staging, and output state", () => {
    expect(migration).toMatch(/CREATE TYPE "media_operation_kind" AS ENUM \('trim', 'extract_audio'\)/);
    expect(migration).toMatch(
      /CREATE TYPE "media_operation_status" AS ENUM \('queued', 'staged', 'publishing', 'completed', 'stale', 'failed'\)/,
    );
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "media_operations"');

    for (const column of [
      '"id" uuid PRIMARY KEY',
      '"kind" media_operation_kind NOT NULL',
      '"source_file_id" uuid NOT NULL',
      '"source_r2_key" text NOT NULL',
      '"source_mime_type" text NOT NULL',
      '"source_version" integer NOT NULL',
      '"output_file_id" uuid',
      '"staging_key" text NOT NULL',
      '"status" media_operation_status NOT NULL',
      '"output_size_bytes" bigint',
      '"output_mime_type" text',
      '"output_name" text',
    ]) {
      expect(migration).toContain(column);
    }
  });

  it("enforces stable extraction outputs and valid staged metadata", () => {
    expect(migration).toContain('REFERENCES "files"("id") ON DELETE CASCADE');
    expect(migration).not.toContain('"output_file_id" uuid REFERENCES');
    expect(migration).toContain('"media_operations_kind_output_chk"');
    expect(migration).toContain('"media_operations_staged_output_chk"');
    expect(migration).toContain('"media_operations_source_version_chk"');
    expect(migration).toContain('"media_operations_output_size_chk"');
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "media_operations_output_file_unique"');
    expect(migration).toContain('WHERE "output_file_id" IS NOT NULL');
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS "media_operations_source_idx"');
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS "media_operations_status_updated_idx"');
  });

  it("maps the table and relations in Drizzle", () => {
    expect(schema).toContain('export const mediaOperationKindEnum = pgEnum("media_operation_kind"');
    expect(schema).toContain('export const mediaOperationStatusEnum = pgEnum("media_operation_status"');
    expect(schema).toContain('export const mediaOperations = pgTable(');
    expect(schema).toContain('"media_operations"');
    expect(schema).toContain('sourceOperations: many(mediaOperations');
    expect(schema).toContain('export const mediaOperationsRelations = relations(mediaOperations');
    expect(schema).toContain('export type MediaOperation = typeof mediaOperations.$inferSelect;');
    expect(schema).toContain('export type NewMediaOperation = typeof mediaOperations.$inferInsert;');
  });

  it("rolls back the table before removing its enum types", () => {
    const table = rollback.indexOf('DROP TABLE IF EXISTS "media_operations"');
    const status = rollback.indexOf('DROP TYPE IF EXISTS "media_operation_status"');
    const kind = rollback.indexOf('DROP TYPE IF EXISTS "media_operation_kind"');
    expect(table).toBeGreaterThanOrEqual(0);
    expect(status).toBeGreaterThan(table);
    expect(kind).toBeGreaterThan(table);
  });
});
