"use client";

import { useState } from "react";

/** /hive — talk to the Hive; each reply can expand its full cycle trace (docs/PRODUCT_SPEC.md §4). */
import { n, ReplyText, TraceView, type Conclave, type Trace } from "./trace-view";

type Turn = { input: string; output: string; status: string; cycleId: string; trace: Trace };


function TurnView({ turn }: { turn: Turn }) {
  const [open, setOpen] = useState(false);
  const [conclave, setConclave] = useState<Conclave | null>(null);
  const toggle = async () => {
    if (!open && turn.trace.conclaveId && !conclave) {
      const r = await fetch(`/api/cycles/${turn.cycleId}`).then((x) => x.json());
      setConclave(r.conclave);
    }
    setOpen(!open);
  };
  return (
    <div className="turn">
      <p className="you">{turn.input}</p>
      <p className="reply" data-testid="hive-reply">
        {turn.status === "done" ? <ReplyText text={turn.output} quotes={turn.trace.compose.quotes ?? []} /> : `The cycle stopped in ${turn.trace.error?.phase}: ${turn.trace.error?.message}`}
      </p>
      <button className="link" onClick={toggle}>
        {open ? "Hide thinking" : "Show thinking"}
      </button>
      {open && <TraceView t={turn.trace} conclave={conclave} />}
    </div>
  );
}

export default function HivePage() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selfModel, setSelfModel] = useState<Record<string, unknown> | null>(null);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      let id = sessionId;
      if (!id) {
        id = (await fetch("/api/sessions", { method: "POST" }).then((r) => r.json())).id as string;
        setSessionId(id);
      }
      const res = await fetch(`/api/sessions/${id}/cycle`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: text }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setTurns((t) => [...t, { input: text, output: body.output, status: body.status, cycleId: body.cycleId, trace: body.trace }]);
      setSelfModel(body.selfModel);
      setInput("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const last = turns.at(-1)?.trace;
  return (
    <main className="hive">
      <div className="chat">
        <h1>Talk to the Hive</h1>
        {turns.map((t) => <TurnView key={t.cycleId} turn={t} />)}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea aria-label="Message" value={input} onChange={(e) => setInput(e.target.value)} rows={3} placeholder="Say something to the Hive…" />
          <button type="submit" disabled={busy || !input.trim()}>
            {busy ? "Thinking…" : "Send"}
          </button>
        </form>
        {error && <p className="error">{error}</p>}
      </div>
      <aside className="side">
        <h3>Self-Model</h3>
        <p className="muted">{selfModel ? String(selfModel.identity ?? "") : "Not loaded yet."}</p>
        <h3>Commitments</h3>
        <p className="muted">
          See <a href="/interoception">Interoception</a> for the Commitment Ledger.
        </p>
        <h3>Interoception</h3>
        <p className="muted">
          {last
            ? `valence ${n(last.affect.valence)} · arousal ${n(last.affect.arousal)} · ${last.affect.dominant} · C_intra ${last.coherence.cIntra === null ? "-" : n(last.coherence.cIntra)} · C_inter ${last.coherence.cInter === null ? "-" : n(last.coherence.cInter)}`
            : "No cycle yet."}
        </p>
      </aside>
    </main>
  );
}
