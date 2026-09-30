/**
 * Phase 5.5 — provider retry / fallback amplification.
 *
 * The Phase 5.4 report claimed a maximum of 6 upstream attempts per client
 * request. This suite proves that number rather than repeating it: it drives
 * the real `runWithFallback` and counts actual invocations of the provider
 * callback, for both retryable and non-retryable failures.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { runWithFallback, defaultRetryPolicy } from "@/lib/gateway/retry";
import { GatewayError } from "@/lib/gateway/errors";
import type { GatewayErrorCategory } from "@/lib/gateway/errors";

const POLICY = { maxAttemptsPerCandidate: 2, baseBackoffMs: 0, maxTotalAttempts: 6 };

function failure(category: GatewayErrorCategory): GatewayError {
  return new GatewayError("GatewayError", `simulated ${category}`, { category });
}

const CANDIDATES = [
  { provider: "ollama" as const, model: "a" },
  { provider: "aihorde" as const, model: "b" },
  { provider: "vllm" as const, model: "c" },
  { provider: "openai_compatible" as const, model: "d" },
];

let calls: Array<{ provider: string; attempt: number }> = [];

/** Fails every time with `category`; records how many upstream calls happen. */
async function alwaysFails(category: GatewayErrorCategory): Promise<void> {
  calls = [];
  await runWithFallback(
    CANDIDATES,
    async (target, attempt) => {
      calls.push({ provider: target.provider, attempt });
      throw failure(category);
    },
    { policy: POLICY }
  ).catch(() => undefined);
}

/** Attempts made per provider, so "never retried" can be asserted directly. */
function attemptsPerProvider(): Record<string, number> {
  return calls.reduce<Record<string, number>>((acc, call) => {
    acc[call.provider] = (acc[call.provider] ?? 0) + 1;
    return acc;
  }, {});
}

beforeEach(() => {
  calls = [];
});

describe("retry amplification — hard ceiling", () => {
  it("never exceeds maxTotalAttempts, however many candidates exist", async () => {
    for (const category of [
      "timeout",
      "rate_limit",
      "temporary_upstream_failure",
    ] as GatewayErrorCategory[]) {
      await alwaysFails(category);
      // This is the number the Phase 5.4 report asserted. It is measured here.
      expect(calls.length, category).toBeLessThanOrEqual(POLICY.maxTotalAttempts);
    }
  });

  it("uses the whole budget on a genuinely retryable failure", async () => {
    await alwaysFails("timeout");
    // Proves the ceiling is reachable, not an artefact of bailing out early.
    expect(calls.length).toBe(POLICY.maxTotalAttempts);
  });

  it("fans out across more than one provider when retries are warranted", async () => {
    await alwaysFails("temporary_upstream_failure");
    // Fallback to another provider is intended behaviour, bounded by the cap.
    expect(new Set(calls.map((c) => c.provider)).size).toBeGreaterThan(1);
  });

  it("defaults to 6 total attempts in the shipped configuration", () => {
    expect(defaultRetryPolicy().maxTotalAttempts).toBe(6);
  });
});

describe("retry amplification — non-retryable classes are not retried", () => {
  it("does not retry the same provider after an invalid request", async () => {
    await alwaysFails("invalid_request");
    // One attempt, and the chain stops: repeating a bad request cannot help.
    expect(calls.length).toBe(1);
  });

  it("does not retry after a permanent configuration failure", async () => {
    await alwaysFails("permanent_configuration_failure");
    expect(calls.length).toBe(1);
  });

  it("stops immediately on cancellation", async () => {
    await alwaysFails("cancelled");
    expect(calls.length).toBe(1);
  });

  it("tries each provider at most once after an authentication failure", async () => {
    await alwaysFails("authentication_failure");
    // Not retried against the same provider, but a *different* provider may
    // legitimately hold valid credentials — so one call each, not one total.
    expect(Object.values(attemptsPerProvider()).every((n) => n === 1)).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(CANDIDATES.length);
  });

  it("does not treat an unclassified failure as transient", async () => {
    await alwaysFails("unknown");
    // `unknown` is deliberately not transient, so no same-provider retry.
    expect(Object.values(attemptsPerProvider()).every((n) => n === 1)).toBe(true);
  });
});

describe("retry amplification — success short-circuits", () => {
  it("makes exactly one call when the first provider succeeds", async () => {
    const result = await runWithFallback(
      CANDIDATES,
      async (target) => {
        calls.push({ provider: target.provider, attempt: 1 });
        return "ok";
      },
      { policy: POLICY }
    );
    expect(calls.length).toBe(1);
    expect(result.value).toBe("ok");
    expect(result.fallbackUsed).toBe(false);
  });

  it("contacts nothing after the candidate that succeeds", async () => {
    const result = await runWithFallback(
      CANDIDATES,
      async (target, attempt) => {
        calls.push({ provider: target.provider, attempt });
        if (target.provider === "aihorde") return "ok";
        throw failure("timeout");
      },
      { policy: POLICY }
    );
    expect(result.value).toBe("ok");
    expect(calls.length).toBeLessThanOrEqual(POLICY.maxTotalAttempts);
    expect(calls.some((c) => c.provider === "vllm")).toBe(false);
  });
});

describe("retry amplification — the agent route adds none", () => {
  it("never reaches the gateway, so it cannot multiply provider attempts", () => {
    // `/api/agents` calls `ToolExecutor.execute` (calculator, datetime,
    // file_search, web_search) and never `NexaGateway`. Asserted against the
    // source so the claim cannot rot silently.
    const source = readFileSync("src/app/api/agents/route.ts", "utf8");
    expect(source).not.toMatch(/NexaGateway|streamChat/);
  });
});
