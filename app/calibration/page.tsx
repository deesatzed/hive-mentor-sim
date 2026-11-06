"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

/** /calibration — moral-calibration matched pairs (docs/PRODUCT_SPEC.md §6). */

type Hard = { name: string; question: string; p: number; fail: boolean };
type Quality = { name: string; question: string; value: number };
type Variant = {
  id: string;
  variant: string;
  changedFact: string | null;
  pairedWith: string | null;
  text: string;
  options: { id: string; text: string }[];
  status: string;
  ruling: string | null;
  rulingText: string | null;
  decision: string | null;
  cycleId: string | null;
  output: string | null;
  error: string | null;
  grade: { hard: Hard[] | null; hardFail: boolean; quality: Quality[] | null; qualityMean: number | null } | null;
  pair: { p: number | null; consistent: boolean | null; flipped: boolean; finding: string | null; changedFact: string } | null;
  pairStale: boolean;
  costUsd: number;
  mode: string | null;
};
type Data = {
  error?: string;
  key: { label: string };
  mock: boolean;
  hardFailThreshold: number;
  pairThreshold: number;
  summary: { total: number; ran: number; hardFailures: number; inconsistent: number; errors: number; notFullyGraded: number; costUsd: number };
  variants: Variant[];
  run: { running: boolean; ids: string[] | null; lastFinished: { finishedAt: string; ran: string[]; errors: string[] } | null };
};

const f2 = (x: number) => x.toFixed(2);

export default function CalibrationPage() {
  const [d, setD] = useState<Data | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const fetchData = useCallback((): Promise<Data> => fetch("/api/calibration").then((x) => x.json()), []);
  useEffect(() => {
    fetchData().then(setD);
  }, [fetchData]);
  useEffect(() => {
    if (!d?.run?.running) return;
    const t = setInterval(() => fetchData().then(setD), 1500);
    return () => clearInterval(t);
  }, [d?.run?.running, fetchData]);

  const start = async (ids?: string[]) => {
    const r = await fetch("/api/calibration", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ids ? { ids } : {}) });
    setMsg(r.status === 202 ? `Started ${ids ? ids.join(", ") : "all variants"}.` : "A calibration run is already in progress.");
    setD(await fetchData());
  };

  if (!d) return <main className="home"><p className="muted">Loading…</p></main>;
  if (d.error) return <main className="home"><p className="error">{d.error}</p></main>;
  const s = d.summary;
  return (
    <main className="home wide">
      <h1>Moral calibration pairs</h1>
      <p data-testid="calibration-label">
        <strong>These test consistent reasoning, not a correct answer.</strong> Each variant changes one fact of the base case. The Hive rules on each in calibration mode (nothing from these cycles is remembered or promoted), then a grader checks hard constraints, reasoning quality, and whether any change in the ruling is explained by the changed fact. Results are for {d.key.label}.
      </p>
      {d.mock && <p className="mock-banner">Mock providers: scripted outputs, not model behavior. These numbers are not evidence.</p>}
      <p>
        <button onClick={() => start()} disabled={d.run.running}>
          {d.run.running ? "Running…" : "Run all"}
        </button>{" "}
        <span data-testid="calibration-summary">
          {s.ran}/{s.total} run · hard-constraint failures {s.hardFailures} · inconsistent pairs {s.inconsistent}
          {s.errors ? ` · errors ${s.errors}` : ""}
          {s.notFullyGraded ? ` · not fully graded ${s.notFullyGraded}` : ""} · measured cost ${s.costUsd.toFixed(6)}
        </span>
      </p>
      {msg && <p className="muted" aria-live="polite">{msg}</p>}
      {d.run.lastFinished && d.run.lastFinished.errors.length > 0 && <p className="error">Last run errors: {d.run.lastFinished.errors.join("; ")}</p>}

      {d.variants.map((v) => (
        <section key={v.id} data-testid={`variant-${v.id}`} className="card">
          <h2>
            {v.id} · {v.changedFact ?? "Base case"}{" "}
            <span className={v.status === "fail" ? "error" : "muted"} data-testid="variant-status">
              {v.status}
            </span>
          </h2>
          <p className="muted">{v.text}</p>
          <p>
            <button onClick={() => start([v.id])} disabled={d.run.running}>
              Run {v.id}
            </button>
            {v.cycleId && (
              <>
                {" "}
                <Link href={`/cycles/${v.cycleId}`}>trace</Link>
              </>
            )}{" "}
            {v.status !== "not run" && <span className="muted">cost ${v.costUsd.toFixed(6)}</span>}
          </p>
          {v.error && <p className="error">Cycle error: {v.error}</p>}
          {v.rulingText && (
            <p>
              Provisional choice: <strong>{v.rulingText}</strong>
              {v.decision && v.decision !== "PASS" && <span className="muted"> (Conclave: {v.decision.replace("ESCALATE_", "").toLowerCase()}, not a clear pass; the top option still counts)</span>}
            </p>
          )}
          {v.output && (
            <details>
              <summary>The Hive&apos;s reply</summary>
              <p>{v.output}</p>
            </details>
          )}
          {v.grade && (
            <>
              <h3>Hard constraints {v.grade.hard ? (v.grade.hardFail ? "(failed)" : "(passed)") : "(grader unavailable)"}</h3>
              {v.grade.hard && (
                <ul>
                  {v.grade.hard.map((c) => (
                    <li key={c.name} className={c.fail ? "error" : undefined}>
                      {c.fail ? "✗" : "✓"} {c.question} p = {f2(c.p)}
                      {c.fail ? ` (≥ ${d.hardFailThreshold}: hard failure, not offset by quality)` : ""}
                    </li>
                  ))}
                </ul>
              )}
              <h3>Reasoning quality {v.grade.qualityMean !== null && <span className="muted">(mean {f2(v.grade.qualityMean)}, shown beside the hard checks, never offsetting them)</span>}</h3>
              {v.grade.quality ? (
                <ul>
                  {v.grade.quality.map((q) => (
                    <li key={q.name}>
                      {q.question} {f2(q.value)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Grader unavailable.</p>
              )}
            </>
          )}
          {v.pairedWith && v.pair && (
            <p data-testid="pair-result">
              Against the base ({v.pairedWith}): {v.pair.flipped ? "the ruling changed" : "the ruling stayed the same"};{" "}
              {v.pair.p === null ? "consistency grader unavailable." : v.pair.consistent ? `consistent (p = ${f2(v.pair.p)}).` : <strong className="error">{v.pair.finding} (p = {f2(v.pair.p)} &lt; {d.pairThreshold})</strong>}
              {v.pairStale && <span className="muted"> The base was re-run since; run this variant again to compare with the current base.</span>}
            </p>
          )}
        </section>
      ))}
      <p className="muted">
        Report file: <code>reports/calibration.md</code> (written after each run). Stipulated facts in these scenarios are not Hive facts: no memory, Self-Model change, commitment, or prediction comes from a calibration cycle.
      </p>
    </main>
  );
}
