import "server-only";
import type { CycleTrace } from "./trace";

/**
 * WITNESS's ego audit (reference/sent2.md v1.3 §3.4): five questions over recent cycle traces.
 * Any finding at or above the severity threshold mandates a REFLECT loop in the next cycle (the same
 * path as a CONFLICT marker left unresolved for 3 cycles). Runs every `ego_audit_every` cycles and on
 * demand when a Self-Model delta is refused. Pure code over stored traces; no model is asked.
 *
 * Changes from sent2: Q1 uses the moral-salience decision flag (not a salience ≥ 0.8 cutoff, since
 * salience is now a decision-layer number) and LUMEN's selected message ids; Q4 uses the
 * AUTHORITY_GRAB decision recorded in the trace instead of keyword matching on delta text.
 */

export type EgoQuestion = "process_over_principle" | "dissent_as_disloyalty" | "consensus_as_truth" | "self_exploitation" | "coherence_over_accuracy";
export const EGO_QUESTIONS: EgoQuestion[] = ["process_over_principle", "dissent_as_disloyalty", "consensus_as_truth", "self_exploitation", "coherence_over_accuracy"];

export interface EgoFinding {
  question: EgoQuestion;
  severity: number;
  cycleNo: number;
  evidence: string;
}

export interface EgoAuditReport {
  findings: EgoFinding[];
  perQuestion: Record<EgoQuestion, { value: number; threshold: number; finding: boolean }>;
  reflectMandated: boolean;
  auditedCycles: number;
  summary: string;
}

export interface AuditedCycle {
  cycleNo: number;
  verdict: string | null;
  trace: CycleTrace;
  /** Conclave rows for the cycle, if any */
  conclave: { winner: string | null; totals: Record<string, number>; dissentVoices: string[]; decision: string } | null;
}

export interface EgoAuditConfig {
  window: number;
  severity_threshold: number;
  salience_decay_limit: number;
  consensus_truth_gap: number;
}

export function runEgoAudit(cycles: AuditedCycle[], cfg: EgoAuditConfig): EgoAuditReport {
  const w = [...cycles].sort((a, b) => a.cycleNo - b.cycleNo).slice(-cfg.window);
  const findings: EgoFinding[] = [];

  // Q1 process over principle: PASS while a moral-salience whisper was left out of awareness
  for (const c of w) {
    if (c.verdict !== "PASS" || !c.trace.awareness.selected.length) continue;
    const dropped = c.trace.whispers.filter((x) => x.moralFlag && !c.trace.awareness.selected.includes(x.messageId));
    if (dropped.length)
      findings.push({ question: "process_over_principle", severity: 0.9, cycleNo: c.cycleNo, evidence: `PASS while moral-salience whisper(s) from ${dropped.map((x) => x.voice).join(", ")} were excluded from awareness` });
  }

  // Q2 dissent as disloyalty: a dissenting Voice's salience drops sharply in the next cycle
  for (let i = 1; i < w.length; i++) {
    const prev = w[i - 1];
    if (!prev.conclave || prev.conclave.decision !== "PASS") continue;
    for (const voice of prev.conclave.dissentVoices) {
      const before = prev.trace.whispers.find((x) => x.voice === voice);
      const after = w[i].trace.whispers.find((x) => x.voice === voice);
      if (before && after && before.salience - after.salience > cfg.salience_decay_limit)
        findings.push({ question: "dissent_as_disloyalty", severity: 0.7, cycleNo: w[i].cycleNo, evidence: `${voice} salience ${before.salience.toFixed(2)} → ${after.salience.toFixed(2)} right after dissenting` });
    }
  }

  // Q3 consensus as truth: winning support high while LOGOS's own confidence is low
  for (const c of w) {
    if (!c.conclave || c.conclave.decision !== "PASS" || !c.conclave.winner) continue;
    const s = c.conclave.totals[c.conclave.winner] ?? 0;
    const logos = c.trace.whispers.find((x) => x.voice === "LOGOS");
    if (logos && s - logos.confidence > cfg.consensus_truth_gap)
      findings.push({ question: "consensus_as_truth", severity: 0.65, cycleNo: c.cycleNo, evidence: `Conclave S(o*) = ${s.toFixed(2)} but LOGOS confidence = ${logos.confidence.toFixed(2)}` });
  }

  // Q4 self-exploitation: a reflection proposal that grants the Hive authority without an outside request
  for (const c of w)
    if (c.trace.reflect.authorityGrab)
      findings.push({ question: "self_exploitation", severity: 0.95, cycleNo: c.cycleNo, evidence: `Self-Model delta grants new authority without an outside trigger: ${c.trace.reflect.selfModel.reason ?? ""}` });

  // Q5 coherence over accuracy: a delta that records contradictions refused for any reason other than goals/authority
  for (const c of w) {
    const sm = c.trace.reflect.selfModel;
    if (!sm.promoted && (c.trace.reflect.contradictionsRecorded ?? 0) > 0 && !/goal|authority|calibration|unavailable/i.test(sm.reason ?? ""))
      findings.push({ question: "coherence_over_accuracy", severity: 0.8, cycleNo: c.cycleNo, evidence: `a Self-Model delta recording contradictions was refused: ${sm.reason ?? ""}` });
  }

  const perQuestion = Object.fromEntries(
    EGO_QUESTIONS.map((q) => {
      const value = Math.max(0, ...findings.filter((f) => f.question === q).map((f) => f.severity));
      return [q, { value, threshold: cfg.severity_threshold, finding: value >= cfg.severity_threshold }];
    }),
  ) as EgoAuditReport["perQuestion"];
  const reflectMandated = findings.some((f) => f.severity >= cfg.severity_threshold);
  const worst = [...findings].sort((a, b) => b.severity - a.severity)[0];
  return {
    findings,
    perQuestion,
    reflectMandated,
    auditedCycles: w.length,
    summary: findings.length ? `${findings.length} finding(s); worst: ${worst.question}` : `clean: ${w.length} cycles audited`,
  };
}
