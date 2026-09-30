/**
 * NEXA AI Gateway — SSE parser contract (Phase 4, cases A–K).
 *
 * The historical defect was an SSE event being split across network chunks, so
 * each case here is about *where the byte boundaries fall*, not the payload.
 * Every case asserts the invariants the UI depends on:
 *
 *   - no event lost, none duplicated, unrelated events never merged
 *   - an empty `data:` frame never becomes content (it renders as an empty
 *     Markdown/code block in the client)
 *   - `action` frames stay status text and never become assistant text
 *   - a UTF-8 character split across chunks is preserved
 */
import { describe, it, expect } from "vitest";
import { SseDecoder } from "@/lib/gateway/sse";

const encoder = new TextEncoder();

/** Feed a string to the decoder exactly as the given transport pieces. */
function decodePieces(pieces: string[]): string[] {
  const sse = new SseDecoder();
  const out: string[] = [];
  for (const piece of pieces) {
    for (const event of sse.decode(encoder.encode(piece))) out.push(event.data);
  }
  for (const event of sse.flush()) out.push(event.data);
  return out;
}

/** Feed a string in fixed-size byte slices (a deliberately hostile transport). */
function decodeInSlices(input: string, size: number): string[] {
  const bytes = encoder.encode(input);
  // ONE streaming decoder across every slice. Creating a fresh decoder per
  // slice would itself corrupt multi-byte characters and hide the very defect
  // these tests exist to catch.
  const decoder = new TextDecoder("utf-8");
  const pieces: string[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    pieces.push(decoder.decode(bytes.slice(i, i + size), { stream: true }));
  }
  pieces.push(decoder.decode());
  return decodePieces(pieces);
}

function splitAt(input: string, at: number): string[] {
  return [input.slice(0, at), input.slice(at)];
}

describe("Case A — two well-formed events in one stream", () => {
  const stream = 'data: {"type":"token","text":"Hello"}\n\ndata: {"type":"done"}\n\n';

  it("emits both, in order, exactly once", () => {
    expect(decodeInSlices(stream, stream.length)).toEqual([
      '{"type":"token","text":"Hello"}',
      '{"type":"done"}',
    ]);
  });
});

describe("Case B — one event split across two chunks, mid-JSON", () => {
  const stream = 'data: {"type":"token","text":"Hello"}\n\ndata: {"type":"done"}\n\n';
  const expected = ['{"type":"token","text":"Hello"}', '{"type":"done"}'];

  it("survives a split at every single byte position", () => {
    // The event boundary is never lost or duplicated, wherever the cut lands.
    for (let at = 0; at <= stream.length; at += 1) {
      expect(decodePieces(splitAt(stream, at)), `split at ${at}`).toEqual(expected);
    }
  });

  it("survives a split in the middle of the token text", () => {
    expect(decodePieces(['data: {"type":"token","text":"Hel', 'lo"}\n\n'])).toEqual([
      '{"type":"token","text":"Hello"}',
    ]);
  });
});

describe("Case C — splits exactly at CRLF boundaries", () => {
  const expected = ['{"a":1}', '{"b":2}'];

  it("handles a cut between CR and LF", () => {
    expect(decodePieces(['data: {"a":1}\r', '\n\r\ndata: {"b":2}\r\n\r\n'])).toEqual(expected);
  });

  it("handles a cut between LF and CR", () => {
    expect(decodePieces(['data: {"a":1}\r\n', '\r\ndata: {"b":2}\r\n\r\n'])).toEqual(expected);
  });

  it("accepts a bare CR terminator", () => {
    expect(decodeInSlices('data: {"a":1}\r\rdata: {"b":2}\r\r', 1)).toEqual(expected);
  });

  it("accepts CRLF and LF mixed in one stream", () => {
    expect(decodePieces(['data: {"a":1}\r\n\r\n', 'data: {"b":2}\n\n'])).toEqual(expected);
  });
});

