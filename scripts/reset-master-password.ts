import "./load-env";
import { eq } from "drizzle-orm";
import { db } from "../lib/db";
import { users } from "../lib/db/schema";
import { hashPassword } from "../lib/auth/password";

async function resetMasterPassword() {
  const username = process.env.MASTER_USERNAME ?? "ByAFR";
  const password = process.env.MASTER_PASSWORD;

  if (!password) {
    console.error("MASTER_PASSWORD is required in .env");
    process.exit(1);
  }

  const [master] = await db
    .select()
    .from(users)
    .where(eq(users.role, "master"))
    .limit(1);

  if (!master) {
    console.error("No master account found. Run: npm run bootstrap");
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);

  await db
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.id, master.id));

  console.log(`Master password reset for: ${master.username}`);
  console.log("Use the password from MASTER_PASSWORD in your .env file to login.");
}

resetMasterPassword()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Reset failed:", err);
    process.exit(1);
  });
