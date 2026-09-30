/**
 * NEXA AI Gateway — bounded retry and fallback.
 *
 * The policy is small and explicit:
 *
 *  - A candidate is retried **only** for genuinely transient failures (timeout,
 *    rate limit, temporary upstream failure). An invalid model, a bad request,
 *    an authentication failure or a misconfiguration is never retried against
 *    the same target — repeating it cannot change the answer.
 *  - The chain advances for transient failures, authentication failures and
 *    unknown model errors. It stops immediately for a cancelled request, an
 *    invalid request, or a permanent configuration failure, because those need a
 *    human, not another provider.
 *  - Candidates and attempts per candidate are bounded, so no request can fan
 *    out indefinitely.
 */
import { envInt } from "./config";
import { GatewayError } from "./errors";
import type { GatewayProviderId, RoutingAttempt } from "./types";

export interface RetryPolicy {
  /** Attempts against one candidate, including the first. >= 1 */
  maxAttemptsPerCandidate: number;
  /** First backoff in ms; multiplied by the attempt number within a candidate. */
  baseBackoffMs: number;
  /** Hard ceiling on total attempts across the whole chain. */
  maxTotalAttempts: number;
}

export function defaultRetryPolicy(): RetryPolicy {
  return {
    maxAttemptsPerCandidate: envInt("NEXA_GATEWAY_MAX_PROVIDER_ATTEMPTS", 2, 1, 4),
    baseBackoffMs: envInt("NEXA_GATEWAY_RETRY_BACKOFF_MS", 250, 0, 5_000),
    maxTotalAttempts: envInt("NEXA_GATEWAY_MAX_TOTAL_ATTEMPTS", 6, 1, 20),
  };
}

export interface AttemptTarget {
  provider: GatewayProviderId;
  model: string;
}

export interface FallbackResult<T> {
  value: T;
  /** The candidate that produced the value. */
  target: AttemptTarget;
  attempts: RoutingAttempt[];
  fallbackUsed: boolean;
}

export interface RunWithFallbackOptions {
  signal?: AbortSignal;
  policy?: RetryPolicy;
  /** Called after a failed attempt, before any retry or fallback. */
  onAttemptFailure?: (input: {
    target: AttemptTarget;
    error: GatewayError;
    attempt: number;
    willRetry: boolean;
  }) => Promise<void> | void;
  /** Called when the chain advances to the next candidate. */
  onFallback?: (input: {
    from: AttemptTarget;
    to: AttemptTarget;
    error: GatewayError;
  }) => Promise<void> | void;
  /** Additional stop condition (for example: content was already delivered). */
  shouldStop?: (error: GatewayError) => boolean;
}

/**
 * Run `execute` against an ordered candidate chain.
 *
 * Rejects with the last `GatewayError` when every candidate is exhausted.
 */
export async function runWithFallback<T>(
  candidates: AttemptTarget[],
  execute: (target: AttemptTarget, attempt: number) => Promise<T>,
  options: RunWithFallbackOptions = {}
): Promise<FallbackResult<T>> {
  const policy = options.policy ?? defaultRetryPolicy();
  const attempts: RoutingAttempt[] = [];
  let totalAttempts = 0;
  let lastError: GatewayError | null = null;
  let previousTarget: AttemptTarget | null = null;

  for (const target of candidates) {
    if (options.signal?.aborted) throw cancelledError(target);

    if (previousTarget && lastError) {
      await options.onFallback?.({ from: previousTarget, to: target, error: lastError });
    }

    for (let attempt = 1; attempt <= policy.maxAttemptsPerCandidate; attempt += 1) {
      if (options.signal?.aborted) throw cancelledError(target);
      if (totalAttempts >= policy.maxTotalAttempts) throw exhaustedError(lastError, target);
      totalAttempts += 1;
      const started = Date.now();

      try {
        const value = await execute(target, attempt);
        attempts.push({
          provider: target.provider,
          model: target.model,
          outcome: "success",
          latencyMs: Date.now() - started,
        });
        return {
          value,
          target,
          attempts,
          fallbackUsed: attempts.some((entry) => entry.outcome !== "success"),
        };
      } catch (rawError) {
        const error = asGatewayError(rawError, target);

        // A cancellation is the caller's decision: stop immediately.
        if (error.category === "cancelled" || options.signal?.aborted) {
          attempts.push({
            provider: target.provider,
            model: target.model,
            outcome: "failed",
            errorCategory: "cancelled",
            latencyMs: Date.now() - started,
          });
          throw error;
        }

        const retrySame = error.retryableSameProvider && attempt < policy.maxAttemptsPerCandidate;
        attempts.push({
          provider: target.provider,
          model: target.model,
          outcome: "failed",
          errorCategory: error.category,
          latencyMs: Date.now() - started,
        });
        lastError = error;
        await options.onAttemptFailure?.({ target, error, attempt, willRetry: retrySame });

        if (retrySame && totalAttempts < policy.maxTotalAttempts) {
          await backoff(policy.baseBackoffMs * attempt, options.signal);
          continue;
        }
        break;
      }
    }

    // Candidate exhausted: may the chain continue at all?
    if (lastError && (!lastError.canFallback || options.shouldStop?.(lastError) === true)) {
      throw lastError;
    }
    previousTarget = target;
  }

  throw exhaustedError(lastError, previousTarget ?? candidates[candidates.length - 1]);
}

function asGatewayError(error: unknown, target: AttemptTarget): GatewayError {
  if (error instanceof GatewayError) return error;
  return new GatewayError(
    "GatewayError",
    error instanceof Error ? error.message : "Unknown gateway failure.",
    {
      category: "unknown",
      provider: target.provider,
      model: target.model,
      cause: error,
    }
  );
}

function cancelledError(target: AttemptTarget): GatewayError {
  return new GatewayError("GatewayError", "The request was cancelled.", {
    category: "cancelled",
    provider: target.provider,
    model: target.model,
  });
}

function exhaustedError(lastError: GatewayError | null, target: AttemptTarget): GatewayError {
  if (lastError) {
    return new GatewayError(lastError.code, lastError.message, {
      category: lastError.category,
      provider: lastError.provider ?? target.provider,
      model: lastError.model ?? target.model,
      status: lastError.status,
      upstreamStatus: lastError.upstreamStatus,
      cause: lastError,
    });
  }
  return new GatewayError(
    "ProviderUnavailable",
    "No eligible provider could serve this request.",
    { category: "temporary_upstream_failure", provider: target.provider, model: target.model }
  );
}

function backoff(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        new GatewayError("GatewayError", "The request was cancelled while waiting to retry.", {
          category: "cancelled",
        })
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
