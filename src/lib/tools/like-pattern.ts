/**
 * LIKE/ILIKE pattern safety — the single shared implementation.
 *
 * It lives in its own module rather than beside one caller because there is more
 * than one caller (`file_search` and conversation title search), and a second
 * copy is a second chance to forget an escape.
 */

/**
 * Escape character for the LIKE/ILIKE patterns NEXA builds.
 *
 * PostgreSQL's default escape character for LIKE is backslash, but it is
 * declared explicitly here and paired with an explicit `ESCAPE` clause at every
 * call site, so the pattern and its escape character cannot drift apart.
 */
export const LIKE_ESCAPE_CHAR = "\\";

/**
 * Escape LIKE metacharacters in a user-supplied search term.
 *
 * `%` and `_` are wildcards in a LIKE pattern. Interpolated raw, a caller could
 * pass `%` and receive every row the tenant owns — which is both wrong (results
 * nobody asked for) and more expensive, because a guaranteed-match scan returns
 * on every row and so never short-circuits.
 *
 * The escape character itself must be escaped first, or a trailing backslash
 * would escape the closing `%` and produce an invalid pattern.
 */
export function sanitizeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `${LIKE_ESCAPE_CHAR}${match}`);
}
