import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

import { ROW_FILTER_SQL } from "@backup/account/infrastructure/brain-source";
import { liveMemoriesOf } from "@backup/account/infrastructure/overview";

/**
 * The two cards on `/backup` count the rows the download carries — and nothing else.
 *
 * This is the test for a bug that was invisible from either side alone. `readBrainOverview`
 * counted every `memories` row belonging to the account's brains; `brain-source.ts` scopes the
 * export to `deleted_at IS NULL`, because a Recycle Bin that travelled would restore as content.
 * An account that had emptied six memories into the bin therefore read "9 memories" on the
 * backup card and "3" on `/brain`, and both numbers were correctly computed.
 *
 * Neither module can be tested against the other by reading rows — that needs a database, and a
 * count is not what went wrong. What went wrong is a predicate, so a predicate is what this
 * compares: the exporter's scope and the card's `where`, rendered to SQL by the same dialect
 * Drizzle would use, with no connection involved.
 */

const dialect = new PgDialect();

function sqlTextOf(value: Parameters<PgDialect["sqlToQuery"]>[0]): string {
  return dialect.sqlToQuery(value).sql.toLowerCase();
}

describe("the backup card counts what the archive carries", () => {
  it("scopes memories to the live ones, the way the exporter does", () => {
    const predicate = liveMemoriesOf("11111111-2222-3333-4444-555555555555");
    expect(predicate).toBeDefined();

    const text = sqlTextOf(predicate!);
    // The filter itself. Written as two assertions rather than one string match so a rename of
    // the column and a removal of the clause fail differently.
    expect(text).toContain("deleted_at");
    expect(text).toContain("is null");
    // And ownership, which is the other half of "the rows this archive would carry".
    expect(text).toContain("owner_user_id");
  });

  it("agrees with the predicate the exporter actually walks", () => {
    // `ROW_FILTER_SQL.memories` is what `planBrainExport` reads rows through. If a later change
    // decides the archive should carry deleted memories after all, this fails and the card is
    // corrected in the same commit rather than a release later.
    const scope = ROW_FILTER_SQL.memories;
    expect(scope).not.toBeNull();

    const exported = sqlTextOf(scope!("11111111-2222-3333-4444-555555555555"));
    expect(exported).toContain("deleted_at");
    expect(exported).toContain("is null");

    const card = sqlTextOf(liveMemoriesOf("11111111-2222-3333-4444-555555555555")!);
    expect(card.includes("deleted_at") && card.includes("is null")).toBe(
      exported.includes("deleted_at") && exported.includes("is null")
    );
  });

  it("does not filter archived memories out of the archive", () => {
    // The opposite mistake, and the tempting one: `/brain` shows active and archived in two
    // tiles, so "match the page" would mean dropping archived memories from the count — and an
    // archived memory is a live row the export carries. It belongs in the total, named
    // separately, which is what `archivedMemories` is for.
    const text = sqlTextOf(liveMemoriesOf("11111111-2222-3333-4444-555555555555")!);

    expect(text).not.toContain("archived_at");
  });
});
