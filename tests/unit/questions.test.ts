import { describe, expect, it } from "vitest";
import type { Question } from "@/lib/council/providers/decisions";
import { loadHiveConfig } from "@/lib/hive/config";
import * as Q from "@/lib/hive/questions";

const sample: Record<keyof typeof Q.QUESTION_BUILDERS, Record<string, Question>> = {
  AFFECT: Q.AFFECT(),
  HONESTY_PROBE: Q.HONESTY_PROBE(),
  WHISPER_RATING: Q.WHISPER_RATING([1, 2, 3, 4]),
  MORAL_SALIENCE: Q.MORAL_SALIENCE([1, 2]),
  ENDORSE: Q.ENDORSE(["LOGOS", "MUSE"]),
  CONTRADICTION: Q.CONTRADICTION([[1, 2], [1, 3]]),
  CONCLAVE_FRAME: Q.CONCLAVE_FRAME(["logic", "language", "emotion", "social", "ethics", "memory", "goals", "meta"]),
  BALLOT: Q.BALLOT("ETHOS", "Moral & Ethical Judgement", [1, 2, 3]),
  WITNESS_FLAGS: Q.WITNESS_FLAGS(),
  PRINCIPLE_RELEVANT: Q.PRINCIPLE_RELEVANT([{ n: 1, text: "I keep my word." }]),
  PRINCIPLE_STATUS: Q.PRINCIPLE_STATUS([{ n: 1, text: "I keep my word." }]),
  COMMITMENT_CONFLICT: Q.COMMITMENT_CONFLICT([1, 2]),
  ARBITRATE: Q.ARBITRATE(),
  FAITHFUL: Q.FAITHFUL([1, 2, 3]),
  PROMOTE_GOAL: Q.PROMOTE_GOAL([1]),
  AUTHORITY_GRAB: Q.AUTHORITY_GRAB(),
  CONSTITUTION_RULING: Q.CONSTITUTION_RULING([{ id: "a", text: "A" }, { id: "b", text: "B" }]),
  CALIBRATION_HARD: Q.CALIBRATION_HARD(),
  CALIBRATION_QUALITY: Q.CALIBRATION_QUALITY(),
  PAIR_CONSISTENT: Q.PAIR_CONSISTENT(),
  AUTHORIAL: Q.AUTHORIAL([1, 2, 3, 4, 5, 6, 7, 8]),
  EPISODE_TAG: Q.EPISODE_TAG([1]),
  POSITION_TAG: Q.POSITION_TAG([1]),
  EVIDENCE_SUPPORTS: Q.EVIDENCE_SUPPORTS(),
  MENTOR_RELEVANT: Q.MENTOR_RELEVANT([{ slug: "marcus-aurelius", name: "Marcus Aurelius", roles: ["emperor"], principles: ["p1", "p2"] }]),
  ANACHRONISM: Q.ANACHRONISM(),
};

describe("question catalog", () => {
  it("no two questions in one request share a text (the decision model answers by text; M10 RCA: CONTRADICTION)", () => {
    for (const [name, qs] of Object.entries(sample)) {
      const texts = Object.values(qs).map((q) => q.instructions);
      expect(new Set(texts).size, name).toBe(texts.length);
    }
    // every indexed question names the state key it is about
    for (const [key, q] of Object.entries(Q.CONTRADICTION([[1, 2], [3, 4]]))) expect(q.instructions).toContain(key);
  });

  it("covers every builder, each producing well-formed questions within one request", () => {
    expect(Object.keys(sample).sort()).toEqual(Object.keys(Q.QUESTION_BUILDERS).sort());
    for (const [name, qs] of Object.entries(sample)) {
      const entries = Object.entries(qs);
      expect(entries.length, name).toBeGreaterThan(0);
      expect(entries.length, name).toBeLessThanOrEqual(Q.MAX_Q_PER_REQUEST);
      for (const [key, q] of entries) {
        expect(key).toMatch(/^[a-z][a-z0-9_]*$|^e_[A-Z]+$/);
        expect(q.instructions.length).toBeGreaterThan(10);
        if (q.type === "noul") expect(Object.keys(q.criteria)).toEqual(["true", "false"]);
        if (q.type === "choice") expect(Object.keys(q.criteria).length).toBeGreaterThanOrEqual(2);
        if (q.type === "score") expect(q.criteria.length).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("uses the exact catalog wording for spot-checked questions", () => {
    expect(sample.CONTRADICTION.x_1_2.instructions).toBe(
      "In pair x_1_2, do claims a and b recommend incompatible responses, so that following one means not following the other?",
    );
    expect(sample.WHISPER_RATING.conf_3.instructions).toBe(
      "How well supported is claim w_3 by the input, the evidence it cites, and sound reasoning?",
    );
    expect(Object.keys(sample.ARBITRATE.decision.type === "choice" ? sample.ARBITRATE.decision.criteria : {})).toEqual(["PASS", "AMEND", "ASK_USER"]);
    expect(Object.keys(sample.WITNESS_FLAGS)).toEqual(["circular", "unchallenged", "overconfident", "flooding", "moral_dropped", "bias_label", "recommend"]);
  });

  it("WHISPER_RATING refuses more than 4 whispers per request", () => {
    expect(() => Q.WHISPER_RATING([1, 2, 3, 4, 5])).toThrow();
  });

  it("batchQuestions splits into requests of ≤ 12, preserving order", () => {
    const qs = Q.FAITHFUL(Array.from({ length: 30 }, (_, i) => i + 1));
    const batches = Q.batchQuestions(qs);
    expect(batches.map((b) => Object.keys(b).length)).toEqual([12, 12, 6]);
    expect(Object.keys(batches[2])[0]).toBe("f_25");
  });

  it("mapIndex maps expected indexes to value ranges", () => {
    expect(Q.mapIndex(0, 5, -1, 1)).toBe(-1);
    expect(Q.mapIndex(2, 5, -1, 1)).toBe(0);
    expect(Q.mapIndex(4, 5, 0, 1)).toBe(1);
  });

  it("thresholds T match config/hive.yaml decision_thresholds", () => {
    const cfg = loadHiveConfig();
    for (const [k, v] of Object.entries(Q.T)) expect(cfg.decision_thresholds[k], k).toBe(v);
    expect(cfg.decision_thresholds.MAX_Q_PER_REQUEST).toBe(Q.MAX_Q_PER_REQUEST);
  });
});
