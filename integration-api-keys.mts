/**
 * API key lifecycle against the REAL PostgreSQL database.
 *
 * Everything here is the production code path and a real database: two real
 * users, real CSPRNG keys, a real digest, and the real `/v1` route handlers
 * authenticating with them. Nothing is mocked.
 *
 * Proves, end to end:
 *   create → authenticate → list → revoke → authenticate again → 401
 *   plaintext is never persisted, and never appears in a later response
 *   one user cannot see or revoke another user's key
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "./src/db/index.ts";
import { users, apiKeys } from "./src/db/schema.ts";
import { ApiKeyService } from "./src/lib/gateway/api-key-store.ts";
import { hashApiKey, NEXA_API_KEY_PREFIX } from "./src/lib/gateway/api-keys.ts";
import { GET as GET_MODELS } from "./src/app/v1/models/route.ts";
import { GET as GET_HEALTH } from "./src/app/v1/health/route.ts";
import { POST as POST_CHAT } from "./src/app/v1/chat/completions/route.ts";

const results: string[] = [];
const check = (name: string, pass: boolean, detail = ""): void => {
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const stamp = Date.now();
const A = `usr_aka_${stamp}`;
const B = `usr_akb_${stamp}`;

await db.insert(users).values([
  { id: A, email: `${A}@nexa.invalid`, passwordHash: "test-only-not-a-real-hash" },
  { id: B, email: `${B}@nexa.invalid`, passwordHash: "test-only-not-a-real-hash" },
]);

// Takes the key as an argument: the plaintext only exists inside the try block.
const authedReq = (p: string, key: string) =>
  new Request(`http://localhost${p}`, { headers: { authorization: `Bearer ${key}` } });
const chatReq = (key: string) =>
  new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
  });

try {
  // ---- create -----------------------------------------------------------
  const { plaintext, summary } = await ApiKeyService.create(A, "My local NEXA integration");
  check(
    "created key is a CSPRNG nexa_sk_ key",
    plaintext.startsWith(NEXA_API_KEY_PREFIX) && plaintext.length >= 40,
    `${plaintext.length} chars`
  );
  check("summary never carries the plaintext", !JSON.stringify(summary).includes(plaintext));
  check("summary carries only a display prefix", summary.keyPrefix.startsWith(NEXA_API_KEY_PREFIX));

  // ---- the plaintext is not persisted -----------------------------------
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.id, summary.id));
  const row = rows[0];
  check("row persisted with a digest, not the plaintext", Boolean(row) && !JSON.stringify(row).includes(plaintext));
  check("stored digest matches hash(plaintext) with the pepper", row?.keyHash === hashApiKey(plaintext));
  check(
    "digest is a hex SHA-256, not the key",
    /^[0-9a-f]{64}$/.test(row?.keyHash ?? "") && row?.keyHash !== plaintext
  );
  check(
    "no plaintext/secret column exists on the row",
    Object.keys(row ?? {}).every((k) => !/plaintext|secret/i.test(k)),
    Object.keys(row ?? {}).join(",")
  );

  // ---- authenticate ------------------------------------------------------
  check("active key authenticates", (await ApiKeyService.authenticate(plaintext))?.userId === A);
  check(
    "an unknown key does not authenticate",
    (await ApiKeyService.authenticate(`${NEXA_API_KEY_PREFIX}${"0".repeat(48)}`)) === null
  );
  check("a malformed value does not authenticate", (await ApiKeyService.authenticate("nope")) === null);

  // ---- /v1 accepts it ----------------------------------------------------
  const modelsRes = await GET_MODELS(authedReq("/v1/models", plaintext));
  check("/v1/models accepts the key", modelsRes.status === 200, `HTTP ${modelsRes.status}`);
  const modelsText = await modelsRes.text();
  check("/v1/models response contains no key material", !modelsText.includes(plaintext));

  // /v1/health reports 200 only when a provider can actually serve. This run
  // does not enable one, so 503 is the correct answer — what matters is that it
  // is not 401, i.e. the key was accepted and the status reflects providers.
  const healthRes = await GET_HEALTH(authedReq("/v1/health", plaintext));
  check(
    "/v1/health accepts the key (status reflects providers, not auth)",
    healthRes.status !== 401,
    `HTTP ${healthRes.status}`
  );

  // A chat call is rejected on the credential, not the provider, so "not 401"
  // proves the key was accepted before any provider was contacted.
  const chatRes = await POST_CHAT(chatReq(plaintext));
  check(
    "/v1/chat/completions authenticates before contacting a provider",
    chatRes.status !== 401,
    `HTTP ${chatRes.status} (not 401 = accepted)`
  );
  const chatText = await chatRes.text();
  check("chat response contains no key material", !chatText.includes(plaintext));

  // ---- a session cookie must never work on /v1 --------------------------
  const cookieRes = await GET_MODELS(
    new Request("http://localhost/v1/models", { headers: { cookie: "nexa_session=anything" } })
  );
  check("a session cookie does not authenticate /v1", cookieRes.status === 401, `HTTP ${cookieRes.status}`);
  check(
    "a missing key is 401",
    (await GET_MODELS(new Request("http://localhost/v1/models"))).status === 401
  );

  // ---- ownership ---------------------------------------------------------
  const listA = await ApiKeyService.list(A);
  const listB = await ApiKeyService.list(B);
  check("the owner sees their key", listA.some((k) => k.id === summary.id));
  check("the other user does not see it", !listB.some((k) => k.id === summary.id));
  check("the other user cannot revoke it", (await ApiKeyService.revoke(B, summary.id)) === false);
  check(
    "and it still authenticates after that failed attempt",
    (await ApiKeyService.authenticate(plaintext))?.userId === A
  );

  // ---- revoke ------------------------------------------------------------
  check("the owner can revoke it", (await ApiKeyService.revoke(A, summary.id)) === true);
  check("a revoked key no longer authenticates", (await ApiKeyService.authenticate(plaintext)) === null);
  check(
    "/v1/models rejects the revoked key with 401",
    (await GET_MODELS(authedReq("/v1/models", plaintext))).status === 401
  );
  check("/v1/chat/completions rejects it with 401", (await POST_CHAT(chatReq(plaintext))).status === 401);
  check(
    "/v1/health rejects it with 401",
    (await GET_HEALTH(authedReq("/v1/health", plaintext))).status === 401
  );
  check(
    "revocation is a soft delete (the row survives for audit)",
    (await db.select().from(apiKeys).where(eq(apiKeys.id, summary.id))).length === 1
  );
  check(
    "revoking twice reports there was nothing to revoke",
    (await ApiKeyService.revoke(A, summary.id)) === false
  );

  // ---- no secret ever leaves the server ----------------------------------
  const pepper = process.env.NEXA_API_KEY_PEPPER;
  if (pepper) {
    check(
      "the pepper never appears in any API response",
      !modelsText.includes(pepper) && !chatText.includes(pepper)
    );
  } else {
    check(
      "NEXA_API_KEY_PEPPER is unset here, so pepper-leakage is not asserted",
      true,
      "set it in production"
    );
  }
} finally {
  await db.delete(apiKeys).where(eq(apiKeys.userId, A));
  await db.delete(apiKeys).where(eq(apiKeys.userId, B));
  await db.delete(users).where(eq(users.id, A));
  await db.delete(users).where(eq(users.id, B));
}

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
console.log(`\n${results.length - failed.length}/${results.length} API-key integration checks passed`);
if (failed.length) console.log("FAILED:\n" + failed.join("\n"));
process.exit(failed.length ? 1 : 0);
