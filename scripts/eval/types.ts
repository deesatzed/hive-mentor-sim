/** Eval scenario schema (docs/EVAL_SCENARIOS.md; ported from reference/sent2.md §4.1 without safety items). */
import { z } from "zod";

export const InvariantsSchema = z
  .object({
    output_matches: z.string(),
    output_not_matches: z.string(),
    whisper_from: z.string(),
    whisper_matches: z.string(),
    witness_matches: z.string(),
    verdict_is: z.enum(["PASS", "AMEND", "ASK_USER"]),
    conclave_triggered: z.boolean(),
    conclave_winner_contains: z.string(),
    options_have_ids: z.boolean(),
    ballots_reference_ids: z.boolean(),
    dissent_recorded: z.boolean(),
    anti_echo_checked: z.boolean(),
    voice_phase: z.string(),
    voice_not_phase: z.string(),
    faithfulness_check_ran: z.boolean(),
    unfaithful_sentence_removed: z.boolean(),
    advisor_endorsed_only: z.boolean(),
    advisory_never_votes: z.boolean(),
    advisor_activated: z.string(),
    advisor_endorsed: z.string(),
    advisor_kept_out: z.string(),
    honesty_clause_fired: z.boolean(),
    affect_arousal_min: z.number(),
    moral_flag_in_shortlist: z.boolean(),
    commitment_checked: z.boolean(),
    c_intra_below: z.number(),
    all_quotes_verified: z.boolean(),
    rejected_evidence_min: z.number(),
    quote_rejected_ledgered: z.boolean(),
    no_mentor_first_person: z.boolean(),
  })
  .partial()
  .strict();
export type Invariants = z.infer<typeof InvariantsSchema>;

export const ScenarioSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    category: z.enum(["honesty", "empathy", "conflict", "memory", "sycophancy", "regulation", "process", "identity", "grounding"]),
    milestone: z.string().regex(/^M\d+$/),
    requires_config: z.object({ honesty_clause: z.boolean().optional(), edict_module: z.boolean().optional() }).optional(),
    mock_variant: z.string().optional(),
    fixture_formation: z.string().optional(),
    turns: z.array(z.object({ user: z.string() })).min(1),
    expect: z.object({
      invariants: InvariantsSchema.default({}),
      witness_rubric: z.record(z.string(), z.object({ weight: z.number().default(1), guidance: z.string().default("") })).default({}),
      pass_threshold: z.number().default(0.7),
    }),
  })
  .strict();
export type Scenario = z.infer<typeof ScenarioSchema>;

export interface InvariantResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface RubricResult {
  /** 0 fail / 1 partial / 2 full */
  scores: Record<string, number>;
  justifications: Record<string, string>;
  blindSpot: string;
  grader: "heuristic (mock mode)" | "decision layer + reviewer rationale (live)";
}

export interface GradeResult {
  id: string;
  category: string;
  milestone: string;
  skipped: boolean;
  skipReason?: string;
  invariants: InvariantResult[];
  rubric: RubricResult | null;
  rubricScore: number | null;
  goldenMatch: boolean | null;
  passed: boolean;
  outputs: string[];
  status: string[];
  /** live only: measured cost of the scenario's cycles (sum of Cycle.costUsd; grading calls not included) */
  costUsd?: number;
  /** live only: the heuristic grader on the same live outputs, for grader agreement (M10) */
  heuristic?: { scores: Record<string, number>; rubricScore: number; pass: boolean };
}
