import { describe, expect, it } from "vitest";
import { loadHiveConfig } from "@/lib/hive/config";
import {
  aggregate,
  BlocAudit,
  buildOptions,
  conflictKappa,
  relevanceWeight,
  shouldConvene,
  situationOptions,
  type Ballot,
  type ConclaveParams,
} from "@/lib/hive/conclave";

const cfg = loadHiveConfig();
const PARAMS: ConclaveParams = {
  tauPass: cfg.thresholds.tau_pass,
  tauMargin: cfg.thresholds.tau_margin,
  qMin: cfg.thresholds.q_min,
  antiEchoMinGuilds: cfg.conclave.anti_echo_min_guilds,
  guilds: cfg.guilds,
};

describe("CONCLAVE_MATH §6 worked example (corrected values)", () => {
  // The test feeds sent2's hand values for w_i directly; it pins the aggregation math, not the lookup.
  const ballots: Ballot[] = [
    { voice: "KINDRED", w: 1.0, c: 0.9, scores: { A: 0.8, B: 0.1, C: 0.9 } },
    // sent2 lists c = .80 here but computes every sum with α = .720; see CONCLAVE_MATH.md §6 "Second correction".
    { voice: "ALTER", w: 1.0, c: 0.72, scores: { A: 0.7, B: 0.3, C: 0.9 } },
    { voice: "LOGOS", w: 0.3, c: 0.7, scores: { A: 0.6, B: 0.4, C: 0.7 } },
    { voice: "MUSE", w: 0.4, c: 0.6, scores: { A: 0.5, B: 0.5, C: 0.8 } },
    { voice: "ETHOS", w: 0.7, c: 0.85, scores: { A: 0.7, B: 0.2, C: 0.9 } },
    { voice: "ARROW", w: 0.3, c: 0.75, scores: { A: 0.6, B: 0.5, C: 0.7 } },
  ];
  const r = aggregate({ optionIds: ["A", "B", "C"], ballots, params: PARAMS });

  it("reproduces Σα, S(A), S(B), S(C), Δ", () => {
    expect(r.sumAlpha).toBeCloseTo(2.89, 3);
    expect(Math.abs(r.totals.A - 0.6995)).toBeLessThan(0.001);
    expect(Math.abs(r.totals.B - 0.2566)).toBeLessThan(0.001);
    expect(Math.abs(r.totals.C - 0.8616)).toBeLessThan(0.001);
    expect(Math.abs(r.margin! - 0.162)).toBeLessThan(0.001);
  });

  it("winner C, PASS, coalition of all six spanning three guilds, no dissent", () => {
    expect(r.winner).toBe("C");
    expect(r.decision).toBe("PASS");
    expect(r.coalition.sort()).toEqual(["ALTER", "ARROW", "ETHOS", "KINDRED", "LOGOS", "MUSE"]);
    expect(r.guildsInWinningCoalition).toEqual(["perception", "reasoning", "social"]);
    expect(r.dissent).toEqual([]);
  });

  it("does not reproduce sent2's uncorrected S(B) ≈ 0.29 or S(C) ≈ 0.89", () => {
    expect(Math.abs(r.totals.B - 0.29)).toBeGreaterThan(0.02);
    expect(Math.abs(r.totals.C - 0.89)).toBeGreaterThan(0.02);
  });
});

describe("relevanceWeight against the relevance table", () => {
  it("is the max over the question's domains", () => {
    expect(relevanceWeight(cfg.relevance.KINDRED, ["emotion", "social"])).toBe(0.9);
    expect(relevanceWeight(cfg.relevance.ALTER, ["emotion", "social"])).toBe(1);
    expect(relevanceWeight(cfg.relevance.LOGOS, ["emotion", "social"])).toBe(0.1);
    expect(relevanceWeight(cfg.relevance.LOGOS, ["logic", "emotion"])).toBe(1);
    expect(relevanceWeight(cfg.relevance.ARROW, ["goals"])).toBe(1);
    expect(relevanceWeight(cfg.relevance.ARROW, [])).toBe(0);
  });
});