describe("Case D — several events inside a single chunk", () => {
  it("emits each one exactly once and in order", () => {
    const stream =
      'data: {"n":1}\n\ndata: {"n":2}\n\ndata: {"n":3}\n\ndata: {"n":4}\n\ndata: {"n":5}\n\n';
    expect(decodeInSlices(stream, stream.length)).toEqual([
      '{"n":1}',
      '{"n":2}',
      '{"n":3}',
      '{"n":4}',
      '{"n":5}',
    ]);
  });

  it("yields the same set when the chunk is cut at every size", () => {
    const stream = 'data: {"n":1}\n\ndata: {"n":2}\n\ndata: {"n":3}\n\n';
    const expected = ['{"n":1}', '{"n":2}', '{"n":3}'];
    for (const size of [1, 2, 3, 5, 8, 13, 21]) {
      expect(decodeInSlices(stream, size), `size ${size}`).toEqual(expected);
    }
  });
});

describe("Case E — one event spread across many chunks", () => {
  const frame = 'data: {"type":"token","text":"spread"}\n\n';

  it("emits nothing until the terminating blank line arrives, then exactly once", () => {
    const sse = new SseDecoder();
    const emitted: string[] = [];
    // One character per write is the worst a transport can produce. Every
    // character up to the final blank line is a partial or terminated line and
    // must yield nothing — emitting early would deliver a truncated payload.
    for (let i = 0; i < frame.length - 1; i += 1) {
      for (const event of sse.decode(encoder.encode(frame[i]))) emitted.push(event.data);
      expect(emitted, `after ${i + 1}/${frame.length - 1} character(s)`).toEqual([]);
    }
    // The final newline is the blank line that dispatches the event.
    for (const event of sse.decode(encoder.encode(frame[frame.length - 1]))) {
      emitted.push(event.data);
    }
    expect(emitted).toEqual(['{"type":"token","text":"spread"}']);
  });

  it("emits the whole frame exactly once with no help from flush()", () => {
    const sse = new SseDecoder();
    const emitted: string[] = [];
    for (const char of frame) {
      for (const event of sse.decode(encoder.encode(char))) emitted.push(event.data);
    }
    expect(emitted).toEqual(['{"type":"token","text":"spread"}']);
    // flush() must not re-emit an event that was already dispatched.
    for (const event of sse.flush()) emitted.push(event.data);
    expect(emitted).toEqual(['{"type":"token","text":"spread"}']);
  });

  it("never emits a partial JSON payload as an event", () => {
    const sse = new SseDecoder();
    const emitted: string[] = [];
    for (const piece of ['data: {"typ', 'e":"tok', 'en","te']) {
      for (const event of sse.decode(encoder.encode(piece))) emitted.push(event.data);
    }
    expect(emitted).toEqual([]);
  });
});

describe("Case F — UTF-8 split across a chunk boundary", () => {
  it("reassembles a character cut mid-sequence", () => {
    const bytes = encoder.encode("data: 你好世界\n\n");
    // Cut inside the first 3-byte character, then inside the second.
    for (const cut of [8, 9, 11, 14]) {
      const sse = new SseDecoder();
      const out = [
        ...sse.decode(bytes.slice(0, cut)).map((e) => e.data),
        ...sse.decode(bytes.slice(cut)).map((e) => e.data),
        ...sse.flush().map((e) => e.data),
      ];
      expect(out, `cut at byte ${cut}`).toEqual(["你好世界"]);
    }
  });

  it("reassembles a string delivered one byte at a time", () => {
    const stream = "data: 🌍 café ✅\n\n";
    expect(decodeInSlices(stream, 1)).toEqual(["🌍 café ✅"]);
  });

  it("reassembles a multi-byte emoji at every slice size", () => {
    const stream = 'data: {"t":"👩‍💻"}\n\n';
    for (const size of [1, 2, 3, 4, 5]) {
      expect(decodeInSlices(stream, size), `size ${size}`).toEqual(['{"t":"👩‍💻"}']);
    }
  });
});

