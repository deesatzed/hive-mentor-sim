"use client";

import { useEffect, useState } from "react";

/** /formation — compose the Hive's character: which mentors give each Core Voice its attribute lens. */

type Mentor = { id: string; name: string; years: string; roles: string[]; active: boolean; inactiveReason: string | null; works: { title: string; translator: string | null; attributed: boolean; license: string }[]; stats: { answered?: number; principles?: number } };
type Data = {
  current: { version: number; status: string; assignments: Record<string, string[]> } | null;
  history: { version: number; status: string; note: string | null; createdAt: string; _count: { members: number } }[];
  voices: { id: string; name: string; attribute: string; tier: string; guilds: string[] }[];
  mentors: Mentor[];
  metrics: { nEff: number; activeMentors: number; perVoice: Record<string, { kappa: number | null; pairs: number }> };
};

export default function FormationPage() {
  const [d, setD] = useState<Data | null>(null);
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const apply = (r: Data) => {
    setD(r);
    const active = new Set(r.mentors.filter((m) => m.active).map((m) => m.id));
    // start from the current formation, keeping only active mentors (inactive ones cannot form a lens)
    setDraft(Object.fromEntries(r.voices.map((v) => [v.id, (r.current?.assignments[v.id] ?? []).filter((m) => active.has(m))])));
  };
  const fetchData = (): Promise<Data> => fetch("/api/formation").then((x) => x.json());
  const load = async () => apply(await fetchData());
  useEffect(() => {
    fetchData().then(apply);
  }, []);
  if (!d) return <main className="home"><p className="muted">Loading…</p></main>;
  const byId = new Map(d.mentors.map((m) => [m.id, m]));
  const active = d.mentors.filter((m) => m.active);
  const toggle = (voice: string, mentor: string) =>
    setDraft((cur) => {
      const has = cur[voice]?.includes(mentor);
      const next = has ? cur[voice].filter((x) => x !== mentor) : [...(cur[voice] ?? []), mentor];
      return next.length > 3 ? cur : { ...cur, [voice]: next };
    });
  const save = async () => {
    const r = await fetch("/api/formation", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assignments: draft, note: "saved from /formation" }) });
    const b = await r.json();
    setMsg(r.ok ? `Saved formation version ${b.version} (draft).` : b.error);
    await load();
  };
  const approve = async (version: number) => {
    const r = await fetch("/api/formation/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version }) });
    const b = await r.json();
    setMsg(r.ok ? `Approved formation version ${version}.` : b.error);
    await load();
  };
  const newestDraft = d.history.find((h) => h.status === "draft");
  return (
    <main className="home wide">
      <h1>Formation</h1>
      <p className="muted">
        Current: {d.current ? `version ${d.current.version} (${d.current.status})` : "none"}. {d.metrics.activeMentors} active mentors act like{" "}
        <strong data-testid="neff">{d.metrics.nEff.toFixed(1)}</strong> distinct perspectives (N_eff, from agreement on dilemma choices).
      </p>
      <table>
        <thead>
          <tr><th>Voice</th><th>Faculty</th><th>Mentors (1–3, active only)</th><th>Mentors agree (κ)</th></tr>
        </thead>
        <tbody>
          {d.voices.map((v) => (
            <tr key={v.id}>
              <td>{v.name}</td>
              <td>{v.attribute}</td>
              <td>
                {active.map((m) => (
                  <label key={m.id} className="chip">
                    <input type="checkbox" checked={draft[v.id]?.includes(m.id) ?? false} onChange={() => toggle(v.id, m.id)} aria-label={`${v.name}: ${m.name}`} /> {m.name}
                  </label>
                ))}
                {(draft[v.id] ?? []).length === 0 && <span className="muted"> no attribute lens</span>}
              </td>
              <td>{d.metrics.perVoice[v.id]?.kappa == null ? "-" : d.metrics.perVoice[v.id].kappa!.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <button onClick={save}>Save as new version</button>{" "}
        {newestDraft && <button onClick={() => approve(newestDraft.version)}>Approve version {newestDraft.version}</button>}
      </p>
      <p data-testid="formation-msg" aria-live="polite">{msg}</p>
      <h2>Versions</h2>
      <ul>{d.history.map((h) => <li key={h.version}>v{h.version} · {h.status} · {h._count.members} assignments{h.note ? ` · ${h.note}` : ""}</li>)}</ul>
      <section>
        <h2>About these lenses</h2>
        <p>Built only from public-domain writings listed below. This is a reading of their texts, not the person. Writings reflect their era. The written record is skewed toward a narrow slice of humanity.</p>
        <ul>
          {d.mentors.map((m) => (
            <li key={m.id}>
              <strong>{m.name}</strong> ({m.years}) — {m.active ? `active · ${m.stats.answered ?? 0} answered · ${m.stats.principles ?? 0} principles` : `inactive: ${m.inactiveReason ?? "corpus not built"}`}
              <ul>
                {m.works.map((w) => (
                  <li key={w.title} className="muted">
                    {w.title}
                    {w.translator ? `, tr. ${w.translator}` : ""}
                    {w.attributed ? " (traditionally attributed)" : ""} · {w.license}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>
      <p className="muted">{byId.size} mentors in the roster.</p>
    </main>
  );
}
