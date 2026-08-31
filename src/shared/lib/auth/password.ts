import { hash, verify } from "@node-rs/argon2";

const ARGON2_OPTIONS = {
  memoryCost: 65536,
  timeCost: 3,
  outputLen: 32,
  parallelism: 1,
};

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(
  password: string,
  passwordHash: string
): Promise<boolean> {
  try {
    return await verify(passwordHash, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/**
 * A real argon2id hash of a random string nobody holds. Verifying against it can
 * never succeed — its only job is to cost the same as a genuine verification.
 */
const DECOY_HASH =
  "$argon2id$v=19$m=65536,t=3,p=1$vIq+4Xy1dUSBW0XlD8KQVA$A9FJrx079EBlqzdV8TrYyj+AXa8f2iOUoQ7/D4HDeyY";

/**
 * Burn one password verification for an identifier that does not exist.
 *
 * Without this, "no such user" returns in microseconds while a wrong password
 * costs a full argon2 hash (~0.5 s here), which is a loud timing oracle for
 * account enumeration — the response body can be made identical and the clock
 * still gives the answer away.
 *
 * Always resolves false.
 */
export async function verifyDecoyPassword(password: string): Promise<boolean> {
  return verifyPassword(password, DECOY_HASH);
}