describe("Case G — empty token events", () => {
  it("emits an empty data payload as an empty string, not as lost text", () => {
    expect(decodeInSlices("data:\n\ndata: real\n\n", 1)).toEqual(["", "real"]);
  });

  it("emits nothing for a frame with no data field at all", () => {
    expect(decodeInSlices("event: ping\nid: 7\n\ndata: real\n\n", 1)).toEqual(["real"]);
  });

  it("keeps an empty event distinguishable from a missing one", () => {
    // The consumer drops "" before it can become an empty Markdown block; the
    // parser's job is to not swallow the events around it.
    expect(decodePieces(["data: \n\n", 'data: {"a":1}\n\n'])).toEqual(["", '{"a":1}']);
  });
});

describe("Case H/I — action events around content", () => {
  it("keeps an action event before the first token as its own event", () => {
    const out = decodeInSlices(
      'data: {"type":"action","text":"NEXA gateway: routing"}\n\ndata: {"t":"Hello"}\n\n',
      1
    );
    expect(out).toEqual(['{"type":"action","text":"NEXA gateway: routing"}', '{"t":"Hello"}']);
  });

  it("keeps an action event after the first token separate from the token", () => {
    const out = decodeInSlices(
      'data: {"t":"Hello"}\n\ndata: {"type":"action","text":"Falling back"}\n\ndata: {"t":" world"}\n\n',
      3
    );
    // Three distinct events: merging any two would put status text into the
    // assistant's answer.
    expect(out).toEqual([
      '{"t":"Hello"}',
      '{"type":"action","text":"Falling back"}',
      '{"t":" world"}',
    ]);
  });
});

describe("Case J/K — provider errors before and after content", () => {
  it("delivers an error that arrives before any token", () => {
    expect(decodeInSlices('data: {"type":"error","text":"upstream refused"}\n\n', 1)).toEqual([
      '{"type":"error","text":"upstream refused"}',
    ]);
  });

  it("delivers an error that arrives after content, as a separate event", () => {
    const out = decodeInSlices(
      'data: {"t":"Hello"}\n\ndata: {"type":"error","text":"connection reset"}\n\ndata: {"type":"done"}\n\n',
      2
    );
    expect(out).toEqual([
      '{"t":"Hello"}',
      '{"type":"error","text":"connection reset"}',
      '{"type":"done"}',
    ]);
  });

  it("keeps a [DONE] sentinel distinct from JSON", () => {
    expect(decodeInSlices('data: {"t":"x"}\n\ndata: [DONE]\n\n', 1)).toEqual([
      '{"t":"x"}',
      "[DONE]",
    ]);
  });
});

describe("Parser invariants under arbitrary fragmentation", () => {
  const stream =
    ": keep-alive\n\n" +
    'event: token\ndata: {"t":"Hel"}\n\n' +
    'data: {"t":"lo"}\n\n' +
    'data: {"t":" world"}\n\n' +
    "data: [DONE]\n\n";
  const expected = ['{"t":"Hel"}', '{"t":"lo"}', '{"t":" world"}', "[DONE]"];

  it("produces the identical event list for every chunk size from 1 upward", () => {
    expect(decodeInSlices(stream, stream.length)).toEqual(expected);
    for (let size = 1; size <= 40; size += 1) {
      expect(decodeInSlices(stream, size), `size ${size}`).toEqual(expected);
    }
  });

  it("never duplicates or drops an event at any chunk size", () => {
    for (const size of [1, 2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37]) {
      const out = decodeInSlices(stream, size);
      expect(out, `size ${size}`).toEqual(expected);
      // A duplicate would repeat a payload; a loss would shorten the list.
      expect(new Set(out).size, `size ${size}`).toBe(new Set(expected).size);
    }
  });

  it("carries event/id metadata without corrupting the data payload", () => {
    const sse = new SseDecoder();
    expect(sse.decode(encoder.encode("event: token\nid: 42\ndata: hi\n\n"))).toEqual([
      { data: "hi", event: "token", id: "42" },
    ]);
  });

  it("joins a multi-line data field with a newline", () => {
    const sse = new SseDecoder();
    expect(sse.decode(encoder.encode("data: line1\ndata: line2\n\n"))[0].data).toBe(
      "line1\nline2"
    );
  });
});
