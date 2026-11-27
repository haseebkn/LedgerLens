import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentStreamEvent, UsageSummary } from "financial-context-agent/streaming-types";
import { streamAgentEvents } from "../lib/sse.js";

export interface ToolTimelineItem {
  toolCallId: string;
  name: string;
  input: unknown;
  status: "running" | "done" | "error";
  summary?: string;
  durationMs?: number;
}

export interface SpanItem {
  spanId: string;
  spanType: "llm_call" | "tool_exec" | "citation_validation";
  label?: string;
  status: "running" | "done" | "error";
  durationMs?: number;
  usage?: NonNullable<Extract<AgentStreamEvent, { type: "span_end" }>["usage"]>;
}

export type CitationWarning = Pick<
  Extract<AgentStreamEvent, { type: "citation_warning" }>,
  "figure" | "sentence" | "reason" | "citedIds"
>;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolTimeline: ToolTimelineItem[];
  spans: SpanItem[];
  citedRowIds: string[];
  /** Dollar figures the agent's grounding check couldn't tie to a citation. */
  citationWarnings?: CitationWarning[];
  /** "stopped": the user pressed Stop. Not an error, and not sent as history. */
  status: "streaming" | "done" | "error" | "stopped";
  errorMessage?: string;
  usage?: UsageSummary;
  /** ms from send to the first model text, as measured by the agent. */
  timeToFirstTokenMs?: number | null;
  traceId?: string;
}

export type StreamFn = (
  message: string,
  history: { role: "user" | "assistant"; content: string }[],
  signal?: AbortSignal
) => AsyncGenerator<AgentStreamEvent>;

export const MAX_MESSAGE_CHARS = 8000;
const MAX_HISTORY_ENTRIES = 40;
const MAX_CONTEXT_CHARS = 64000;

/** Keep recent, complete turns; a failed or partial answer must not become trusted history. */
export function buildChatHistory(messages: ChatMessage[], userText: string) {
  const history: { role: "user" | "assistant"; content: string }[] = [];
  let chars = userText.length;
  for (let i = messages.length - 1; i > 0; i -= 2) {
    const answer = messages[i]!;
    const question = messages[i - 1]!;
    if (question.role !== "user" || answer.role !== "assistant" || answer.status !== "done") continue;
    if (!answer.content.trim() || answer.content.length > MAX_MESSAGE_CHARS) continue;
    if (question.content.length > MAX_MESSAGE_CHARS) continue;
    const pairChars = question.content.length + answer.content.length;
    if (history.length + 2 > MAX_HISTORY_ENTRIES || chars + pairChars > MAX_CONTEXT_CHARS) break;
    history.unshift({ role: "user", content: question.content }, { role: "assistant", content: answer.content });
    chars += pairChars;
  }
  while (history.length > 0 && new TextEncoder().encode(JSON.stringify({ message: userText, history })).byteLength > 128 * 1024) {
    history.splice(0, 2);
  }
  return history;
}

const defaultStreamFn: StreamFn = async function* (message, history, signal) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Chat request failed: ${response.status}`);
  }
  yield* streamAgentEvents(response);
};

function applyEvent(message: ChatMessage, event: AgentStreamEvent): ChatMessage {
  switch (event.type) {
    case "text_delta":
      return { ...message, content: message.content + event.text, traceId: event.traceId };
    case "text_correction":
      return { ...message, content: event.text };
    case "tool_call":
      return {
        ...message,
        toolTimeline: [
          ...message.toolTimeline,
          { toolCallId: event.toolCallId, name: event.name, input: event.input, status: "running" },
        ],
      };
    case "tool_result":
      return {
        ...message,
        toolTimeline: message.toolTimeline.map((item) =>
          item.toolCallId === event.toolCallId
            ? { ...item, status: event.isError ? "error" : "done", summary: event.summary, durationMs: event.durationMs }
            : item
        ),
      };
    case "span_start":
      return {
        ...message,
        spans: [
          ...message.spans,
          { spanId: event.spanId, spanType: event.spanType, label: event.label, status: "running" },
        ],
      };
    case "span_end":
      return {
        ...message,
        spans: message.spans.map((s) =>
          s.spanId === event.spanId
            ? { ...s, status: event.isError ? "error" : "done", durationMs: event.durationMs, usage: event.usage }
            : s
        ),
      };
    case "citation":
      return message.citedRowIds.includes(event.rowId)
        ? message
        : { ...message, citedRowIds: [...message.citedRowIds, event.rowId] };
    case "citation_warning":
      return {
        ...message,
        citationWarnings: [
          ...(message.citationWarnings ?? []),
          { figure: event.figure, sentence: event.sentence, reason: event.reason, citedIds: event.citedIds },
        ],
      };
    case "error":
      return event.fatal ? failMessage(message, event.message) : message;
    case "done":
      return {
        ...message, status: "done", usage: event.usage, traceId: event.traceId,
        timeToFirstTokenMs: event.timeToFirstTokenMs,
      };
    case "thinking_delta":
      return message; // not rendered yet — reserved for a future "show thinking" toggle
    default:
      return message;
  }
}

function failMessage(message: ChatMessage, errorMessage: string, status: "error" | "stopped" = "error"): ChatMessage {
  return {
    ...message,
    status,
    errorMessage,
    toolTimeline: message.toolTimeline.map((item) => item.status === "running" ? { ...item, status: "error" } : item),
    spans: message.spans.map((span) => span.status === "running" ? { ...span, status: "error" } : span),
  };
}

const STOPPED_MESSAGE = "Stopped. You can send another message.";

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `msg-${idCounter}`;
}

export function useAgentChat(streamFn: StreamFn = defaultStreamFn) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const activeRef = useRef<AbortController | null>(null);

  useEffect(() => () => activeRef.current?.abort(), []);

  const stop = useCallback(() => activeRef.current?.abort(), []);

  const send = useCallback(
    async (userText: string) => {
      userText = userText.trim();
      if (activeRef.current || !userText || userText.length > MAX_MESSAGE_CHARS) return;
      const controller = new AbortController();
      activeRef.current = controller;
      const history = buildChatHistory(messages, userText);

      const userMessage: ChatMessage = {
        id: nextId(),
        role: "user",
        content: userText,
        toolTimeline: [],
        spans: [],
        citedRowIds: [],
        status: "done",
      };
      const assistantId = nextId();
      const assistantMessage: ChatMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        toolTimeline: [],
        spans: [],
        citedRowIds: [],
        status: "streaming",
      };

      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setIsStreaming(true);

      const updateAssistant = (updater: (m: ChatMessage) => ChatMessage) => {
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? updater(m) : m)));
      };

      try {
        let terminal = false;
        for await (const event of streamFn(userText, history, controller.signal)) {
          if (controller.signal.aborted) break;
          updateAssistant((m) => applyEvent(m, event));
          if (event.type === "done" || (event.type === "error" && event.fatal)) {
            terminal = true;
            break;
          }
        }
        if (!terminal) {
          updateAssistant((m) => controller.signal.aborted
            ? failMessage(m, STOPPED_MESSAGE, "stopped")
            : failMessage(m, "The connection ended before the answer finished. Please try again."));
        }
      } catch (e) {
        updateAssistant((m) => controller.signal.aborted
          ? failMessage(m, STOPPED_MESSAGE, "stopped")
          : failMessage(m, e instanceof Error ? e.message : String(e)));
      } finally {
        activeRef.current = null;
        setIsStreaming(false);
      }
    },
    [messages, streamFn]
  );

  return { messages, isStreaming, send, stop };
}
