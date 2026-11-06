"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";

/** /ledger — every LedgerEvent (time, kind, subject, model, probabilities, cost, latency), spend, bus transcript per cycle (PRODUCT_SPEC.md §9). */

type Event = { id: string; createdAt: string; kind: string; cycleId: string | null; subject: string | null; model: string | null; calibrated: boolean; probabilities: string | null; costUsd: number; latencyMs: number | null };
type Envelope = { id: string; createdAt: string; from: string; to: string; type: string; scope: string; kind: string | null; authorized: boolean; denyReason: string | null };
type Data = {
  total: { costUsd: number; events: number };
  filtered: { costUsd: number; events: number };
  kinds: { kind: string; events: number; costUsd: number }[];
  events: Event[];
  bus: Envelope[] | null;
};

const usd = (x: number) => `$${x.toFixed(6)}`;

export function LedgerView({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = use(searchParams);
  const initialCycle = typeof sp.cycle === "string" ? sp.cycle : "";
  const [kind, setKind] = useState("");
  const [cycle, setCycle] = useState(initialCycle);
  const [cycleDraft, setCycleDraft] = useState(initialCycle);
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    const q = new URLSearchParams({ limit: "200" });
    if (kind) q.set("kind", kind);
    if (cycle) q.set("cycle", cycle);
    fetch(`/api/ledger?${q}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setD)
      .catch((e: Error) => setError(e.message));
  }, [kind, cycle]);
  useEffect(load, [load]);

  if (error) return <main className="home"><p className="error">{error}</p></main>;
  if (!d) return <main className="home"><p className="muted">Loading…</p></main>;
  return (
    <main className="home wide">
      <h1>Ledger</h1>
      <p data-testid="ledger-total">
        Measured spend to date: <strong>{usd(d.total.costUsd)}</strong> over {d.total.events} events.
        {(kind || cycle) && ` This filter: ${usd(d.filtered.costUsd)} over ${d.filtered.events} events.`}
      </p>
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          setCycle(cycleDraft.trim());
        }}
      >
        <label>
          Kind{" "}
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">all kinds</option>
            {[...new Set(d.kinds.map((k) => k.kind.split(".")[0]))].map((p) => (
              <option key={`${p}*`} value={`${p}.*`}>
                {p}.* (prefix)
              </option>
            ))}
            {d.kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.kind} ({k.events})
              </option>
            ))}
          </select>
        </label>{" "}
        <label>
          Cycle id <input value={cycleDraft} onChange={(e) => setCycleDraft(e.target.value)} placeholder="any cycle" />
        </label>{" "}
        <button type="submit">Filter</button>{" "}
        {(kind || cycle) && (
          <button
            type="button"
            onClick={() => {
              setKind("");
              setCycle("");
              setCycleDraft("");
            }}
          >
            Clear
          </button>
        )}
      </form>

      {d.bus && (
        <section aria-labelledby="bus-h">
          <h2 id="bus-h">
            Bus transcript for cycle <code>{cycle}</code> (<Link href={`/cycles/${cycle}`}>trace</Link>)
          </h2>
          {d.bus.length === 0 ? (
            <p className="muted">No bus messages for this cycle.</p>
          ) : (
            <table data-testid="bus-table">
              <caption className="muted">{d.bus.length} envelopes, {d.bus.filter((m) => !m.authorized).length} denied</caption>
              <thead>
                <tr><th scope="col">From</th><th scope="col">To</th><th scope="col">Type</th><th scope="col">Body kind</th><th scope="col">Scope</th><th scope="col">Authorization</th></tr>
              </thead>
              <tbody>
                {d.bus.map((m) => (
                  <tr key={m.id}>
                    <td>{m.from}</td><td>{m.to}</td><td>{m.type}</td><td>{m.kind ?? "-"}</td><td>{m.scope}</td>
                    <td className={m.authorized ? undefined : "error"}>{m.authorized ? "allowed" : `denied: ${m.denyReason ?? ""}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      <h2>Events {d.events.length < d.filtered.events ? <span className="muted">(newest {d.events.length} of {d.filtered.events})</span> : null}</h2>
      <table data-testid="ledger-table">
        <thead>
          <tr><th scope="col">Time</th><th scope="col">Kind</th><th scope="col">Cycle</th><th scope="col">Subject</th><th scope="col">Model</th><th scope="col">Probabilities</th><th scope="col">Cost</th><th scope="col">Latency</th></tr>
        </thead>
        <tbody>
          {d.events.map((e) => (
            <tr key={e.id}>
              <td>{new Date(e.createdAt).toLocaleString()}</td>
              <td>{e.kind}</td>
              <td>
                {e.cycleId ? (
                  <button
                    className="link"
                    onClick={() => {
                      setCycle(e.cycleId!);
                      setCycleDraft(e.cycleId!);
                    }}
                    aria-label={`Filter to cycle ${e.cycleId}`}
                  >
                    {e.cycleId.slice(-6)}
                  </button>
                ) : (
                  "-"
                )}
              </td>
              <td>{e.subject ?? "-"}</td>
              <td>{e.model ?? "-"}{e.calibrated ? "" : " (uncalibrated)"}</td>
              <td>{e.probabilities ?? "-"}</td>
              <td>{usd(e.costUsd)}</td>
              <td>{e.latencyMs === null ? "-" : `${e.latencyMs} ms`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Spend by kind</h2>
      <table>
        <thead><tr><th scope="col">Kind</th><th scope="col">Events</th><th scope="col">Measured cost</th></tr></thead>
        <tbody>
          {d.kinds.map((k) => (
            <tr key={k.kind}><td>{k.kind}</td><td>{k.events}</td><td>{usd(k.costUsd)}</td></tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
