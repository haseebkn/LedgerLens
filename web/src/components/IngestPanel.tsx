import { useId, useState, type ChangeEvent, type FormEvent } from "react";
import type { ProposalPayload } from "financial-context-agent/streaming-types";
import { apiFetch, errorMessage } from "../lib/api.js";
import { CitationChip } from "./CitationChip.js";

export interface IngestResponse {
  traceId: string;
  model: string;
  document: {
    docId: string;
    kind: "transcript" | "eml";
    householdId: string;
    householdName: string;
    title: string;
    date: string;
  };
  extraction: {
    attendees: string[];
    lifeEvents: { summary: string; target_date?: string }[];
    injectionDetected: boolean;
    injectionWarnings: string[];
    quarantinedItems: { kind: string; field?: string; reason: string; valuePreview: string }[];
  };
  proposals: ProposalPayload[];
}

export function IngestPanel({ onIngested }: { onIngested: () => void }) {
  const [kind, setKind] = useState<"transcript" | "eml">("transcript");
  const [filename, setFilename] = useState<string>("");
  const [clientId, setClientId] = useState<string>("");
  const [content, setContent] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IngestResponse | null>(null);

  const fileInputId = useId();
  const clientInputId = useId();
  const contentInputId = useId();

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setFilename(file.name);
    if (file.name.toLowerCase().endsWith(".eml")) {
      setKind("eml");
    } else {
      setKind("transcript");
    }
    try {
      const text = await file.text();
      setContent(text);
    } catch {
      setError("Could not read the selected file.");
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!content.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          content: content.trim(),
          ...(filename.trim() ? { filename: filename.trim() } : {}),
          ...(clientId.trim() ? { clientId: clientId.trim() } : {}),
        }),
      });
      if (!res.ok) {
        throw new Error(await errorMessage(res, `Ingest failed (${res.status})`));
      }
      const data = (await res.json()) as IngestResponse;
      setResult(data);
      setContent("");
      setFilename("");
      onIngested();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="panel-section ingest-panel" aria-label="Ingest meeting note or email">
      <div className="ingest-header">
        <div>
          <h3>Ingest meeting note or email (.eml)</h3>
          <p className="muted">
            Extracts attendees, life events, action items, CRM changes, and follow-up drafts into pending proposals.
            Uploaded text is treated as untrusted data and never writes to CRM or tasks without advisor approval.
          </p>
        </div>
      </div>

      <form className="ingest-form" onSubmit={handleSubmit}>
        <div className="ingest-controls">
          <div className="ingest-kind-group" role="group" aria-label="Document type">
            <button
              type="button"
              className={`proposal-btn ${kind === "transcript" ? "ingest-kind-btn--active" : ""}`}
              aria-pressed={kind === "transcript"}
              onClick={() => setKind("transcript")}
            >
              Meeting transcript
            </button>
            <button
              type="button"
              className={`proposal-btn ${kind === "eml" ? "ingest-kind-btn--active" : ""}`}
              aria-pressed={kind === "eml"}
              onClick={() => setKind("eml")}
            >
              Email (.eml)
            </button>
          </div>

          <label className="ingest-file-label" htmlFor={fileInputId}>
            <span>{filename ? `File: ${filename}` : "Upload .txt, .md, or .eml"}</span>
            <input
              id={fileInputId}
              type="file"
              accept=".txt,.md,.eml,text/plain,message/rfc822"
              onChange={handleFileChange}
              disabled={submitting}
            />
          </label>

          <div className="ingest-client-hint">
            <label htmlFor={clientInputId} className="proposal-field-name">
              Client hint (optional)
            </label>
            <input
              id={clientInputId}
              type="text"
              placeholder="e.g. Priya Nair or hh_priya_nair"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              disabled={submitting}
            />
          </div>
        </div>

        <div className="proposal-edit-field">
          <label htmlFor={contentInputId} className="proposal-field-name">
            {kind === "eml" ? "Raw .eml email contents" : "Meeting transcript"}
          </label>
          <textarea
            id={contentInputId}
            rows={5}
            placeholder={
              kind === "eml"
                ? "Paste raw RFC-5322 email headers & body (From, To, Subject, Date) or upload a .eml file..."
                : "Paste meeting transcript or upload a .txt / .md file..."
            }
            value={content}
            onChange={(e) => setContent(e.target.value)}
            disabled={submitting}
          />
        </div>

        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}

        <div className="proposal-actions">
          <button
            type="submit"
            className="proposal-btn proposal-btn--approve"
            disabled={submitting || !content.trim()}
          >
            {submitting ? "Extracting…" : "Extract & Propose"}
          </button>
        </div>
      </form>

      {result && (
        <div className="ingest-result" aria-live="polite">
          <div className="ingest-result-head">
            <span>
              Stored for <strong>{result.document.householdName}</strong> ({result.document.date}):{" "}
              <CitationChip rowId={result.document.docId} />
            </span>
            <span className="muted">
              {result.proposals.length} pending {result.proposals.length === 1 ? "proposal" : "proposals"} created
            </span>
          </div>

          {result.extraction.attendees.length > 0 && (
            <p className="ingest-meta">
              <span className="muted">Attendees: </span>
              {result.extraction.attendees.join(", ")}
            </p>
          )}

          {result.extraction.lifeEvents.length > 0 && (
            <ul className="ingest-events">
              {result.extraction.lifeEvents.map((ev, idx) => (
                <li key={`${ev.summary}-${idx}`}>
                  {ev.summary}
                  {ev.target_date ? <span className="mono muted"> ({ev.target_date})</span> : null}
                </li>
              ))}
            </ul>
          )}

          {result.extraction.injectionDetected && (
            <div className="ingest-warning" role="alert">
              <strong>Prompt-injection attempt detected &amp; isolated</strong>
              {result.extraction.quarantinedItems.length > 0 && (
                <p>
                  Quarantined {result.extraction.quarantinedItems.length} suspicious{" "}
                  {result.extraction.quarantinedItems.length === 1 ? "proposal" : "proposals"} so no unauthorized
                  actions were proposed or executed.
                </p>
              )}
              {result.extraction.injectionWarnings.length > 0 && (
                <ul>
                  {result.extraction.injectionWarnings.map((w, idx) => (
                    <li key={`${w}-${idx}`}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
