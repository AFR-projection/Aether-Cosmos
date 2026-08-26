import "./load-env";
import postgres from "postgres";

async function main() {
  const db = postgres(process.env.DATABASE_URL!);
  const tables = await db`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name LIKE 'oauth%'
    ORDER BY table_name
  `;
  console.log("oauth tables:", tables);
  await db.end();
}

main();
