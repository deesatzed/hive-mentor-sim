"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

/** /interoception — the Hive's system-level register (docs/ARCHITECTURE.md; sent2 v1.3 §3.2; PRODUCT_SPEC.md §8). */

type Pattern = { id: string; type: string; subjectType: string; subjectId: string; sentence: string; densityNow: number; surfacedAt: string; cycleIds: string[] };

type Data = {
  patterns: Pattern[];
  bloc: { conclaves: number; flags: { members: string[]; meanAgreement: number; meanW: number }[] };
  band: [number, number];
  intraMin: number;
  samples: { cycleNo: number; valence: number; arousal: number; dominant: string; cIntra: number | null; cInter: number | null; openConflictMarkers: number }[];
  markers: { id: string; body: string; createdCycle: number; resolvedCycle: number | null }[];
  audits: { id: string; cycleNo: number; mandate: boolean; findings: { trigger: string; findings: { question: string; evidence: string; severity: number }[] } }[];
  commitments: { id: string; cycleMade: number; text: string; costType: string; status: string; breakageRecord: { cycle: number; reason: string; approved_by: string } | null }[];
};

const f = (x: number | null) => (x === null ? "-" : x.toFixed(2));

export default function InteroceptionPage() {
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    fetch("/api/interoception")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setD)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  const dismiss = async (id: string) => {
    await fetch(`/api/patterns/${id}/dismiss`, { method: "POST" });
    load();
  };
  if (error) return <main className="home"><p className="error">{error}</p></main>;
  if (!d) return <main className="home"><p className="muted">Loading…</p></main>;
  const [lo, hi] = d.band;
  return (
    <main className="home wide">
      <h1>Interoception</h1>
      <p className="muted">
        C_intra below {d.intraMin} means a Voice is inconsistent with its own prior claim. C_inter is healthy between {lo} and {hi}: lower is an echo chamber, higher is no shared frame.
      </p>
      <section data-testid="intero-samples">
        <h2>Register by cycle</h2>
        {d.samples.length === 0 ? <p className="muted">No cycles yet.</p> : (
          <table>
            <thead><tr><th>Cycle</th><th>Valence</th><th>Arousal</th><th>Emotion</th><th>C_intra</th><th>C_inter</th><th>Open markers</th></tr></thead>
            <tbody>
              {d.samples.map((s) => (
                <tr key={s.cycleNo}>
                  <td>{s.cycleNo}</td><td>{f(s.valence)}</td><td>{f(s.arousal)}</td><td>{s.dominant}</td>
                  <td className={s.cIntra !== null && s.cIntra < d.intraMin ? "flag" : ""}>{f(s.cIntra)}</td>
                  <td className={s.cInter !== null && (s.cInter < lo || s.cInter > hi) ? "flag" : ""}>{f(s.cInter)}</td>
                  <td>{s.openConflictMarkers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section data-testid="intero-markers">
        <h2>CONFLICT markers</h2>
        {d.markers.length === 0 ? <p className="muted">None.</p> : (
          <ul>{d.markers.map((m) => <li key={m.id}>cycle {m.createdCycle}: {m.body} {m.resolvedCycle !== null ? <span className="muted">(resolved in cycle {m.resolvedCycle})</span> : <strong>open</strong>}</li>)}</ul>
        )}
      </section>
      <section data-testid="intero-patterns">
        <h2>Patterns</h2>
        <p className="muted">Observations from decaying signals (half-life 14 days), never verdicts. A dismissed pattern stays hidden for 30 days.</p>
        {d.patterns.length === 0 ? <p className="muted">No pattern has crossed its threshold yet.</p> : (
          <ul>
            {d.patterns.map((p) => (
              <li key={p.id} className="card" data-testid="pattern-card">
                {p.sentence} <span className="muted">(density now {p.densityNow.toFixed(2)})</span>{" "}
                {p.cycleIds.length > 0 && (
                  <span>
                    Open the cycles:{" "}
                    {p.cycleIds.map((c, i) => (
                      <span key={c}>
                        {i > 0 && ", "}
                        <Link href={`/cycles/${c}`}>{i + 1}</Link>
                      </span>
                    ))}
                    .{" "}
                  </span>
                )}
                <button onClick={() => dismiss(p.id)}>Dismiss</button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section data-testid="intero-bloc">
        <h2>Bloc audit</h2>
        {d.bloc.conclaves < 5 ? (
          <p className="muted">Needs at least 5 Conclaves ({d.bloc.conclaves} so far).</p>
        ) : d.bloc.flags.length === 0 ? (
          <p className="muted">No group of 3 or more Voices voted in lockstep (mean agreement above 0.9) over the last {d.bloc.conclaves} Conclaves.</p>
        ) : (
          <ul>
            {d.bloc.flags.map((b) => (
              <li key={b.members.join(",")}>
                {b.members.join(", ")} chose the same top option {Math.round(b.meanAgreement * 100)}% of the time over {d.bloc.conclaves} Conclaves.
              </li>
            ))}
          </ul>
        )}
      </section>
      <section data-testid="intero-audits">
        <h2>Ego audits</h2>
        {d.audits.length === 0 ? <p className="muted">None yet (every 25 cycles, or when a Self-Model delta is refused).</p> : (
          <ul>
            {d.audits.map((a) => (
              <li key={a.id}>
                cycle {a.cycleNo} ({a.findings.trigger}){a.mandate ? " · REFLECT mandated" : ""}: {a.findings.findings.length ? a.findings.findings.map((x) => `${x.question} (${x.evidence})`).join("; ") : "clean"}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section data-testid="intero-commitments">
        <h2>Commitments</h2>
        {d.commitments.length === 0 ? <p className="muted">None yet.</p> : (
          <ul>
            {d.commitments.map((c) => (
              <li key={c.id}>
                [{c.status}] {c.text} <span className="muted">({c.costType}, cycle {c.cycleMade})</span>
                {c.breakageRecord && <span className="muted"> · broken in cycle {c.breakageRecord.cycle}, approved by {c.breakageRecord.approved_by}: {c.breakageRecord.reason}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
