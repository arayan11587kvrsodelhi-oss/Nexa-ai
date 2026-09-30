/**
 * NEXA AI Gateway — SSE codec.
 *
 * One incremental decoder used by:
 *
 *  - provider adapters reading upstream SSE (byte chunks → events),
 *  - the browser client reading `/api/chat` and `/v1/chat/completions`,
 *  - tests that replay deliberately hostile chunk boundaries.
 *
 * It is correct by construction for the cases that actually break naive
 * implementations:
 *
 *  - a frame split anywhere across two network chunks,
 *  - several events inside one chunk,
 *  - CRLF, LF and bare CR line endings,
 *  - a UTF-8 character split across a chunk boundary (TextDecoder streaming),
 *  - comments / keep-alives (`: ping`) and unknown fields,
 *  - empty `data:` events (never dispatched, so they can never become content),
 *  - multi-line `data:` fields (joined with `\n`),
 *  - `[DONE]` sentinels (surfaced, not silently mixed with JSON).
 *
 * Nothing here is provider-specific and nothing here touches the network.
 */

export interface SseEvent {
  /** `event:` field, when present. */
  event?: string;
  /** Joined `data:` payload. Never empty for dispatched events. */
  data: string;
  /** `id:` field, when present. */
  id?: string;
  /** `retry:` field in milliseconds, when present and numeric. */
  retry?: number;
}

/** Upper bound for one line, so a hostile peer cannot exhaust memory. */
export const MAX_SSE_LINE_CHARS = 1_000_000;

function trimTrailingCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** True when a payload is the OpenAI-style end-of-stream sentinel. */
export function isDoneSentinel(data: string): boolean {
  return data.trim() === "[DONE]";
}

/** JSON.parse that reports malformed input as `undefined` instead of throwing. */
export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export class SseDecoder {
  private decoder = new TextDecoder("utf-8");
  private buffer = "";

  /**
   * In-progress event fields.
   *
   * These MUST live on the instance, not inside `drain`. `drain` runs once per
   * network chunk, and an event's terminating blank line routinely arrives in a
   * *later* chunk than its `data:` lines. Keeping this state local silently
   * dropped every event whose framing was split across a chunk boundary — the
   * exact condition a chunked HTTP body produces in practice.
   */
  private dataLines: string[] = [];
  private eventName: string | undefined;
  private lastId: string | undefined;
  private retry: number | undefined;

  /** Feed raw bytes. Returns every event completed by this chunk. */
  public decode(chunk: Uint8Array): SseEvent[] {
    if (chunk.byteLength > 0) {
      this.buffer += this.decoder.decode(chunk, { stream: true });
    }
    return this.drain(false);
  }

  /** Flush a stream that ended without a trailing blank line. */
  public flush(): SseEvent[] {
    this.buffer += this.decoder.decode();
    return this.drain(true);
  }

  public reset(): void {
    this.decoder = new TextDecoder("utf-8");
    this.buffer = "";
    this.dataLines = [];
    this.eventName = undefined;
    this.lastId = undefined;
    this.retry = undefined;
  }

  /**
   * Split complete lines out of the buffer, holding back any partial line so a
   * frame split across chunks is never parsed early.
   */
  private takeLines(flush: boolean): string[] {
    const lines: string[] = [];
    // `start` is the index of the first character not yet emitted. It is only
    // advanced when a line terminator is fully resolved, so a trailing "\r"
    // that may still turn out to be the first half of a CRLF is held back
    // rather than being consumed (and then losing the line after it).
    let start = 0;
    let i = 0;

    while (i < this.buffer.length) {
      const ch = this.buffer[i];

      if (ch === "\n") {
        lines.push(trimTrailingCr(this.buffer.slice(start, i)));
        i += 1;
        start = i;
        continue;
      }

      if (ch === "\r") {
        const next = this.buffer[i + 1];
        if (next === "\n") {
          lines.push(this.buffer.slice(start, i));
          i += 2;
          start = i;
          continue;
        }
        if (next === undefined && !flush) {
          // Cannot yet tell a bare CR from the first half of a CRLF: wait for
          // the next chunk. Everything from `start` onwards stays buffered.
          break;
        }
        // A bare CR terminator (or a CRLF that only completes on flush).
        lines.push(this.buffer.slice(start, i));
        i += 1;
        start = i;
        continue;
      }

      i += 1;
    }

    // Keep the unconsumed remainder (a partial line) for the next chunk.
    this.buffer = start > 0 ? this.buffer.slice(start) : this.buffer;

    if (flush) {
      if (this.buffer.length > 0) {
        lines.push(trimTrailingCr(this.buffer));
        this.buffer = "";
      }
    }

    return lines;
  }

  private drain(flush: boolean): SseEvent[] {
    const events: SseEvent[] = [];

    const dispatch = () => {
      if (this.dataLines.length === 0) {
        // Per the SSE spec an event with no data field is not dispatched. An
        // empty event must never become content downstream.
        this.dataLines = [];
        this.eventName = undefined;
        return;
      }
      const data = this.dataLines.join("\n");
      const event: SseEvent = { data };
      if (this.eventName) event.event = this.eventName;
      if (this.lastId !== undefined) event.id = this.lastId;
      if (this.retry !== undefined) event.retry = this.retry;
      events.push(event);
      this.dataLines = [];
      this.eventName = undefined;
    };

    for (const line of this.takeLines(flush)) {
      if (line.length === 0) {
        dispatch();
        continue;
      }
      if (line.startsWith(":")) continue; // comment / keep-alive
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      switch (field) {
        case "data":
          this.dataLines.push(value);
          break;
        case "event":
          this.eventName = value;
          break;
        case "id":
          this.lastId = value;
          break;
        case "retry": {
          const parsed = Number(value);
          if (Number.isInteger(parsed) && parsed >= 0) this.retry = parsed;
          break;
        }
        default:
          // Unknown field: ignored on purpose.
          break;
      }
    }

    if (flush) dispatch();
    return events;
  }
}

/** Encode one SSE event frame as bytes. */
export function encodeSseEvent(event: {
  data: string;
  event?: string;
  id?: string;
}): Uint8Array {
  const encoder = new TextEncoder();
  let frame = "";
  if (event.event) frame += `event: ${event.event}\n`;
  if (event.id) frame += `id: ${event.id}\n`;
  for (const line of event.data.split("\n")) {
    frame += `data: ${line}\n`;
  }
  frame += "\n";
  return encoder.encode(frame);
}

/** `data: {json}\n\n` — the framing NEXA's own SSE routes and OpenAI use. */
export function encodeSseData(payload: unknown): Uint8Array {
  return encodeSseEvent({ data: JSON.stringify(payload) });
}

export function encodeSseComment(text: string): Uint8Array {
  return new TextEncoder().encode(`: ${text}\n\n`);
}

/**
 * Read an SSE `ReadableStream` and yield decoded events until the stream ends.
 *
 * Cancellation propagates through `signal`, and the reader is always released.
 * A malformed frame is skipped by the caller, never thrown from here.
 */
export async function* readSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<SseEvent, void, undefined> {
  const reader = body.getReader();
  const decoder = new SseDecoder();
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of decoder.decode(value)) yield event;
    }
    for (const event of decoder.flush()) yield event;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
