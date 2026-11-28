import { useState } from "react";
import type { ProposalPayload } from "financial-context-agent/streaming-types";
import { apiFetch, errorMessage } from "../lib/api.js";
import { CitationChip } from "./CitationChip.js";

const KIND_LABEL: Record<ProposalPayload["kind"], string> = {
  crm_update: "CRM Update",
  draft_follow_up: "Follow-Up Email Draft",
  create_task: "New Task",
};

function formatVal(val: unknown): string {
  if (val === null || val === undefined || val === "") return "—";
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

/**
 * Interactive governance card for a pending or decided advisor proposal.
 * Shows the exact field diff (`field: old -> new`), clickable citation chips
 * opening the Source Drawer, and Approve / Edit / Reject controls backed by
 * the server's append-only audit trail.
 */
export function ProposalCard({
  proposal,
  onUpdated,
}: {
  proposal: ProposalPayload;
  onUpdated?: (updated: ProposalPayload) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftAfter, setDraftAfter] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(proposal.after).map(([k, v]) => [k, formatVal(v)])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: "approve" | "reject", edited?: Record<string, string>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/proposals/${encodeURIComponent(proposal.proposalId)}/${decision}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: edited ? JSON.stringify({ after: edited }) : JSON.stringify({}),
      });
      if (!res.ok) throw new Error(await errorMessage(res, `Failed to ${decision} proposal (${res.status})`));
      const data = (await res.json()) as { proposal: ProposalPayload };
      setEditing(false);
      onUpdated?.(data.proposal);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const fields = Object.keys(proposal.after);
  const isPending = proposal.status === "pending";

  return (
    <article className="proposal-card" aria-label={`${KIND_LABEL[proposal.kind]} proposal for ${proposal.householdName}`}>
      <header className="proposal-card-header">
        <div>
          <span className="proposal-kind">{KIND_LABEL[proposal.kind]}</span>
          <strong className="proposal-household">{proposal.householdName}</strong>
        </div>
        <span className={`status-pill status-pill--${proposal.status}`}>{proposal.status}</span>
      </header>

      <p className="proposal-summary">{proposal.summary}</p>

      <div className="proposal-diff">
        {editing ? (
          <div className="proposal-edit-form">
            {fields.map((field) => (
              <label key={field} className="proposal-edit-field">
                <span className="proposal-field-name">{field}</span>
                {field === "body" || field === "notes_summary" ? (
                  <textarea
                    rows={3}
                    value={draftAfter[field] ?? ""}
                    onChange={(e) => setDraftAfter((prev) => ({ ...prev, [field]: e.target.value }))}
                  />
                ) : (
                  <input
                    type="text"
                    value={draftAfter[field] ?? ""}
                    onChange={(e) => setDraftAfter((prev) => ({ ...prev, [field]: e.target.value }))}
                  />
                )}
              </label>
            ))}
          </div>
        ) : (
          <dl className="proposal-diff-list">
            {fields.map((field) => (
              <div key={field} className="proposal-diff-row">
                <dt className="proposal-field-name">{field}</dt>
                <dd className="proposal-field-change">
                  {proposal.kind === "crm_update" && (
                    <>
                      <span className="proposal-old">{formatVal(proposal.before[field])}</span>
                      <span className="proposal-arrow" aria-hidden="true">→</span>
                    </>
                  )}
                  <span className="proposal-new">{formatVal(proposal.after[field])}</span>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      {proposal.sources.length > 0 && (
        <div className="proposal-sources">
          <span className="muted">Sources:</span>{" "}
          {proposal.sources.map((src) => (
            <CitationChip key={src} rowId={src} />
          ))}
        </div>
      )}

      {error && <p className="message-text--error" role="alert">{error}</p>}

      {isPending && (
        <div className="proposal-actions">
          {editing ? (
            <>
              <button type="button" className="proposal-btn proposal-btn--approve" disabled={busy} onClick={() => void decide("approve", draftAfter)}>
                {busy ? "Saving…" : "Save & Approve"}
              </button>
              <button type="button" className="proposal-btn" disabled={busy} onClick={() => setEditing(false)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" className="proposal-btn proposal-btn--approve" disabled={busy} onClick={() => void decide("approve")}>
                {busy ? "Applying…" : "Approve"}
              </button>
              <button type="button" className="proposal-btn" disabled={busy} onClick={() => setEditing(true)}>
                Edit
              </button>
              <button type="button" className="proposal-btn proposal-btn--reject" disabled={busy} onClick={() => void decide("reject")}>
                Reject
              </button>
            </>
          )}
        </div>
      )}

      <footer className="proposal-card-footer">
        Designed with an append-only audit trail · {proposal.proposalId}
      </footer>
    </article>
  );
}
