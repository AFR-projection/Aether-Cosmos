export interface PasswordPolicyResult {
  valid: boolean;
  score: number; // 0-4 (0=terrible, 4=excellent)
  errors: string[];
  suggestions: string[];
}

/** Exported so the UI can state the rule in the reader's own language. */
export const PASSWORD_MIN_LENGTH = 10;

const MIN_LENGTH = PASSWORD_MIN_LENGTH;
const MAX_LENGTH = 128;
const COMMON_PASSWORDS = new Set([
  "password", "123456", "12345678", "qwerty", "abc123", "monkey", "master",
  "dragon", "login", "princess", "football", "shadow", "sunshine", "trustno1",
  "iloveyou", "batman", "access", "hello", "charlie", "letmein", "welcome",
  "password1", "admin", "passw0rd", "p@ssword", "p@ssw0rd",
]);

const COMMON_PATTERNS = [
  /^(.)\1+$/, // All same character: "aaaaaaa"
  /^(012|123|234|345|456|567|678|789|890)+$/, // Sequential numbers
  /^(abc|bcd|cde|def|efg|fgh|ghi|hij|ijk|jkl|klm|lmn|mno|nop|opq|pqr|qrs|rst|stu|tuv|uvw|vwx|wxy|xyz)+$/i, // Sequential letters
  /^(qwerty|asdf|zxcv|wasd)/i, // Keyboard patterns
];

export function validatePasswordStrength(password: string): PasswordPolicyResult {
  const errors: string[] = [];
  const suggestions: string[] = [];
  let score = 0;

  // Length check
  if (password.length < MIN_LENGTH) {
    errors.push(`Password must be at least ${MIN_LENGTH} characters`);
  } else if (password.length >= MIN_LENGTH) {
    score += 1;
  }

  if (password.length > MAX_LENGTH) {
    errors.push(`Password must be at most ${MAX_LENGTH} characters`);
  }

  // Common password check
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    errors.push("This password is too common");
    score = 0;
    return { valid: false, score, errors, suggestions: ["Choose a unique password"] };
  }

  // Pattern check
  for (const pattern of COMMON_PATTERNS) {
    if (pattern.test(password)) {
      errors.push("Password contains a predictable pattern");
      score = Math.max(score - 1, 0);
      break;
    }
  }

  // Character variety — require at least 3 types
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  const hasSpecial = /[^a-zA-Z0-9]/.test(password);

  const charTypes = [hasLower, hasUpper, hasDigit, hasSpecial].filter(Boolean).length;

  if (charTypes < 3) {
    errors.push("Password must include at least 3 of: lowercase, uppercase, number, special character");
  }

  if (charTypes >= 3) score += 1;
  if (charTypes >= 4) score += 1;
  if (password.length >= 12) score += 1;

  // Suggestions
  if (!hasLower) suggestions.push("Add lowercase letters");
  if (!hasUpper) suggestions.push("Add uppercase letters");
  if (!hasDigit) suggestions.push("Add numbers");
  if (!hasSpecial) suggestions.push("Add special characters (!@#$%^&*)");
  if (password.length < 12) suggestions.push("Use at least 12 characters for better security");

  // Entropy estimation
  let charsetSize = 0;
  if (hasLower) charsetSize += 26;
  if (hasUpper) charsetSize += 26;
  if (hasDigit) charsetSize += 10;
  if (hasSpecial) charsetSize += 32;

  const entropy = Math.log2(Math.pow(charsetSize || 1, password.length));
  if (entropy < 30) {
    suggestions.push("Increase password complexity");
  }

  score = Math.min(score, 4);

  return {
    valid: errors.length === 0,
    score,
    errors,
    suggestions,
  };
}

export function getPasswordStrengthLabel(score: number): string {
  switch (score) {
    case 0: return "Very Weak";
    case 1: return "Weak";
    case 2: return "Fair";
    case 3: return "Strong";
    case 4: return "Very Strong";
    default: return "Unknown";
  }
}

export function getPasswordStrengthColor(score: number): string {
  switch (score) {
    case 0: return "text-red-500";
    case 1: return "text-orange-500";
    case 2: return "text-yellow-500";
    case 3: return "text-emerald-500";
    case 4: return "text-green-500";
    default: return "text-gray-500";
  }
}

/** Human-readable rules for register / change-password forms. */
/**
 * English copy of the policy, kept for non-UI callers (server responses, tests).
 * Screens render the translated `auth.passwordRule.*` keys instead.
 */
export function getPasswordPolicyRules(): string[] {
  return [
    `At least ${MIN_LENGTH} characters (12+ recommended)`,
    "At least 3 of: lowercase, uppercase, number, special character",
    "Not a common or predictable password",
  ];
}