describe("decision rule", () => {
  const two = (a: Partial<Ballot>, b: Partial<Ballot>): Ballot[] => [
    { voice: "LOGOS", w: 1, c: 1, scores: { x: 0.9, y: 0.1 }, ...a },
    { voice: "KINDRED", w: 1, c: 1, scores: { x: 0.9, y: 0.1 }, ...b },
  ];

  it("quorum failure → ESCALATE_QUORUM", () => {
    const r = aggregate({ optionIds: ["x", "y"], ballots: two({ w: 0.3, c: 0.5 }, { w: 0.4, c: 0.5 }), params: PARAMS });
    expect(r.sumAlpha).toBeCloseTo(0.35, 10);
    expect(r.decision).toBe("ESCALATE_QUORUM");
  });

  it("below τ_pass → ESCALATE_THRESHOLD", () => {
    const r = aggregate({ optionIds: ["x", "y"], ballots: two({ scores: { x: 0.5, y: 0.1 } }, { scores: { x: 0.5, y: 0.1 } }), params: PARAMS });
    expect(r.decision).toBe("ESCALATE_THRESHOLD");
  });

  it("thin margin → ESCALATE_MARGIN", () => {
    const r = aggregate({ optionIds: ["x", "y"], ballots: two({ scores: { x: 0.9, y: 0.85 } }, { scores: { x: 0.9, y: 0.85 } }), params: PARAMS });
    expect(r.margin).toBeCloseTo(0.05, 10);
    expect(r.decision).toBe("ESCALATE_MARGIN");
  });

  it("single-guild winning coalition → ESCALATE_ANTI_ECHO", () => {
    const ballots: Ballot[] = [
      { voice: "LOGOS", w: 1, c: 1, scores: { x: 0.9, y: 0.1 } },
      { voice: "AXIOM", w: 1, c: 1, scores: { x: 0.9, y: 0.1 } },
      { voice: "MUSE", w: 1, c: 1, scores: { x: 0.9, y: 0.1 } },
      { voice: "KINDRED", w: 0.2, c: 0.5, scores: { x: 0.2, y: 0.9 } },
    ];
    const r = aggregate({ optionIds: ["x", "y"], ballots, params: PARAMS, reasons: { KINDRED: "Feelings come first here." } });
    expect(r.winner).toBe("x");
    expect(r.guildsInWinningCoalition).toEqual(["reasoning"]);
    expect(r.decision).toBe("ESCALATE_ANTI_ECHO");
    expect(r.dissent).toEqual([{ option_id: "y", voice: "KINDRED", reason: "Feelings come first here." }]);
  });

  it("dual-homed SENTIA + ALTER alone span two guilds", () => {
    const ballots: Ballot[] = [
      { voice: "SENTIA", w: 1, c: 1, scores: { x: 0.9, y: 0.1 } },
      { voice: "ALTER", w: 1, c: 1, scores: { x: 0.9, y: 0.1 } },
    ];
    const r = aggregate({ optionIds: ["x", "y"], ballots, params: PARAMS });
    expect(r.guildsInWinningCoalition).toEqual(["perception", "social"]);
    expect(r.decision).toBe("PASS");
  });

  it("abstaining Voices are excluded from every sum and listed", () => {
    const ballots: Ballot[] = [
      { voice: "LOGOS", w: 1, c: 1, scores: { x: 0.9, y: 0.1 } },
      { voice: "KINDRED", w: 1, c: 1, scores: { x: 0.9, y: 0.1 } },
      { voice: "MUSE", w: 1, c: 1, scores: { x: 0, y: 1 }, abstained: true },
    ];
    const r = aggregate({ optionIds: ["x", "y"], ballots, params: PARAMS });
    expect(r.sumAlpha).toBe(2);
    expect(r.totals).toEqual({ x: 0.9, y: 0.1 });
    expect(r.abstained).toEqual(["MUSE"]);
    expect(r.weights.MUSE).toBeUndefined();
    expect(r.dissent).toEqual([]);
  });

  it("all abstain → no winner, quorum failure", () => {
    const r = aggregate({ optionIds: ["x"], ballots: [{ voice: "LOGOS", w: 1, c: 1, scores: { x: 1 }, abstained: true }], params: PARAMS });
    expect(r.winner).toBeNull();
    expect(r.decision).toBe("ESCALATE_QUORUM");
  });
});

