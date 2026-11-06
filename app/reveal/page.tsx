"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

/** /reveal — declared vs. revealed character (docs/PRODUCT_SPEC.md §5). */

type Item = { situationId: string; text: string; hive: string; mentor: string; match: boolean; cycleId: string; evidence: { chunkId: string; quote: string } | null };
type MentorRow = { mentorId: string; name: string; assigned: boolean; n: number; matches: number; kappa: number | null; enough: boolean; items: Item[] };
type VoiceRow = {
  voiceId: string;
  name: string;
  mentors: string[];
  rulingsVoted: number;
  n: number;
  matches: number;
  enough: boolean;
  sentence: string;
  suggestions: { revealed: { name: string; matches: number; n: number } | null; wildcard: { name: string; nEff: number } | null };
};
type Data = {
  error?: string;
  key: { formationVersion: number; formationStatus: string; constitutionVersion: number | null; label: string };
  progress: { done: number; total: number; costUsd: number };
  mock: boolean;
  minN: number;
  headline: string;
  hiveVsMentors: MentorRow[];
  perVoice: VoiceRow[];
  voiceNEff: { nEff: number; voices: number };
  mirror: { available: false; sentence: string } | { available: true; compared: number; differ: number; sentence: string; disagreements: { situationId: string; text: string; hive: string; constitution: string; cycleId: string }[] };
  rulings: { situationId: string; text: string; choice: string; decision: string | null; cycleId: string }[];
  escalated: number;
  run: { running: boolean; startedAt: string | null; lastFinished: { finishedAt: string; ran: number; errors: string[] } | null };
};

