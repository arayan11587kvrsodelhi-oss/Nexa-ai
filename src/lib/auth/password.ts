import bcrypt from "bcryptjs";

/**
 * Password hashing.
 *
 * Only bcrypt hashes are ever stored — the plaintext password exists solely as
 * a function argument for the lifetime of one request and is never logged,
 * returned, or persisted.
 */
export const PasswordService = {
  /**
   * Reject degenerate inputs before hashing. Mirrors the signup rule
   * (>= 8 characters) so any future caller cannot bypass it, and caps the
   * input length to bound bcrypt work.
   */
  assertAcceptable(plain: string): void {
    if (typeof plain !== "string" || plain.length < 8 || plain.length > 200) {
      throw new Error("Password must be a string of 8 to 200 characters.");
    }
  },

  /** Hash a plaintext password with a per-password random salt. */
  async hash(plain: string): Promise<string> {
    this.assertAcceptable(plain);
    return bcrypt.hash(plain, 12);
  },

  /** Constant-time-ish comparison via bcrypt. Never throws on mismatch. */
  async verify(plain: string, hash: string): Promise<boolean> {
    try {
      return await bcrypt.compare(plain, hash);
    } catch {
      return false;
    }
  },
};
