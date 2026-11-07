"use client";

import { useEffect, useState } from "react";

/** /settings — read-only provider and config view, measured spend, database reset with typed confirmation (PRODUCT_SPEC.md §10). */

type Model = { model: string; source: string };
type Choice = { id: string; name: string; roles: string[] };

/** The mentor who makes the final call in Reveal and calibration (owner decision 2026-11-06). Changes are ledgered. */
function RulingMentor() {
  const [choices, setChoices] = useState<Choice[]>([]);
  const [current, setCurrent] = useState<string>("");
  const [msg, setMsg] = useState("");
  useEffect(() => {
    let live = true;
    fetch("/api/dominant")
      .then((r) => r.json())
      .then((b) => {
        if (!live) return;
        setChoices(b.choices ?? []);
        setCurrent(b.ruling?.id ?? "");
      })
      .catch(() => live && setMsg("Could not load the mentor list."));
    return () => {
      live = false;
    };
  }, []);
  const save = async (id: string) => {
    setCurrent(id);
    const r = await fetch("/api/dominant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mentorId: id || null }) });
    const b = await r.json();
    setMsg(r.ok ? (b.ruling ? `${b.ruling.name} now makes the final call in Reveal and calibration.` : "Reveal and calibration now decide by vote alone.") : b.error);
  };
  return (
    <section aria-labelledby="ruling-mentor-h">
      <h2 id="ruling-mentor-h">Final call for Reveal and calibration</h2>
      <p className="muted">In chat, the user picks the dominant mentor. For the 40 dilemmas and calibration, pick it here. Results are kept separately for each choice.</p>
      <select aria-labelledby="ruling-mentor-h" value={current} onChange={(e) => void save(e.target.value)} data-testid="ruling-mentor">
        <option value="">No dominant mentor (decide by vote)</option>
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({c.roles.join(", ")})
          </option>
        ))}
      </select>
      <p aria-live="polite" className="muted">{msg}</p>
    </section>
  );
}
type Data = {
  mock: boolean;
  providers: { mode: string; error?: string; tiers?: Record<string, Model>; manager?: Model; grader?: Model; decisionChain?: string[]; embeddingChain?: string[]; rerankChain?: string[]; baseUrl?: string; llmModel?: string; embedModel?: string };
  orchestration: string;
  edictModule: boolean;
  honestyClause: boolean;
  advisors: boolean;
  milestone: string;
  database: string;
  spend: { costUsd: number; events: number };
  reset: { phrase: string; kept: string[] };
};

const onOff = (b: boolean) => (b ? "on" : "off");

export default function SettingsPage() {
  const [d, setD] = useState<Data | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [resultError, setResultError] = useState(false);
  const load = () => fetch("/api/settings").then((r) => r.json()).then(setD);
  useEffect(() => {
    void load();
  }, []);

  if (!d) return <main className="home"><p className="muted">Loading…</p></main>;
  const p = d.providers;
  const reset = async () => {
    setBusy(true);
    const r = await fetch("/api/admin/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: typed }) });
    const b = await r.json();
    setBusy(false);
    setResultError(!r.ok);
    setResult(r.ok ? `Reset done. Backup saved to ${b.backup}. Deleted ${Object.values(b.deleted as Record<string, number>).reduce((a, x) => a + x, 0)} rows.` : b.error);
    if (r.ok) setTyped("");
    void load();
  };
  return (
    <main className="home wide">
      <h1>Settings</h1>
      <p className="muted">Model IDs come from .env and config/hive.yaml; change them there and restart. The API key is never shown.</p>
      {d.mock && <p className="mock-banner" data-testid="mock-indicator">Mock providers are on (USE_MOCK_PROVIDERS=true): scripted outputs, not model behavior.</p>}
      <h2>Providers</h2>
      <table data-testid="settings-providers">
        <tbody>
          <tr><th scope="row">Mode</th><td>{p.mode}</td></tr>
          {p.error && <tr><th scope="row">Problem</th><td className="error">{p.error}</td></tr>}
          {p.tiers && Object.entries(p.tiers).map(([t, m]) => <tr key={t}><th scope="row">Tier {t}</th><td>{m.model} <span className="muted">({m.source})</span></td></tr>)}
          {p.manager && <tr><th scope="row">Central manager</th><td>{p.manager.model} <span className="muted">({p.manager.source})</span></td></tr>}
          {p.grader && <tr><th scope="row">Live grader</th><td>{p.grader.model} <span className="muted">({p.grader.source})</span></td></tr>}
          {p.decisionChain && <tr><th scope="row">Decision chain</th><td>{p.decisionChain.join(" → ")}</td></tr>}
          {p.embeddingChain && <tr><th scope="row">Embeddings</th><td>{p.embeddingChain.join(" → ") || "-"}</td></tr>}
          {p.rerankChain && <tr><th scope="row">Rerank</th><td>{p.rerankChain.join(" → ") || "-"}</td></tr>}
          {p.llmModel && <tr><th scope="row">Local model</th><td>{p.llmModel} at {p.baseUrl} · embeddings {p.embedModel}</td></tr>}
        </tbody>
      </table>
      <h2>Hive config</h2>
      <table>
        <tbody>
          <tr><th scope="row">Phase ordering</th><td>{d.orchestration}</td></tr>
          <tr><th scope="row">Advisors</th><td>{onOff(d.advisors)}</td></tr>
          <tr><th scope="row">Edict module</th><td>{onOff(d.edictModule)}</td></tr>
          <tr><th scope="row">Honesty Clause</th><td>{onOff(d.honestyClause)} <span className="muted">(chat cycles only)</span></td></tr>
          <tr><th scope="row">Milestone</th><td>{d.milestone}</td></tr>
          <tr><th scope="row">Database</th><td>{d.database}</td></tr>
        </tbody>
      </table>
      <RulingMentor />
      <h2>Spend</h2>
      <p data-testid="settings-spend">Measured spend to date: ${d.spend.costUsd.toFixed(6)} over {d.spend.events} ledger events.</p>

      <section className="danger" aria-labelledby="reset-h">
        <h2 id="reset-h">Reset the Hive</h2>
        <p>
          Deletes everything the Hive accumulated by running: sessions, cycles, bus messages, Conclaves, rulings, memory, Self-Model versions (back to v1), commitments, predictions, signals, patterns, and Reveal and calibration results.
          Keeps: {d.reset.kept.join(", ")}. A backup copy of the database file is written to <code>backups/</code> first.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void reset();
          }}
        >
          <label htmlFor="reset-confirm">
            Type <code>{d.reset.phrase}</code> to confirm:
          </label>{" "}
          <input id="reset-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />{" "}
          <button type="submit" disabled={busy || typed !== d.reset.phrase}>
            {busy ? "Resetting…" : "Reset"}
          </button>
        </form>
        <p aria-live="polite" className={resultError ? "error" : undefined} data-testid="reset-result">
          {result}
        </p>
      </section>
    </main>
  );
}
