import type { AgentStreamEvent } from "financial-context-agent/streaming-types";

/**
 * Parses a raw SSE byte stream into AgentStreamEvent objects. Frames are
 * `data: {...}\n\n` (see agent/src/streaming-types.ts's toSseFrame), but a
 * network chunk can split a frame anywhere — mid-JSON, mid-delimiter, or
 * bundle several frames together. This buffers across chunks and only
 * emits once a full `\n\n`-terminated frame has arrived.
 */
export class SseFrameParser {
  private buffer = "";

  /** Feed one chunk of decoded text; returns any complete events it produced. */
  push(chunk: string): AgentStreamEvent[] {
    this.buffer += chunk;
    const events: AgentStreamEvent[] = [];

    let delimiter: RegExpExecArray | null;
    while ((delimiter = /\r?\n\r?\n/.exec(this.buffer)) !== null) {
      const boundary = delimiter.index;
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + delimiter[0].length);

      const json = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!json) continue;

      try {
        events.push(JSON.parse(json) as AgentStreamEvent);
      } catch {
        // Malformed frame — skip it rather than crash the whole stream.
        // A single bad frame shouldn't take down an otherwise-working turn.
      }
    }

    return events;
  }
}

/** Reads a fetch Response's SSE body, yielding parsed events as they arrive. */
export async function* streamAgentEvents(response: Response): AsyncGenerator<AgentStreamEvent> {
  if (!response.body) throw new Error("Response has no readable body.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseFrameParser();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        yield event;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
