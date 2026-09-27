import type { NextRequest } from "next/server";
import { PasswordResetTokenService } from "./tokens";

/**
 * Development-only password-reset delivery abstraction.
 *
 * Local development has no email provider, so the forgot-password route may
 * return the reset URL in the JSON body when NODE_ENV !== "production".
 * Production REQUIRES a configured provider — the route never returns the
 * URL there and never pretends an email was sent.
 *
 * Production provider configuration (configure one, then wire delivery in
 * `deliverPasswordReset`): RESEND_API_KEY / SMTP_HOST /
 * EMAIL_PROVIDER_URL / PASSWORD_RESET_MAIL_PROVIDER.
 */

export const PASSWORD_RESET_GENERIC_MESSAGE =
  "If an account exists for that email, a password reset link has been requested.";

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export function isEmailProviderConfigured(): boolean {
  return Boolean(
    process.env.RESEND_API_KEY ||
      process.env.SMTP_HOST ||
      process.env.EMAIL_PROVIDER_URL ||
      process.env.PASSWORD_RESET_MAIL_PROVIDER
  );
}

/**
 * Build the reset URL on the request origin (same-origin; no user-controlled
 * destination). Only path + opaque token — never email, user id, or hashes.
 */
export function buildPasswordResetUrl(req: NextRequest, rawToken: string): string {
  let origin = "http://localhost:3000";
  try {
    origin = req.nextUrl.origin || origin;
  } catch {
    /* fallback above */
  }
  return `${origin.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(rawToken)}`;
}

/**
 * Validate that a string looks like a reset path we built.
 * Rejects absolute URLs to other origins (no open redirect).
 */
export function isSafeResetPath(url: string): boolean {
  return url.startsWith("/reset-password?token=");
}

export function extractRawTokenFromUrl(url: string): string | null {
  try {
    const q = url.split("?")[1] ?? "";
    const params = new URLSearchParams(q);
    const t = params.get("token");
    return PasswordResetTokenService.isPlausible(t) ? (t as string) : null;
  } catch {
    return null;
  }
}

/** Cleanup predicate: rows with usedAt set or expired are disposable. */
export function isResetRowDisposable(row: {
  usedAt: Date | null;
  expiresAt: Date;
}): boolean {
  if (row.usedAt) return true;
  return row.expiresAt.getTime() <= Date.now();
}

/**
 * Production delivery hook. Returns true when a provider handled delivery.
 * Currently no provider is wired in this codebase, so production keeps the
 * generic response and logs a server-side warning (never the token).
 * Wire real delivery here without changing the routes.
 */
export async function deliverPasswordReset(_email: string): Promise<boolean> {
  if (!isProduction()) return false;
  if (!isEmailProviderConfigured()) {
    console.warn("[nexa] password reset requested but no email provider is configured.");
    return false;
  }
  // TODO: integrate the configured provider (Resend/SMTP/etc.) here.
  console.warn("[nexa] password reset email provider is configured but delivery is not wired yet.");
  return false;
}