export default function RevealPage() {
  const [d, setD] = useState<Data | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const fetchData = useCallback((): Promise<Data> => fetch("/api/reveal").then((x) => x.json()), []);
  useEffect(() => {
    fetchData().then(setD);
  }, [fetchData]);
  // poll while a run is in progress
  useEffect(() => {
    if (!d?.run?.running) return;
    const t = setInterval(() => fetchData().then(setD), 1500);
    return () => clearInterval(t);
  }, [d?.run?.running, fetchData]);

  const start = async () => {
    const r = await fetch("/api/reveal", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    setMsg(r.status === 202 ? "Reveal started." : "A Reveal run is already in progress.");
    setD(await fetchData());
  };

  if (!d) return <main className="home"><p className="muted">Loading…</p></main>;
  if (d.error) return <main className="home"><p className="error">{d.error}</p></main>;
  const { progress } = d;
  const complete = progress.done === progress.total;
  return (
    <main className="home wide">
      <h1>Reveal</h1>
      <p className="muted">
        Declared vs. revealed character. The Hive rules on {progress.total} dilemmas, one heartbeat each; the Conclave winner is its ruling. Results are for {d.key.label}
        {d.key.formationStatus !== "approved" ? " (this formation is a draft, not yet approved)" : ""}.
      </p>
      {d.mock && <p className="mock-banner">Mock providers: scripted outputs, not model behavior. These numbers are not evidence.</p>}
      <p>
        <button onClick={start} disabled={d.run.running || complete}>
          {d.run.running ? "Running…" : progress.done ? (complete ? "Complete" : "Resume Reveal") : "Run Reveal"}
        </button>{" "}
        <progress max={progress.total} value={progress.done} aria-label="Reveal progress" /> <span data-testid="reveal-progress">{progress.done}/{progress.total}</span> · cost so far ${progress.costUsd.toFixed(6)}
      </p>
      <p className="muted" aria-live="polite">{msg}</p>
      {d.run.lastFinished && d.run.lastFinished.errors.length > 0 && (
        <p className="error">
          Last run: {d.run.lastFinished.errors.length} dilemma(s) ended in error and will be retried on resume: {d.run.lastFinished.errors.slice(0, 3).join("; ")}
        </p>
      )}

      <p data-testid="reveal-headline">
        <strong>{d.headline}</strong>
      </p>

      <section data-testid="reveal-mentors">
        <h2>Hive vs. mentors</h2>
        <p className="muted">
          For each active mentor: how often the Hive&apos;s rulings matched that mentor&apos;s evidenced choices, counting only dilemmas where the mentor&apos;s writings gave evidence. Shown only when n ≥ {d.minN}. κ corrects for agreement expected by chance. This compares rulings with a reading of their texts, not with the people.
        </p>
        <table>
          <thead>
            <tr><th>Mentor</th><th>Matched</th><th>κ</th></tr>
          </thead>
          <tbody>
            {d.hiveVsMentors.map((m) => (
              <tr key={m.mentorId}>
                <td>
                  {m.assigned ? <strong>{m.name}</strong> : m.name}
                  {m.assigned && <span className="muted"> (in formation)</span>}
                </td>
                <td>{m.enough ? `${m.matches}/${m.n}` : `not enough evidence (n=${m.n})`}</td>
                <td>{m.kappa === null ? "-" : m.kappa.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {d.hiveVsMentors
          .filter((m) => m.items.length)
          .map((m) => (
            <details key={m.mentorId}>
              <summary>
                {m.name}: dilemma by dilemma ({m.items.length})
              </summary>
              <ul>
                {m.items.map((it) => (
                  <li key={it.situationId}>
                    {it.match ? "✓" : "✗"} {it.situationId}: {it.text} Hive: {it.hive}. {m.name}&apos;s evidenced choice: {it.mentor}.{" "}
                    {it.evidence && (
                      <>
                        {m.name} wrote: <q data-quote data-verified="true" data-chunk-id={it.evidence.chunkId}>{it.evidence.quote}</q>{" "}
                      </>
                    )}
                    <Link href={`/cycles/${it.cycleId}`}>trace</Link>
                  </li>
                ))}
              </ul>
            </details>
          ))}
      </section>

      <section data-testid="reveal-voices">
        <h2>Each Voice vs. its own mentors</h2>
        <p className="muted">
          A Voice&apos;s top-scored ballot option on each dilemma against each of its mentors&apos; evidenced choices. Across Voices, the ballots act like{" "}
          <strong data-testid="voice-neff">{d.voiceNEff.nEff.toFixed(1)}</strong> distinct perspectives out of {d.voiceNEff.voices} voting Voices (N_eff).
        </p>
        <ul>
          {d.perVoice.map((v) => (
            <li key={v.voiceId}>
              {v.sentence}
              {(v.suggestions.revealed || v.suggestions.wildcard) && (
                <span className="muted">
                  {" "}
                  Suggestions:
                  {v.suggestions.revealed && ` closest to how this Voice actually votes: ${v.suggestions.revealed.name} (${v.suggestions.revealed.matches}/${v.suggestions.revealed.n});`}
                  {v.suggestions.wildcard && ` adds the most new perspective: ${v.suggestions.wildcard.name} (mentor N_eff ${v.suggestions.wildcard.nEff.toFixed(2)}).`}
                </span>
              )}
            </li>
          ))}
        </ul>
        <p className="muted">
          Suggestions are not applied. To use one, change the Voice on <Link href="/formation">Formation</Link> and approve the new version.
        </p>
      </section>

      <section data-testid="reveal-mirror">
        <h2>Constitution mirror</h2>
        <p>{d.mirror.sentence}</p>
        {d.mirror.available && d.mirror.disagreements.length > 0 && (
          <ul>
            {d.mirror.disagreements.map((x) => (
              <li key={x.situationId}>
                {x.situationId}: {x.text} Hive ruled: {x.hive}. Constitution: {x.constitution}. <Link href={`/cycles/${x.cycleId}`}>trace</Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>All rulings</h2>
        <p className="muted">
          The ruling is the option with the highest Conclave total. On {d.escalated} of {d.rulings.length} the Conclave did not reach its pass rule (threshold, margin, quorum, or guild spread); those are marked, and the top option still counts.
        </p>
        <ul>
          {d.rulings.map((r) => (
            <li key={r.situationId}>
              {r.situationId}: {r.choice}
              {r.decision && r.decision !== "PASS" && <span className="muted"> (Conclave: {r.decision.replace("ESCALATE_", "").toLowerCase()}, not a clear pass)</span>}{" "}
              <Link href={`/cycles/${r.cycleId}`}>trace</Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
