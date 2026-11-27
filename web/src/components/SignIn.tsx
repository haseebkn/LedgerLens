import { useState } from "react";
import { signInAsDemo } from "../lib/api.js";

/**
 * Shown when the server requires sign-in and there is no session. "Try the
 * demo" signs in a shared demo account on the server; its password never
 * reaches the browser. The demo account has the same hourly and daily
 * limits as any other user.
 */
export function SignIn({ demoAvailable }: { demoAvailable: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tryDemo = async () => {
    setBusy(true);
    setError(null);
    try {
      await signInAsDemo();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <main className="sign-in">
      <h1 className="sign-in-title">
        Ledger<span className="app-title-accent">Lens</span>
      </h1>
      <p className="sign-in-copy">
        Ask questions about a financial book and get answers you can check: every figure links to the record
        behind it. The demo runs on synthetic data for one fictional person; no real financial data is involved.
      </p>
      {demoAvailable ? (
        <button type="button" className="chat-send sign-in-button" onClick={() => void tryDemo()} disabled={busy}>
          {busy ? "Signing in…" : "Try the demo"}
        </button>
      ) : (
        <p className="muted">The demo account isn't enabled on this deployment.</p>
      )}
      {error && <p className="message-text--error" role="alert">{error}</p>}
    </main>
  );
}
