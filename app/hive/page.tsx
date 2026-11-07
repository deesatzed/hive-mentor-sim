"use client";

import { useEffect, useId, useState } from "react";

/** /hive — talk to the Hive; each reply can expand its full cycle trace (docs/PRODUCT_SPEC.md §4). */
import { n, ReplyText, TraceView, type Conclave, type Trace } from "./trace-view";

type Turn = { input: string; output: string; status: string; cycleId: string; trace: Trace };
type Choice = { id: string; name: string; years: string; roles: string[]; principles: string[] };

/** The dominant mentor makes the final call (owner decision 2026-11-06): picked by topic before the first message, changeable any time. */
function MentorPicker({ choices, value, onChange, locked }: { choices: Choice[]; value: string; onChange: (id: string) => void; locked: boolean }) {
  const picked = choices.find((c) => c.id === value);
  return (
    <div className="mentor-picker" data-testid="mentor-picker">
      <label htmlFor="dominant-mentor">
        <strong>Who makes the final call?</strong> Pick the mentor whose outlook fits your topic.
      </label>
      <select id="dominant-mentor" value={value} onChange={(e) => onChange(e.target.value)} disabled={locked}>
        <option value="">Choose a mentor…</option>
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({c.roles.join(", ")})
          </option>
        ))}
      </select>
      {picked && (
        <p className="muted" data-testid="mentor-principles">
          {picked.name} weighs the Voices&apos; reasoning by principles such as: {picked.principles.slice(0, 2).join(" · ")}
        </p>
      )}
    </div>
  );
}


function TurnView({ turn }: { turn: Turn }) {
  const [open, setOpen] = useState(false);
  const [conclave, setConclave] = useState<Conclave | null>(null);
  const traceId = `t-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
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
      <button className="link" onClick={toggle} aria-expanded={open} aria-controls={traceId}>
        {open ? "Hide thinking" : "Show thinking"}
      </button>
      {open && <TraceView id={traceId} t={turn.trace} conclave={conclave} />}
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
  const [choices, setChoices] = useState<Choice[]>([]);
  const [mentorId, setMentorId] = useState("");
  const [mentorNote, setMentorNote] = useState("");

  useEffect(() => {
    let live = true;
    fetch("/api/dominant")
      .then((r) => r.json())
      .then((b) => live && setChoices(b.choices ?? []))
      .catch(() => live && setError("Could not load the mentor list."));
    return () => {
      live = false;
    };
  }, []);

  const changeMentor = async (id: string) => {
    setMentorId(id);
    if (!sessionId || !id) return;
    const res = await fetch(`/api/sessions/${sessionId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dominantMentorId: id }) });
    const body = await res.json();
    if (!res.ok) setError(body.error ?? `HTTP ${res.status}`);
    else setMentorNote(`From your next message, ${body.dominantMentor.name} makes the final call.`);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy || !mentorId) return;
    setBusy(true);
    setError(null);
    try {
      let id = sessionId;
      if (!id) {
        const created = await fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dominantMentorId: mentorId }) });
        const cb = await created.json();
        if (!created.ok) throw new Error(cb.error ?? `HTTP ${created.status}`);
        id = cb.id as string;
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
        <MentorPicker choices={choices} value={mentorId} onChange={(id) => void changeMentor(id)} locked={busy} />
        {mentorNote && <p className="muted" aria-live="polite">{mentorNote}</p>}
        {turns.map((t) => <TurnView key={t.cycleId} turn={t} />)}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea aria-label="Message" value={input} onChange={(e) => setInput(e.target.value)} rows={3} placeholder="Say something to the Hive…" />
          <button type="submit" disabled={busy || !input.trim() || !mentorId} title={mentorId ? undefined : "Pick a mentor first"}>
            {busy ? "Thinking…" : "Send"}
          </button>
        </form>
        <p className="muted" aria-live="polite" data-testid="cycle-status">
          {busy ? "The Hive is thinking: running perceive, whispers, attention, Conclave, compose and reflect. This takes a while with live models." : turns.length ? `Reply ${turns.length} received.` : ""}
        </p>
        {error && <p className="error" role="alert">{error}</p>}
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
