"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

/** /predictions — the Hive's predictions, operator check-ins, track record, commitments (docs/PRODUCT_SPEC.md §7). */

type Item = { id: string; cycleId: string; text: string; proposedBy: string; mentors: string[]; checkInAt: string; due: boolean; outcomeRating: number | null; outcomeNote: string | null; checkedInAt: string | null };
type Stats = { lens: string; n: number; held: number; didNot: number; mean: number | null; displayMode: string; sentence: string };
type Data = {
  due: Item[];
  upcoming: Item[];
  checkedIn: Item[];
  trackRecord: { byVoice: Stats[]; byMentor: Stats[]; caveat: string };
  commitments: { id: string; text: string; status: string; cycleMade: number; costType: string }[];
};

const day = (iso: string) => iso.slice(0, 10);

function CheckIn({ item, onDone }: { item: Item; onDone: () => void }) {
  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    const r = await fetch(`/api/predictions/${item.id}/checkin`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rating, note: note || undefined }) });
    if (r.ok) onDone();
    else setErr(((await r.json()) as { error: string }).error);
  };
  return (
    <fieldset className="card" data-testid="checkin">
      <legend>
        {item.text} <span className="muted">(proposed by {item.proposedBy}{item.mentors.length ? `; lens: ${item.mentors.join(", ")}` : ""}; check-in {day(item.checkInAt)})</span>
      </legend>
      <p>
        How did it turn out?{" "}
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} style={{ marginRight: 8 }}>
            <input type="radio" name={`rating-${item.id}`} value={n} checked={rating === n} onChange={() => setRating(n)} /> {n}
          </label>
        ))}
        <span className="muted"> (1 = did not hold at all, 5 = held fully)</span>
      </p>
      <p>
        <label>
          Note (optional) <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
        </label>{" "}
        <button onClick={submit} disabled={rating === null}>
          Save check-in
        </button>{" "}
        <Link href={`/cycles/${item.cycleId}`}>cycle</Link>
      </p>
      {err && <p className="error">{err}</p>}
    </fieldset>
  );
}

function StatsList({ title, rows, testid }: { title: string; rows: Stats[]; testid: string }) {
  return (
    <div data-testid={testid}>
      <h3>{title}</h3>
      {rows.length === 0 ? <p className="muted">No checked-in outcomes yet.</p> : <ul>{rows.map((r) => <li key={r.lens}>{r.sentence}</li>)}</ul>}
    </div>
  );
}

export default function PredictionsPage() {
  const [d, setD] = useState<Data | null>(null);
  const load = useCallback(() => {
    fetch("/api/predictions").then((r) => r.json()).then(setD);
  }, []);
  useEffect(load, [load]);
  if (!d) return <main className="home"><p className="muted">Loading…</p></main>;
  return (
    <main className="home wide">
      <h1>Predictions</h1>
      <p className="muted">ADAPT records checkable predictions from the Hive&apos;s cycles, each with a check-in date. You rate how each turned out, once.</p>

      <section data-testid="due">
        <h2>Check-ins due ({d.due.length})</h2>
        {d.due.length === 0 ? <p className="muted">Nothing is due.</p> : d.due.map((i) => <CheckIn key={i.id} item={i} onDone={load} />)}
      </section>

      <section data-testid="track-record">
        <h2>Track record</h2>
        <p>
          <strong>{d.trackRecord.caveat}</strong> Below 10 outcomes only counts are shown.
        </p>
        <StatsList title="By the Voice that proposed it" rows={d.trackRecord.byVoice} testid="track-voice" />
        <StatsList title="By mentor lens (verified evidence the prediction rested on)" rows={d.trackRecord.byMentor} testid="track-mentor" />
      </section>

      <section>
        <h2>Upcoming ({d.upcoming.length})</h2>
        {d.upcoming.length === 0 ? <p className="muted">None.</p> : (
          <ul>
            {d.upcoming.map((i) => (
              <li key={i.id}>
                {i.text} <span className="muted">({i.proposedBy}; check-in {day(i.checkInAt)})</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Checked in ({d.checkedIn.length})</h2>
        {d.checkedIn.length === 0 ? <p className="muted">None yet.</p> : (
          <ul>
            {d.checkedIn.map((i) => (
              <li key={i.id}>
                {i.text} <span className="muted">({i.proposedBy})</span>: rated {i.outcomeRating}/5{i.outcomeNote ? `, "${i.outcomeNote}"` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section data-testid="commitments">
        <h2>Commitments</h2>
        {d.commitments.length === 0 ? <p className="muted">None yet.</p> : (
          <ul>
            {d.commitments.map((c) => (
              <li key={c.id}>
                [{c.status}] {c.text} <span className="muted">({c.costType}, cycle {c.cycleMade})</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
