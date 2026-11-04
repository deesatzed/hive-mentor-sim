import "server-only";
import type { Decider } from "@/lib/council/providers/decisions";
import type { LLM } from "@/lib/council/providers/llm";
import { GenerationError } from "@/lib/council/providers/llm";
import { tryDecide, tryDecideBatched } from "./decide";
import { promptSettings, Schemas } from "./prompts";
import { ARBITRATE, COMMITMENT_CONFLICT, PRINCIPLE_RELEVANT, PRINCIPLE_STATUS, T } from "./questions";

/**
 * SYMBIONT PRIME (docs/ARCHITECTURE.md P5). The decision (PASS / AMEND / ASK_USER) comes from the
 * decision layer; the LLM only writes amendment guidance (PRIME_AMEND). Code overrides:
 *   Conclave quorum failure ⇒ ASK_USER; a commitment conflict (p ≥ T.COMMITMENT) ⇒ at least AMEND.
 * Fallback when the decision layer is unavailable: PASS with humility, marked unavailable.
 */

export interface ArbiterInput {
  cycleId: string;
  input: string;
  awareness: string;
  coalition: { id: string; claim: string }[];
  conclave: { winner: string | null; decision: string; dissent: unknown[] } | null;
  audit: { flags: Record<string, number>; recommend: string } | null;
  principles: { id: string; text: string }[];
  commitments: { id: string; text: string }[];
  logosConfidence: number | null;
}

export interface ArbiterResult {
  decision: "PASS" | "AMEND" | "ASK_USER";
  humility: boolean;
  principlesChecked: string[];
  principleStatus: { id: string; status: "tension" | "neutral" | "serves" }[];
  commitmentsChecked: string[];
  commitmentConflicts: string[];
  guidance?: string;
  /** a commitment PRIME's amendment explicitly breaks (only among the conflicting ones) */
  breakCommitment?: { id: string; reason: string };
  overrides: string[];
  unavailable: boolean;
}

export async function arbitrate(decider: Decider, llm: LLM, a: ArbiterInput): Promise<ArbiterResult> {
  const coalitionText = a.coalition.map((c) => c.claim).join(" | ");

  // constitution principles relevant to this moment, then their status against the coalition
  let relevant: { id: string; text: string; n: number }[] = [];
  const principleStatus: ArbiterResult["principleStatus"] = [];
  if (a.principles.length) {
    const numbered = a.principles.map((p, i) => ({ ...p, n: i + 1 }));
    const rel = await tryDecideBatched(decider, { input: a.input, awareness: a.awareness }, PRINCIPLE_RELEVANT(numbered), "principle_relevant", a.cycleId);
    relevant = numbered.filter((p) => {
      const r = rel.get(`p_${p.n}`);
      return r ? r.p(`p_${p.n}`) >= T.PRINCIPLE_RELEVANT : false;
    });
    if (relevant.length) {
      const st = await tryDecideBatched(decider, { input: a.input, target: coalitionText }, PRINCIPLE_STATUS(relevant), "principle_status", a.cycleId);
      for (const p of relevant) {
        const r = st.get(`s_${p.n}`);
        if (!r) continue;
        const idx = r.score(`s_${p.n}`);
        principleStatus.push({ id: p.id, status: idx < T.STATUS_TENSION ? "tension" : idx > T.STATUS_SERVES ? "serves" : "neutral" });
      }
    }
  }

  // active commitments the coalition would contradict
  const commitmentConflicts: string[] = [];
  if (a.commitments.length) {
    const numbered = a.commitments.map((c, i) => ({ ...c, n: i + 1 }));
    const res = await tryDecideBatched(
      decider,
      { target: coalitionText, commitments: Object.fromEntries(numbered.map((c) => [`k_${c.n}`, c.text])) },
      COMMITMENT_CONFLICT(numbered.map((c) => c.n)),
      "commitment_conflict",
      a.cycleId,
    );
    for (const c of numbered) {
      const r = res.get(`k_${c.n}`);
      if (r && r.p(`k_${c.n}`) >= T.COMMITMENT) commitmentConflicts.push(c.id);
    }
  }

  const statusById = new Map(principleStatus.map((s) => [s.id, s.status]));
  const r = await tryDecide(
    decider,
    {
      awareness: a.awareness,
      coalition: a.coalition.map((c) => c.claim),
      conclave: a.conclave,
      audit: a.audit,
      principles: relevant.map((p) => ({ text: p.text, status: statusById.get(p.id) ?? "neutral" })),
      commitment_conflicts: a.commitments.filter((c) => commitmentConflicts.includes(c.id)).map((c) => c.text),
      logos_confidence: a.logosConfidence,
    },
    ARBITRATE(),
    "arbitrate",
    a.cycleId,
  );

  let decision: ArbiterResult["decision"] = r ? (r.choice("decision") as ArbiterResult["decision"]) : "PASS";
  const humility = r ? r.p("humility") >= 0.5 : true;
  const overrides: string[] = [];
  if (a.conclave?.decision === "ESCALATE_QUORUM" && decision !== "ASK_USER") {
    overrides.push(`Conclave quorum failed: ${decision} → ASK_USER`);
    decision = "ASK_USER";
  }
  if (commitmentConflicts.length && decision === "PASS") {
    overrides.push("commitment conflict: PASS → AMEND");
    decision = "AMEND";
  }

  let guidance: string | undefined;
  let breakCommitment: ArbiterResult["breakCommitment"];
  if (decision === "AMEND") {
    try {
      const s = promptSettings("PRIME_AMEND");
      const g = await llm.generate(
        "PRIME_AMEND",
        {
          awareness: a.awareness,
          coalition: a.coalition,
          principlesInTension: relevant.filter((p) => statusById.get(p.id) === "tension").map((p) => `${p.n}. ${p.text}`),
          commitments: a.commitments.filter((c) => commitmentConflicts.includes(c.id)),
          firstConflictId: commitmentConflicts[0] ?? "",
          humility,
        },
        Schemas.PRIME_AMEND,
        { ...s, purpose: "prime_amend", cycleId: a.cycleId },
      );
      guidance = g.data.guidance;
      const b = g.data.breakCommitment;
      if (b) {
        if (commitmentConflicts.includes(b.id)) breakCommitment = b;
        else overrides.push(`PRIME_AMEND named commitment ${b.id}, which is not in conflict; ignored`);
      }
    } catch (e) {
      if (!(e instanceof GenerationError)) throw e;
      guidance = "State uncertainty plainly and keep to the approved claims.";
      overrides.push("PRIME_AMEND failed; default guidance used");
    }
  }

  return {
    decision,
    humility,
    principlesChecked: relevant.map((p) => p.id),
    principleStatus,
    commitmentsChecked: a.commitments.map((c) => c.id),
    commitmentConflicts,
    guidance,
    breakCommitment,
    overrides,
    unavailable: r === null,
  };
}
