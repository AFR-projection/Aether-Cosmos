import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

type Database = PostgresJsDatabase<typeof schema>;

let client: ReturnType<typeof postgres> | null = null;
let database: Database | null = null;

function getClient() {
  if (!client) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    client = postgres(connectionString, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      ssl: 'require',
      // Disable prepared statements for Aiven compatibility
      // (especially if using PgBouncer in transaction mode)
      prepare: false,
    });
  }
  return client;
}

function getDatabase(): Database {
  if (!database) {
    database = drizzle(getClient(), { schema });
  }
  return database;
}

export const db = new Proxy({} as Database, {
  get(_target, prop) {
    return Reflect.get(getDatabase(), prop);
  },
});

export async function recalculateUsedBytes(userId: string) {
  const { files, users } = await import("./schema");
  const { eq, and, inArray, isNull, sum } = await import("drizzle-orm");

  const [result] = await getDatabase()
    .select({ total: sum(files.sizeBytes) })
    .from(files)
    .where(
      and(
        eq(files.userId, userId),
        isNull(files.deletedAt),
        // Legacy rows are counted conservatively until the R2 reconciliation
        // worker verifies them. New non-ready uploads must not consume usedBytes.
        inArray(files.status, ["ready", "legacy_unverified"])
      )
    );

  await getDatabase()
    .update(users)
    .set({ usedBytes: Number(result?.total ?? 0) })
    .where(eq(users.id, userId));
}
