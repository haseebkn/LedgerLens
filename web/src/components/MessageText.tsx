import { parseMessageBlocks, type MessagePart } from "../lib/message-parts.js";
import { CitationChip } from "./CitationChip.js";
import type { CitationWarning } from "../hooks/useAgentChat.js";

function plainText(parts: MessagePart[]): string {
  return parts.map((p) => (p.type === "citation" ? "" : p.text)).join("");
}

/**
 * Marks a paragraph, list item or table cell that contains a dollar figure
 * the agent's grounding check flagged. The figure stays visible: the marker
 * says it isn't backed by what it cites, not that it is wrong.
 */
function Unverified({ parts, warnings }: { parts: MessagePart[]; warnings: CitationWarning[] }) {
  const text = plainText(parts);
  const hits = warnings.filter((w) => text.includes(w.figure));
  if (hits.length === 0) return null;
  const why = hits
    .map((w) => `${w.figure}: ${w.reason === "uncited" ? "no source cited" : "not found in the cited source"}`)
    .join("; ");
  return (
    <span className="unverified-marker" title={why} aria-label={`Unverified figure. ${why}`}>
      Unverified
    </span>
  );
}

function Inline({ parts }: { parts: MessagePart[] }) {
  return (
    <>
      {parts.map((part, i) => {
        switch (part.type) {
          case "citation":
            return <CitationChip key={i} rowId={part.rowId} />;
          case "bold":
            return <strong key={i}>{part.text}</strong>;
          case "code":
            return (
              <code key={i} className="message-code">
                {part.text}
              </code>
            );
          default:
            return <span key={i}>{part.text}</span>;
        }
      })}
    </>
  );
}

/**
 * Renders answer text as paragraphs and bullet lists, with [row_id] markers
 * replaced by citation chips and the agent's markdown (bold, inline code)
 * actually rendered rather than shown as literal asterisks and backticks.
 */
export function MessageText({ text, warnings = [] }: { text: string; warnings?: CitationWarning[] }) {
  const blocks = parseMessageBlocks(text);

  return (
    <div className="message-text">
      {blocks.map((block, i) =>
        block.type === "list" ? (
          <ul key={i} className="message-list">
            {block.items.map((parts, j) => (
              <li key={j}>
                <Inline parts={parts} />
                <Unverified parts={parts} warnings={warnings} />
              </li>
            ))}
          </ul>
        ) : block.type === "table" ? (
          <div key={i} className="message-table-scroll">
            <table className="message-table">
              <thead>
                <tr>
                  {block.headers.map((parts, j) => (
                    <th key={j} scope="col">
                      <Inline parts={parts} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, j) => (
                  <tr key={j}>
                    {row.map((parts, k) => (
                      <td key={k}>
                        <Inline parts={parts} />
                        <Unverified parts={parts} warnings={warnings} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p key={i}>
            <Inline parts={block.parts} />
            <Unverified parts={block.parts} warnings={warnings} />
          </p>
        )
      )}
    </div>
  );
}
