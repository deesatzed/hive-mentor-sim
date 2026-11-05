"use client";

/** Shared cycle-trace rendering for /hive and /cycles/[id] (docs/PRODUCT_SPEC.md §4). */

export type Trace = {
  mode: string;
  mock: boolean;
  phases: Record<string, { ran: boolean; ms: number; costUsd: number; entities: string[] }>;
  orchestration: { mode: string; managerModel: string | null; steps: { phase: string; by: string; reason: string }[] };
  affect: { valence: number; arousal: number; dominant: string; unavailable: boolean };
  memories: { id: string; certainty: string; priority: number; body: string }[];
  parse: { intent: string; subtext: string; register: string };
  whispers: { messageId: string; voice: string; claim: string; confidence: number; salience: number; valence: number; moralFlag: boolean; evidence: { chunkId: string; quote: string; mentorId: string }[]; rejectedEvidence: number; numbersUnavailable: boolean; lens?: string[] }[];
  passes: string[];
  attention: { scores: Record<string, number>; shortlist: string[]; bypass: string[]; decayed: string[]; rejectedSelections: string[] };
  awareness: { text: string; selected: string[] };
  deliberation: { kappa: number; contradictions: { a: string; b: string; p: number }[]; domains: string[] };
  conclaveId?: string;
  witness: { ran: boolean; flags: Record<string, number>; recommendation: string; quality: string; notConsidering: string; reflectRan: boolean; reflectReason: string | null };
  arbiter: { decision: string; humility: boolean; principlesChecked: string[]; commitmentsChecked: string[]; guidance?: string; overrides: string[]; commitmentConflicts: string[]; commitmentsBroken: { id: string; reason: string }[] };
  compose: { draft: string; faithfulness: { sentence: string; p: number | null; kept: boolean }[]; regenerated: boolean; quotes?: { chunkId: string; quote: string; mentorId: string }[] };
  reflect: { ran: boolean; selfModel: { promoted: boolean; reason?: string; version?: number }; memory: string[]; lesson?: string; canon: { promoted: boolean; candidate?: string }; predictions: string[]; commitmentsMade: string[]; conflictMarkers: string[]; authorityGrab: boolean };
  honestyClauseFired: boolean;
  coherence: { cIntra: number | null; cInter: number | null; flags: string[] };
  hats: { entity: string; type: string }[];
  egoAudit: { ran: boolean; mandate: boolean; summary: string };
  error?: { phase: string; message: string };
};

export const n = (x: number) => x.toFixed(2);

function Section({ title, phase, trace, children }: { title: string; phase?: string; trace: Trace; children: React.ReactNode }) {
  const p = phase ? trace.phases[phase] : undefined;
  return (
    <section className="trace-section" data-testid={`trace-${title.toLowerCase().split(" ")[0]}`}>
      <h4>
        {title}
        {p && (
          <span className="muted">
            {" "}
            · {p.ran ? `${p.ms} ms · $${p.costUsd.toFixed(6)}` : "did not run"}
          </span>
        )}
      </h4>
      {children}
    </section>
  );
}

