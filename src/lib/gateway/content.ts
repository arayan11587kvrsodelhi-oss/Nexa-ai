/**
 * NEXA AI Gateway — content accumulation.
 *
 * This module exists because of a real, reproduced defect class: assistant
 * text arriving as *snapshots* (the whole reply so far in every frame) was
 * appended as if it were a delta, so the reply — including the empty fenced
 * blocks some models emit — appeared many times over.
 *
 * `appendContentDelta` makes the semantics explicit and is the only supported
 * way to grow assistant content anywhere in NEXA (provider adapters, the
 * gateway, `/api/chat`, and the browser client):
 *
 *   append    : the incoming chunk is new text → append once
 *   snapshot  : the incoming chunk already contains what we have → replace
 *   ignored   : empty, exact duplicate, or stale/older snapshot → drop
 *
 * The return value reports which rule applied, so tests and logs can prove that
 * content was not applied twice.
 */

export type ContentDeltaKind = "append" | "snapshot" | "ignored";

export interface ContentDeltaResult {
  /** The content after applying the chunk. */
  next: string;
  kind: ContentDeltaKind;
  /**
   * The text a streaming consumer must be told about.
   *
   * For a snapshot this is ONLY the suffix beyond what has already been
   * delivered — never the whole snapshot. Forwarding the snapshot itself
   * re-sends text the client already rendered, which is precisely the
   * duplication defect this module exists to prevent. Empty when ignored.
   */
  emitted: string;
  /** Why a chunk was ignored — useful in server logs and assertions. */
  reason?: "empty" | "duplicate" | "stale_snapshot" | "not_text";
}

/**
 * Fold one incoming content chunk into the accumulated assistant text.
 *
 * Pure and total: it never throws and never mutates its inputs.
 */
export function appendContentDelta(accumulated: string, incoming: string): ContentDeltaResult {
  const base = accumulated;
  if (typeof incoming !== "string") {
    return { next: base, kind: "ignored", emitted: "", reason: "not_text" };
  }
  if (incoming.length === 0) {
    // Empty frames must never create content (and never create Markdown).
    return { next: base, kind: "ignored", emitted: "", reason: "empty" };
  }
  if (incoming === base) {
    // The provider re-sent exactly what we already have.
    return { next: base, kind: "ignored", emitted: "", reason: "duplicate" };
  }
  if (base.length === 0) {
    return { next: incoming, kind: "append", emitted: incoming };
  }
  if (incoming.length > base.length && incoming.startsWith(base)) {
    // Snapshot frame: it contains the whole reply so far. The accumulated text
    // becomes the snapshot, but the consumer is only told about the new suffix.
    return { next: incoming, kind: "snapshot", emitted: incoming.slice(base.length) };
  }
  if (base.length > incoming.length && base.startsWith(incoming)) {
    // An older snapshot arrived after a newer one; keep the longer text.
    return { next: base, kind: "ignored", emitted: "", reason: "stale_snapshot" };
  }
  return { next: base + incoming, kind: "append", emitted: incoming };
}

/** True when a chunk carries no renderable characters. */
export function isBlankContent(text: string): boolean {
  return text.trim().length === 0;
}

/**
 * Token estimate used only when a provider reports no usage.
 *
 * Marked `estimated` wherever it surfaces; NEXA never presents it as measured.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Accumulates assistant content plus the accounting needed to prove that
 * nothing was applied twice.
 */
export class ContentAccumulator {
  private content = "";
  private reasoning = "";
  public applied = 0;
  public duplicates = 0;
  public empty = 0;
  public snapshots = 0;

  public appendToken(chunk: string): ContentDeltaResult {
    const result = appendContentDelta(this.content, chunk);
    this.content = result.next;
    this.track(result);
    return result;
  }

  public appendReasoning(chunk: string): ContentDeltaResult {
    const result = appendContentDelta(this.reasoning, chunk);
    this.reasoning = result.next;
    if (result.kind === "ignored" && result.reason !== "not_text") {
      // Reasoning frames repeat at least as often as content frames.
      if (result.reason === "empty") this.empty += 1;
      else this.duplicates += 1;
    } else if (result.kind !== "ignored") {
      this.snapshots += result.kind === "snapshot" ? 1 : 0;
    }
    return result;
  }

  private track(result: ContentDeltaResult): void {
    if (result.kind === "ignored") {
      if (result.reason === "empty") this.empty += 1;
      else if (result.reason !== "not_text") this.duplicates += 1;
      return;
    }
    if (result.kind === "snapshot") this.snapshots += 1;
    this.applied += 1;
  }

  public get text(): string {
    return this.content;
  }

  public get reasoningText(): string {
    return this.reasoning;
  }
}
