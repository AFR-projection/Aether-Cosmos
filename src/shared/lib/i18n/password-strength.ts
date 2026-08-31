import type { TranslationKey } from "./dictionary";

/**
 * `validatePasswordStrength` scores 0–4; the words for those scores live in the
 * dictionary. Kept here rather than in `src/shared/lib/security/password-policy.ts` because
 * that module is also imported by the server and by tests, where a translation
 * key would be meaningless — and its English `getPasswordStrengthLabel` stays as
 * the copy for those non-UI callers.
 */
const STRENGTH_KEYS: TranslationKey[] = [
  "common.passwordStrength.veryWeak",
  "common.passwordStrength.weak",
  "common.passwordStrength.fair",
  "common.passwordStrength.strong",
  "common.passwordStrength.veryStrong",
];

export function passwordStrengthKey(score: number): TranslationKey {
  return STRENGTH_KEYS[score] ?? "common.passwordStrength.unknown";
}
