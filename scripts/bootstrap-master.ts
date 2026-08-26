import "./load-env";
import { eq } from "drizzle-orm";
import { db } from "../lib/db";
import { users } from "../lib/db/schema";
import { hashPassword } from "../lib/auth/password";

async function bootstrapMaster() {
  const username = process.env.MASTER_USERNAME ?? "ByAFR";
  const password = process.env.MASTER_PASSWORD;

  if (!password) {
    console.error("MASTER_PASSWORD is required for bootstrap");
    process.exit(1);
  }

  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.role, "master"))
    .limit(1);

  if (existing) {
    console.log("Master account already exists:", existing.username);
    return;
  }

  const passwordHash = await hashPassword(password);

  await db.insert(users).values({
    username,
    phone: null,
    passwordHash,
    role: "master",
    status: "active",
    quotaBytes: 1099511627776, // 1 TB for master
    usedBytes: 0,
  });

  console.log(`Master account created: ${username}`);

  if (password === "change-this-strong-password") {
    console.warn("WARNING: Using default password. Change MASTER_PASSWORD immediately!");
  }
}

bootstrapMaster()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Bootstrap failed:", err);
    process.exit(1);
  });
