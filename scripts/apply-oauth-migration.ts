import "./load-env";
import postgres from "postgres";
import fs from "fs";

async function main() {
  const db = postgres(process.env.DATABASE_URL!);

  const exists = await db`
    SELECT EXISTS (
      SELECT FROM information_schema.tables WHERE table_name = 'oauth_clients'
    ) AS ok
  `;

  if (!exists[0]?.ok) {
    const mig = fs.readFileSync("drizzle/0003_oauth.sql", "utf8");
    await db.unsafe(mig);
    console.log("Created OAuth tables");
  } else {
    console.log("OAuth tables already exist — skipping create");
  }

  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
