export const MASTER_PASSWORD_MIN_LENGTH = 6;
export const MASTER_PASSWORD_MAX_LENGTH = 128;

export function validateMasterPassword(password: string): string | null {
  if (
    password.length < MASTER_PASSWORD_MIN_LENGTH ||
    password.length > MASTER_PASSWORD_MAX_LENGTH
  ) {
    return `MASTER_PASSWORD must be ${MASTER_PASSWORD_MIN_LENGTH}–${MASTER_PASSWORD_MAX_LENGTH} characters`;
  }
  return null;
}
