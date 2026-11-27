import { sourceFromRowId } from "../lib/message-parts.js";
import { useOpenSource } from "./SourceDrawer.js";

const SOURCE_COLOR: Record<string, string> = {
  Calendar: "#a78bfa",
  Plaid: "#34d399",
  Alpaca: "#fbbf24",
  Computed: "#60a5fa",
  Unknown: "#9ca3af",
};

/** A citation the reader can open: the chip opens the cited row in the source drawer. */
export function CitationChip({ rowId }: { rowId: string }) {
  const source = sourceFromRowId(rowId);
  const color = SOURCE_COLOR[source] ?? SOURCE_COLOR["Unknown"];
  const openSource = useOpenSource();
  const style = { "--chip-color": color } as React.CSSProperties;

  if (!openSource) {
    return <span className="citation-chip" style={style} title={rowId}>{source}</span>;
  }
  return (
    <button
      type="button"
      className="citation-chip citation-chip--button"
      style={style}
      title={rowId}
      aria-label={`Open ${source} source ${rowId}`}
      onClick={() => openSource(rowId)}
    >
      {source}
    </button>
  );
}
