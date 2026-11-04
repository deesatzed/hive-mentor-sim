import "server-only";

/**
 * Heartbeat phases P0–P7 (docs/ARCHITECTURE.md "The heartbeat"; sent2 v1.2 §3.4, guardian steps removed).
 * P0 (intake) always runs first, in code. The order of P1–P7 is chosen by the central manager model
 * or by code (config/hive.yaml `orchestration.mode`, owner decision 2026-11-04), but only among the
 * phases this table allows at that moment: a phase runs once, after the phases it needs.
 */

export type PhaseId = "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7";
export const PHASE_ORDER: PhaseId[] = ["P1", "P2", "P3", "P4", "P5", "P6", "P7"];
export const ALL_PHASES = ["P0", ...PHASE_ORDER] as const;
export type AnyPhase = (typeof ALL_PHASES)[number];

export interface PhaseDef {
  id: PhaseId;
  name: string;
  /** label used in bus bodies and the voice_phase invariant ("WITNESS:deliberate") */
  label: "perceive" | "whisper" | "attend" | "deliberate" | "govern" | "compose" | "reflect";
  requires: PhaseId[];
  /** may be skipped by the manager */
  optional: boolean;
  /** must run before this phase if it runs at all */
  mustPrecede?: PhaseId;
  description: string;
}

export const PHASES: Record<PhaseId, PhaseDef> = {
  P1: { id: "P1", name: "PERCEIVE", label: "perceive", requires: [], optional: false, description: "Read the input: affect, memory retrieval, parse, honesty probe." },
  P2: { id: "P2", name: "WHISPER", label: "whisper", requires: ["P1"], optional: false, description: "Core Voices (minus LUMEN and WITNESS) each whisper one claim; claims are rated." },
  P3: { id: "P3", name: "ATTEND", label: "attend", requires: ["P2"], optional: false, description: "Kernel ranks whispers; LUMEN writes the awareness line from the shortlist." },
  P4: {
    id: "P4",
    name: "DELIBERATE",
    label: "deliberate",
    requires: ["P3"],
    optional: true,
    mustPrecede: "P5",
    description: "Check contradictions, hold a Conclave vote if they conflict, and run the WITNESS audit.",
  },
  P5: { id: "P5", name: "GOVERN", label: "govern", requires: ["P3"], optional: false, description: "SYMBIONT PRIME arbitrates: PASS, AMEND, or ASK_USER." },
  P6: { id: "P6", name: "COMPOSE", label: "compose", requires: ["P5"], optional: false, description: "LEXICON writes the reply; every sentence is checked for faithfulness." },
  P7: { id: "P7", name: "REFLECT", label: "reflect", requires: ["P6"], optional: true, description: "Self-Model delta, memory, lesson, canon candidate; priority decay." },
};

export type NextStep = PhaseId | "FINISH";

/** Phases (and FINISH) that may run next, given what has run. */
export function allowedNext(ran: ReadonlySet<PhaseId>): NextStep[] {
  const out: NextStep[] = [];
  for (const id of PHASE_ORDER) {
    if (ran.has(id)) continue;
    const def = PHASES[id];
    if (!def.requires.every((r) => ran.has(r))) continue;
    if (def.mustPrecede && ran.has(def.mustPrecede)) continue;
    out.push(id);
  }
  if (ran.has("P6")) out.push("FINISH");
  return out;
}

/** The code-default next step: the earliest allowed phase in P1–P7 order, else FINISH. */
export function defaultNext(ran: ReadonlySet<PhaseId>): NextStep {
  const allowed = allowedNext(ran);
  return allowed.find((s) => s !== "FINISH") ?? "FINISH";
}
