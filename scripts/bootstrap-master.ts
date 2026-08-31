import "./load-env";
import { eq } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { users } from "@/shared/infrastructure/db/schema";
import { hashPassword } from "@/shared/lib/auth/password";
import { validatePasswordStrength } from "@/shared/lib/security/password-policy";

async function bootstrapMaster() {
  const username = process.env.MASTER_USERNAME ?? "ByAFR";
  const password = process.env.MASTER_PASSWORD;

  if (!/^[a-zA-Z0-9._-]{3,50}$/.test(username)) {
    console.error("MASTER_USERNAME must be 3–50 characters using letters, numbers, dot, underscore, or hyphen");
    process.exit(1);
  }

  if (!password) {
    console.error("MASTER_PASSWORD is required for bootstrap");
    process.exit(1);
  }

  const passwordCheck = validatePasswordStrength(password);
  if (!passwordCheck.valid) {
    console.error(`MASTER_PASSWORD is not strong enough: ${passwordCheck.errors.join("; ")}`);
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