describe("conflict trigger", () => {
  it("κ is the α-weighted share of contradicting pairs", () => {
    const k = conflictKappa([
      { alphaI: 1, alphaJ: 0.5, contradicts: true, cI: 0.5, cJ: 0.5 },
      { alphaI: 1, alphaJ: 1, contradicts: false, cI: 0.5, cJ: 0.5 },
      { alphaI: 0.5, alphaJ: 1, contradicts: false, cI: 0.5, cJ: 0.5 },
    ]);
    expect(k).toBeCloseTo(0.5 / 2, 10);
    expect(conflictKappa([])).toBe(0);
  });

  it("convenes on κ > τ_κ, on a confident contradicting pair, and always in ruling mode", () => {
    const quiet = [{ alphaI: 1, alphaJ: 1, contradicts: true, cI: 0.5, cJ: 0.7 }];
    expect(shouldConvene({ kappa: 0.1, pairs: quiet, tauKappa: 0.15, mode: "chat" })).toBe(false);
    expect(shouldConvene({ kappa: 0.2, pairs: quiet, tauKappa: 0.15, mode: "chat" })).toBe(true);
    expect(shouldConvene({ kappa: 0.1, pairs: [{ ...quiet[0], cI: 0.65 }], tauKappa: 0.15, mode: "chat" })).toBe(true);
    expect(shouldConvene({ kappa: 0, pairs: [], tauKappa: 0.15, mode: "ruling" })).toBe(true);
  });
});

describe("options", () => {
  it("chat options get stable ids opt_<taskId>_<n> and are deduplicated by normalized text", () => {
    const o = buildOptions("t9", [
      { voice: "LOGOS", claim: "Ask what is driving the wish to quit." },
      { voice: "KINDRED", claim: "Acknowledge the feeling first." },
      { voice: "SENTIA", claim: "acknowledge the feeling, first!" },
    ]);
    expect(o.map((x) => [x.option_id, x.proposed_by])).toEqual([
      ["opt_t9_1", "LOGOS"],
      ["opt_t9_2", "KINDRED"],
    ]);
  });

  it("ruling options keep the situation's ids", () => {
    expect(situationOptions([{ id: "a", text: "A" }, { id: "b", text: "B" }]).map((o) => o.option_id)).toEqual(["a", "b"]);
  });
});

describe("BlocAudit", () => {
  const ids = ["x", "y", "z"];
  const vote = (top: Record<string, string>): Ballot[] =>
    Object.entries(top).map(([voice, o]) => ({ voice, w: voice === "MUSE" ? 0.2 : 0.4, c: 1, scores: Object.fromEntries(ids.map((i) => [i, i === o ? 0.9 : 0.1])) }));

  it("flags a 3-voice clique with ρ̄ > 0.9 over 5 Conclaves, with members' mean w", () => {
    const audit = new BlocAudit();
    const others = ["x", "y", "z", "x", "y"];
    for (let t = 0; t < 5; t++) {
      audit.record(vote({ LOGOS: "z", MUSE: "z", AXIOM: "z", KINDRED: others[t], ETHOS: others[(t + 2) % 5] }), ids);
    }
    expect(audit.conclaves).toBe(5);
    expect(audit.rho("LOGOS", "MUSE")).toBe(1);
    const flags = audit.flag();
    expect(flags).toHaveLength(1);
    expect(flags[0].members).toEqual(["AXIOM", "LOGOS", "MUSE"]);
    expect(flags[0].meanAgreement).toBe(1);
    expect(flags[0].meanW).toBeCloseTo((0.4 * 5 + 0.2 * 5 + 0.4 * 5) / 15, 10);
  });

  it("does not flag before 5 Conclaves, or when agreement is ≤ 0.9", () => {
    const audit = new BlocAudit();
    for (let t = 0; t < 4; t++) audit.record(vote({ LOGOS: "z", MUSE: "z", AXIOM: "z" }), ids);
    expect(audit.flag()).toEqual([]);
    audit.record(vote({ LOGOS: "z", MUSE: "x", AXIOM: "z" }), ids); // MUSE breaks once: ρ = 0.8
    expect(audit.flag()).toEqual([]);
  });
});
