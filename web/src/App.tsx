import { useState } from "react";
import { ChatView } from "./components/ChatView.js";
import { MetricsView } from "./components/MetricsView.js";
import { EvalsView } from "./components/EvalsView.js";
import "./App.css";

type Tab = "chat" | "metrics" | "evals";

const TABS: { id: Tab; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "metrics", label: "Metrics" },
  { id: "evals", label: "Evals" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("chat");

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-title">
          Ledger<span className="app-title-accent">Lens</span>
        </div>
        <nav className="app-tabs" role="tablist" aria-label="Workspace views">
          {TABS.map((t, index) => (
            <button
              key={t.id}
              role="tab"
              id={`tab-${t.id}`}
              aria-controls={`panel-${t.id}`}
              aria-selected={tab === t.id}
              tabIndex={tab === t.id ? 0 : -1}
              className={`app-tab ${tab === t.id ? "app-tab--active" : ""}`}
              onClick={() => setTab(t.id)}
              onKeyDown={(event) => {
                let next = index;
                if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
                else if (event.key === "ArrowLeft") next = (index + TABS.length - 1) % TABS.length;
                else if (event.key === "Home") next = 0;
                else if (event.key === "End") next = TABS.length - 1;
                else return;
                event.preventDefault();
                const nextTab = TABS[next]!;
                setTab(nextTab.id);
                document.getElementById(`tab-${nextTab.id}`)?.focus();
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="app-main">
        <div className="app-panel" id="panel-chat" role="tabpanel" aria-labelledby="tab-chat" hidden={tab !== "chat"}>
          <ChatView />
        </div>
        {tab === "metrics" && (
          <div className="app-panel" id="panel-metrics" role="tabpanel" aria-labelledby="tab-metrics"><MetricsView /></div>
        )}
        {tab === "evals" && (
          <div className="app-panel" id="panel-evals" role="tabpanel" aria-labelledby="tab-evals"><EvalsView /></div>
        )}
      </main>
    </div>
  );
}
