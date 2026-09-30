/**
 * NEXA AI Gateway — observability.
 *
 * What is logged: request id, selected provider, selected model, latency,
 * success/failure, error category, attempt count, routing strategy.
 *
 * What is never logged: API keys, passwords, session tokens, and conversation
 * contents. `summarizeMessages` deliberately returns shape only (counts and
 * character totals), which is enough to debug a payload problem without
 * copying a user's private text into the log stream.
 */
import type { ChatMessage } from "./types";

export interface GatewayLogEvent {
  requestId: string;
  event:
    | "models"
    | "health"
    | "chat_request"
    | "attempt"
    | "fallback"
    | "success"
    | "failure"
    /** Credential check on the public `/v1/*` surface. Never logs the key. */
    | "auth_failure"
    /**
     * Quota control refused a request. Distinct from `failure` so a throttle wave
     * is not mistaken for an outage. Never logs the key or the bucket identity.
     */
    | "rate_limited";
  provider?: string;
  model?: string;
  strategy?: string;
  latencyMs?: number;
  attempts?: number;
  errorCategory?: string;
  errorCode?: string;
  /** Why an auth check failed. Never the credential itself. */
  reason?: string;
  fallbackUsed?: boolean;
  /** Shape-only payload summary. Never message contents. */
  request?: { count: number; roles: string; chars: number };
  note?: string;
}

let counter = 0;

/** Short, sortable, unique request id. Safe to return to clients. */
export function newRequestId(): string {
  counter = (counter + 1) % 1_000_000;
  return `gw_${Date.now().toString(36)}_${counter.toString(36).padStart(4, "0")}`;
}

export function summarizeMessages(messages: ChatMessage[]): {
  count: number;
  roles: string;
  chars: number;
} {
  const roles: Record<string, number> = {};
  let chars = 0;
  for (const message of messages) {
    roles[message.role] = (roles[message.role] ?? 0) + 1;
    chars += typeof message.content === "string" ? message.content.length : 0;
  }
  return {
    count: messages.length,
    roles: Object.entries(roles)
      .map(([role, n]) => `${role}:${n}`)
      .join(","),
    chars,
  };
}

/**
 * Emit one structured log line.
 *
 * Fields are already sanitized by the gateway before they reach here; this
 * function adds no data of its own.
 */
export function logGateway(event: GatewayLogEvent): void {
  const line = JSON.stringify({ scope: "nexa.gateway", ...event });
  if (event.event === "failure" || event.event === "auth_failure") {
    console.warn(line);
    return;
  }
  console.info(line);
}
