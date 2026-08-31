import "./load-env";
import postgres from "postgres";

/**
 * Idempotent prerequisites that must exist before Drizzle can create the schema.
 * The memories table contains a pgvector column, so a genuinely empty production
 * database cannot be bootstrapped until the provider enables the vector extension.
 */
async function prepareProductionDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const client = postgres(connectionString, {
    max: 1,
    connect_timeout: 10,
    ssl: "require",
    prepare: false,
  });

  try {
    await client.unsafe("CREATE EXTENSION IF NOT EXISTS vector");
    console.log("Database prerequisite ready: pgvector");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not enable pgvector. Use a PostgreSQL provider/plan that supports the vector extension, then retry. ${detail}`,
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

prepareProductionDatabase().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
