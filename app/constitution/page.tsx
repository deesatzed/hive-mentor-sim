"use client";

import { useEffect, useState } from "react";

/** /constitution — draft from the approved formation, edit, approve (operator only), retire. */

type Principle = { id: string; version: number; text: string; axis: string; status: string; voiceIds: string[]; receipts: { mentor: string; chunkId: string; quote: string }[] };
type Data = { versions: { approved: number | null; draft: number | null }; approved: Principle[]; draft: Principle[] };

function PrincipleCard({ p, onSaved, onRetire }: { p: Principle; onSaved: () => void; onRetire?: () => void }) {
  const [text, setText] = useState(p.text);
  const [editing, setEditing] = useState(false);
  const save = async () => {
    await fetch(`/api/constitution/principles/${p.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    setEditing(false);
    onSaved();
  };
  return (
    <li className="card" data-testid={`principle-${p.status}`}>
      {editing ? (
        <>
          <textarea aria-label="Principle text" value={text} onChange={(e) => setText(e.target.value)} rows={2} cols={70} /> <button onClick={save}>Save</button>
        </>
      ) : (
        <p>
          <strong>{p.text}</strong> <span className="muted">({p.axis})</span>
          {p.status === "draft" && (
            <>
              {" "}
              <button className="link" onClick={() => setEditing(true)}>Edit</button>
            </>
          )}
          {onRetire && (
            <>
              {" "}
              <button className="link" onClick={onRetire}>Retire</button>
            </>
          )}
        </p>
      )}
      <ul>
        {p.receipts.map((r, i) => (
          <li key={i} className="muted">
            {r.mentor} wrote: <q data-quote data-verified="true" data-chunk-id={r.chunkId}>{r.quote}</q>
          </li>
        ))}
      </ul>
    </li>
  );
}

export default function ConstitutionPage() {
  const [d, setD] = useState<Data | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fetchData = (): Promise<Data> => fetch("/api/constitution").then((x) => x.json());
  const load = async () => setD(await fetchData());
  useEffect(() => {
    fetchData().then(setD);
  }, []);
  const generate = async () => {
    setBusy(true);
    const r = await fetch("/api/constitution", { method: "POST" });
    const b = await r.json();
    setMsg(r.ok ? `Draft version ${b.version}: ${b.kept} principles kept, ${b.dropped} dropped for missing receipts.` : b.error);
    setBusy(false);
    await load();
  };
  const approve = async (version: number) => {
    const r = await fetch("/api/constitution/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version }) });
    const b = await r.json();
    setMsg(r.ok ? `Approved constitution version ${version} (${b.approved} principles).` : b.error);
    await load();
  };
  const retire = async (id: string) => {
    await fetch(`/api/constitution/principles/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "retire" }) });
    await load();
  };
  if (!d) return <main className="home"><p className="muted">Loading…</p></main>;
  return (
    <main className="home wide">
      <h1>Constitution</h1>
      <p className="muted">Drafted only from the approved formation&apos;s verified mentor principles. Every receipt is a verified quote. Only you approve; the Hive never changes its constitution.</p>
      <p>
        <button onClick={generate} disabled={busy}>{busy ? "Drafting…" : "Generate draft"}</button>
      </p>
      <p data-testid="constitution-msg" aria-live="polite">{msg}</p>
      <h2>Approved {d.versions.approved ? `(version ${d.versions.approved})` : ""}</h2>
      {d.approved.length === 0 ? <p className="muted">No constitution approved yet.</p> : <ul>{d.approved.map((p) => <PrincipleCard key={p.id} p={p} onSaved={load} onRetire={() => retire(p.id)} />)}</ul>}
      <h2>Draft {d.versions.draft ? `(version ${d.versions.draft})` : ""}</h2>
      {d.draft.length === 0 ? (
        <p className="muted">No draft.</p>
      ) : (
        <>
          <ul>{d.draft.map((p) => <PrincipleCard key={p.id} p={p} onSaved={load} />)}</ul>
          <button onClick={() => approve(d.versions.draft!)}>Approve draft version {d.versions.draft}</button>
        </>
      )}
      <p className="muted">Edict module: an optional framework that ranks below this constitution (on/off in config/hive.yaml).</p>
    </main>
  );
}
