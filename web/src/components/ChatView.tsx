import { useEffect, useRef, useState } from "react";
import { MAX_MESSAGE_CHARS, useAgentChat } from "../hooks/useAgentChat.js";
import { MessageBubble } from "./MessageBubble.js";
import { SourceDrawerProvider } from "./SourceDrawer.js";

const SUGGESTIONS = [
  "How much did I spend on Food and Drink?",
  "What's my current cash balance?",
  "Did I go rock climbing recently?",
  "Should I buy more AAPL?",
];

export function ChatView() {
  const { messages, isStreaming, send, stop, updateProposal } = useAgentChat();
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    setInput("");
    void send(trimmed);
  };

  return (
    <SourceDrawerProvider>
    <div className="chat-view">
      <div className="chat-scroll" role="log" aria-label="Conversation" aria-live="polite" aria-busy={isStreaming}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>Ask about your transactions, calendar events, or account balance.</p>
            <div className="suggestion-row">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="suggestion-chip" onClick={() => submit(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} onProposalUpdated={updateProposal} />
        ))}
        <div ref={bottomRef} />
      </div>

      <form
        className="chat-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
      >
        <input
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your finances…"
          disabled={isStreaming}
          aria-label="Message"
          maxLength={MAX_MESSAGE_CHARS}
        />
        {isStreaming ? (
          <button type="button" className="chat-send" onClick={stop}>Stop</button>
        ) : (
          <button type="submit" className="chat-send" disabled={!input.trim()}>Send</button>
        )}
      </form>
    </div>
    </SourceDrawerProvider>
  );
}
