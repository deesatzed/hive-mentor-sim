import { describe, expect, it } from "vitest";
import { attentionScore, normalizeClaim, rank, type AttentionItem } from "@/lib/hive/attention";

const item = (id: string, s: number, c: number, v = 0, claim = `claim ${id}`): AttentionItem => ({ id, claim, salience: s, confidence: c, valence: v });
const OPTS = { k: 2, lambda: 0.2, mu: 0.1 };

describe("kernel attention", () => {
  it("A(m) = s·c − λ·dup + μ·|v|", () => {
    expect(attentionScore(item("a", 0.8, 0.5, -0.5), 0, 0.2, 0.1)).toBeCloseTo(0.45, 10);
    expect(attentionScore(item("a", 0.8, 0.5, -0.5), 1, 0.2, 0.1)).toBeCloseTo(0.25, 10);
  });

  it("moral-flagged items bypass ranking and stay on the shortlist; the rest beyond k decay and are listed", () => {
    const items = [item("w1", 0.9, 0.9), item("w2", 0.8, 0.8), item("w3", 0.5, 0.5), item("w4", 0.1, 0.1), item("m1", 0.05, 0.1)];
    const r = rank(items, { ...OPTS, moralFlagged: new Set(["m1"]) });
    expect(r.bypass).toEqual(["m1"]);
    expect(r.shortlist).toEqual(["m1", "w1", "w2"]);
    expect(r.decayed).toEqual(["w3", "w4"]);
    expect(Object.keys(r.scores).sort()).toEqual(["m1", "w1", "w2", "w3", "w4"]);
  });

  it("a claim already in memory is penalized and can drop out", () => {
    const items = [item("w1", 0.6, 0.6, 0, "Ask before advising."), item("w2", 0.55, 0.55), item("w3", 0.5, 0.5)];
    const r = rank(items, { ...OPTS, seenClaims: new Set([normalizeClaim("ask before advising")]) });
    expect(r.scores.w1).toBeCloseTo(0.36 - 0.2, 10);
    expect(r.shortlist).toEqual(["w2", "w3"]);
    expect(r.decayed).toEqual(["w1"]);
  });

  it("is deterministic regardless of input order (ties broken by id)", () => {
    const items = [item("b", 0.5, 0.5), item("a", 0.5, 0.5), item("c", 0.5, 0.5)];
    expect(rank(items, OPTS).shortlist).toEqual(["a", "b"]);
    expect(rank([...items].reverse(), OPTS).shortlist).toEqual(["a", "b"]);
  });

  it("a tie key (the Voice name) decides ties before the random message id, so runs repeat (M9)", () => {
    const items = [{ ...item("zz-random", 0.5, 0.5), tieKey: "ALTER" }, { ...item("aa-random", 0.5, 0.5), tieKey: "OMEGA" }, { ...item("mm-random", 0.5, 0.5), tieKey: "KINDRED" }];
    expect(rank(items, OPTS).shortlist).toEqual(["zz-random", "mm-random"]);
    expect(rank([...items].reverse(), OPTS).shortlist).toEqual(["zz-random", "mm-random"]);
  });
});