export function TraceView({ t, conclave }: { t: Trace; conclave: Conclave | null }) {
  const voiceOf = new Map(t.whispers.map((w) => [w.messageId, w.voice]));
  return (
    <div className="trace">
      {t.mock && <p className="mock-banner">Mock providers: scripted outputs, not model behavior.</p>}
      <p className="muted">
        Ordering: {t.orchestration.mode}
        {t.orchestration.managerModel ? ` (${t.orchestration.managerModel})` : ""} · {t.orchestration.steps.map((s) => `${s.phase}·${s.by}`).join(" → ")}
      </p>
      {t.error && <p className="error">Cycle stopped in {t.error.phase}: {t.error.message}</p>}
      <Section title="Perceive" phase="P1" trace={t}>
        <p>
          Affect: valence {n(t.affect.valence)}, arousal {n(t.affect.arousal)}, {t.affect.dominant}
          {t.affect.unavailable ? " (unavailable)" : ""} · Parse: {t.parse.intent} / {t.parse.register}
          {t.honestyClauseFired ? " · Honesty Clause fired" : ""}
        </p>
        <ul>{t.memories.map((m) => <li key={m.id}>[{m.certainty}] {m.body}</li>)}</ul>
        {t.memories.length === 0 && <p className="muted">No memories retrieved.</p>}
      </Section>
      <Section title="Whispers" phase="P2" trace={t}>
        <div className="cards">
          {t.whispers.map((w) => (
            <div key={w.messageId} className="card">
              <strong>{w.voice}</strong> {w.moralFlag && <span className="tag">moral</span>}
              <p>{w.claim}</p>
              <p className="muted">
                c {n(w.confidence)} · s {n(w.salience)} · v {n(w.valence)}
                {w.numbersUnavailable ? " (unavailable)" : ""}
              </p>
              <p className="muted">
                {w.lens?.length ? `Lens: ${w.lens.join(", ")}. ` : "No attribute lens. "}
                {w.evidence.length === 0 ? "No evidence cited." : w.evidence.map((e, i) => (
                  <q key={`${e.chunkId}-${i}`} data-quote data-verified="true" data-chunk-id={e.chunkId}>{e.quote}</q>
                ))}
                {w.rejectedEvidence ? ` · ${w.rejectedEvidence} quote(s) rejected` : ""}
              </p>
            </div>
          ))}
        </div>
        {t.passes.length > 0 && <p className="muted">PASS: {t.passes.join(", ")}</p>}
      </Section>
      <Section title="Attention" phase="P3" trace={t}>
        <ol>
          {t.attention.shortlist.map((id) => (
            <li key={id}>
              {voiceOf.get(id)} · A {n(t.attention.scores[id] ?? 0)}
              {t.attention.bypass.includes(id) ? " (moral bypass)" : ""}
            </li>
          ))}
        </ol>
        {t.attention.decayed.length > 0 && <p className="muted">Decayed: {t.attention.decayed.map((id) => voiceOf.get(id)).join(", ")}</p>}
        {t.attention.rejectedSelections.length > 0 && <p className="muted">Rejected LUMEN selections: {t.attention.rejectedSelections.length}</p>}
      </Section>
      <Section title="Awareness" phase="P3" trace={t}>
        <p>{t.awareness.text}</p>
        <p className="muted">Built from: {t.awareness.selected.map((id) => voiceOf.get(id)).join(", ")}</p>
      </Section>
      <Section title="Conclave" phase="P4" trace={t}>
        <p className="muted">
          κ {n(t.deliberation.kappa)} · {t.deliberation.contradictions.length} contradiction(s) · domains {t.deliberation.domains.join(", ") || "none"}
        </p>
        {conclave ? (
          <div>
            <p>{conclave.question}</p>
            <table>
              <thead>
                <tr>
                  <th>Voice</th>
                  <th>α</th>
                  {conclave.options.map((o, i) => <th key={o.option_id} title={o.claim}>o{i + 1}</th>)}
                </tr>
              </thead>
              <tbody>
                {Object.entries(conclave.ballots).map(([v, b]) => (
                  <tr key={v}>
                    <td>{v}</td>
                    <td>{conclave.weights[v] ? n(conclave.weights[v].alpha) : "abstained"}</td>
                    {conclave.options.map((o) => <td key={o.option_id}>{"abstained" in b ? "-" : n((b as Record<string, number>)[o.option_id] ?? 0)}</td>)}
                  </tr>
                ))}
                <tr>
                  <td>S(o)</td>
                  <td />
                  {conclave.options.map((o) => <td key={o.option_id}><strong>{n(conclave.totals[o.option_id] ?? 0)}</strong></td>)}
                </tr>
              </tbody>
            </table>
            <ol className="muted">{conclave.options.map((o) => <li key={o.option_id}>{o.claim}{o.option_id === conclave.winner ? " ← winner" : ""}</li>)}</ol>
            <p>
              Decision {conclave.decision} · margin {conclave.margin === null ? "-" : n(conclave.margin)} · dissent: {conclave.dissent.map((d) => d.voice).join(", ") || "none"}
            </p>
          </div>
        ) : (
          <p className="muted">No Conclave this cycle.</p>
        )}
      </Section>
      <Section title="WITNESS audit" phase="P4" trace={t}>
        {t.witness.ran ? (
          <>
            <p>
              {t.witness.recommendation} · {t.witness.quality}
              {t.witness.reflectRan ? ` · REFLECT ran (${t.witness.reflectReason})` : ""}
            </p>
            <p className="muted">{Object.entries(t.witness.flags).map(([k, v]) => `${k} ${n(v)}`).join(" · ")}</p>
            <p>Not considering: {t.witness.notConsidering}</p>
            <p className="muted">
              Coherence: C_intra {t.coherence.cIntra === null ? "-" : n(t.coherence.cIntra)} · C_inter {t.coherence.cInter === null ? "-" : n(t.coherence.cInter)}
              {t.coherence.flags.length ? ` · ${t.coherence.flags.join("; ")}` : ""}
            </p>
          </>
        ) : (
          <p className="muted">Not run.</p>
        )}
      </Section>
      <Section title="Arbiter" phase="P5" trace={t}>
        <p>
          {t.arbiter.decision}
          {t.arbiter.humility ? " · humility" : ""}
          {t.arbiter.guidance ? ` · ${t.arbiter.guidance}` : ""}
        </p>
        <p className="muted">
          Principles checked: {t.arbiter.principlesChecked.length} · commitments checked: {t.arbiter.commitmentsChecked.length}
          {t.arbiter.commitmentConflicts.length ? ` · ${t.arbiter.commitmentConflicts.length} in conflict` : ""}
          {t.arbiter.commitmentsBroken.length ? ` · broken with PRIME approval: ${t.arbiter.commitmentsBroken.map((b) => b.reason).join("; ")}` : ""}
          {t.arbiter.overrides.length ? ` · ${t.arbiter.overrides.join("; ")}` : ""}
        </p>
      </Section>
      <Section title="Compose" phase="P6" trace={t}>
        <ul>
          {t.compose.faithfulness.map((f, i) => (
            <li key={i} className={f.kept ? "" : "dropped"}>
              {f.kept ? "kept" : "dropped"} ({f.p === null ? "-" : n(f.p)}): {f.sentence}
            </li>
          ))}
        </ul>
        {t.compose.regenerated && <p className="muted">Regenerated once after an unfaithful draft.</p>}
      </Section>
      <Section title="Reflect" phase="P7" trace={t}>
        {t.reflect.ran ? (
          <p className="muted">
            Commitments made {t.reflect.commitmentsMade.length} · CONFLICT markers {t.reflect.conflictMarkers.length}
            {t.reflect.authorityGrab ? " · authority grab refused" : ""}
            {t.egoAudit.ran ? ` · ego audit: ${t.egoAudit.summary}${t.egoAudit.mandate ? " (REFLECT mandated next cycle)" : ""}` : ""} · Hats: {t.hats.map((h) => `${h.entity}:${h.type}`).join(", ")} · Self-Model {t.reflect.selfModel.promoted ? `v${t.reflect.selfModel.version} promoted` : `not promoted (${t.reflect.selfModel.reason ?? "no change"})`} · memories {t.reflect.memory.length} · lesson {t.reflect.lesson ?? "none"} · canon {t.reflect.canon.candidate ? (t.reflect.canon.promoted ? "promoted" : "candidate only") : "none"} · predictions {t.reflect.predictions.length}
          </p>
        ) : (
          <p className="muted">Not run.</p>
        )}
      </Section>
    </div>
  );
}

export type Conclave = {
  question: string;
  options: { option_id: string; claim: string }[];
  ballots: Record<string, Record<string, number> | { abstained: true }>;
  weights: Record<string, { alpha: number }>;
  totals: Record<string, number>;
  winner: string | null;
  margin: number | null;
  decision: string;
  dissent: { voice: string }[];
};

/** Renders the reply with every verified quote marked (cite or silence: only verified quotes reach the reply). */
export function ReplyText({ text, quotes }: { text: string; quotes: { chunkId: string; quote: string }[] }) {
  const parts: React.ReactNode[] = [];
  let rest = text;
  let k = 0;
  for (const q of quotes) {
    const i = rest.indexOf(q.quote);
    if (i < 0) continue;
    parts.push(rest.slice(0, i), <q key={k++} data-quote data-verified="true" data-chunk-id={q.chunkId}>{q.quote}</q>);
    rest = rest.slice(i + q.quote.length);
  }
  parts.push(rest);
  return <>{parts}</>;
}
