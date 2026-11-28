import { useEffect, useState } from "react";
import type { ProposalPayload } from "financial-context-agent/streaming-types";
import { apiFetch, errorMessage } from "../lib/api.js";
import { ProposalCard } from "./ProposalCard.js";
import { CitationChip } from "./CitationChip.js";
import { SourceDrawerProvider } from "./SourceDrawer.js";

interface AuditLogEntry {
  auditId: string;
  proposalId: string | null;
  action: string;
  actorId: string;
  targetTable: string;
  targetId: string;
  diff: Record<string, unknown>;
  sources: string[];
  model: string;
  traceId: string;
  createdAt: string;
}

export function ProposalsAuditView() {
  const [advisorMode, setAdvisorMode] = useState<boolean | null>(null);
  const [proposals, setProposals] = useState<ProposalPayload[]>([]);
  const [auditEntries, setAuditEntries] = useState<AuditLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const reload = () => setReloadTick((n) => n + 1);

  useEffect(() => {
    let active = true;
    const fetchAll = async () => {
      try {
        const [pRes, aRes] = await Promise.all([apiFetch("/api/proposals"), apiFetch("/api/audit-log")]);
        if (!pRes.ok) throw new Error(await errorMessage(pRes, `Failed to load proposals (${pRes.status})`));
        if (!aRes.ok) throw new Error(await errorMessage(aRes, `Failed to load audit log (${aRes.status})`));
        const pJson = (await pRes.json()) as { advisorMode: boolean; proposals: ProposalPayload[] };
        const aJson = (await aRes.json()) as { advisorMode: boolean; entries: AuditLogEntry[] };
        if (!active) return;
        setError(null);
        setAdvisorMode(pJson.advisorMode);
        setProposals(pJson.proposals);
        setAuditEntries(aJson.entries);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void fetchAll();
    return () => { active = false; };
  }, [reloadTick]);

  if (error) return <p className="empty-state">Failed to load proposals & audit trail: {error}</p>;
  if (advisorMode === null) return <p className="empty-state">Loading proposals & audit trail…</p>;

  if (!advisorMode) {
    return (
      <p className="empty-state">
        Advisor mode is not enabled on this backend (set <code>DATABASE_URL</code> to connect Postgres + pgvector with Row-Level Security).
      </p>
    );
  }

  return (
    <SourceDrawerProvider>
      <div className="metrics-view">
        <div className="proposals-toolbar">
          <p className="muted">
            Synthetic demo book · Proposals require explicit advisor approval before writing to CRM, tasks, or outbound drafts (designed with an append-only audit trail).
          </p>
          <button type="button" className="link-button" onClick={reload}>
            Refresh
          </button>
        </div>

        <section className="panel-section">
          <h3>Proposals ({proposals.length})</h3>
          {proposals.length === 0 ? (
            <p className="empty-state">
              No proposals yet. Ask the agent to propose a CRM update, draft a follow-up email, or create a task.
            </p>
          ) : (
            <div className="proposal-list">
              {proposals.map((p) => (
                <ProposalCard
                  key={p.proposalId}
                  proposal={p}
                  onUpdated={reload}
                />
              ))}
            </div>
          )}
        </section>

        <section className="panel-section">
          <h3>Append-only audit log ({auditEntries.length})</h3>
          {auditEntries.length === 0 ? (
            <p className="empty-state">No approved or rejected proposals recorded yet.</p>
          ) : (
            <div className="message-table-scroll">
              <table className="eval-table audit-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Action</th>
                    <th>Actor</th>
                    <th>Target</th>
                    <th>Changes</th>
                    <th>Sources</th>
                    <th>Model / Trace</th>
                  </tr>
                </thead>
                <tbody>
                  {auditEntries.map((entry) => (
                    <tr key={entry.auditId}>
                      <td className="mono">{new Date(entry.createdAt).toLocaleString()}</td>
                      <td className="mono">{entry.action}</td>
                      <td className="mono">{entry.actorId}</td>
                      <td className="mono">{entry.targetTable}:{entry.targetId}</td>
                      <td className="mono">{JSON.stringify(entry.diff)}</td>
                      <td>
                        {entry.sources.length > 0
                          ? entry.sources.map((s) => <CitationChip key={s} rowId={s} />)
                          : "—"}
                      </td>
                      <td className="mono">{entry.model} · {entry.traceId.slice(0, 8)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </SourceDrawerProvider>
  );
}
