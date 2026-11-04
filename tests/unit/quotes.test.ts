import { describe, expect, it } from "vitest";
import { normalize, quoteRejection, verifyQuote } from "@/lib/council/quotes";

// Public-domain passage copied from Project Gutenberg eBook #2680 (Marcus Aurelius, Meditations,
// "The Second Book", §I; downloaded 2026-11-04). Line breaks joined with spaces.
const CHUNK =
  "I. Remember how long thou hast already put off these things, and how often a certain day and hour as it were, having been set unto thee by the gods, thou hast neglected it. It is high time for thee to understand the true nature both of the world, whereof thou art a part; and of that Lord and Governor of the world, from whom, as a channel from the spring, thou thyself didst flow: and that there is but a certain limit of time appointed unto thee, which if thou shalt not make use of to calm and allay the many distempers of thy soul, it will pass away and thou with it, and never after return.";

describe("verifyQuote", () => {
  it("passes an exact quote of ≥ 8 words", () => {
    expect(verifyQuote("Remember how long thou hast already put off these things", CHUNK)).toBe(true);
    expect(verifyQuote("there is but a certain limit of time appointed unto thee", CHUNK)).toBe(true);
  });

  it("passes curly vs straight quotes and dash/whitespace/case differences", () => {
    // Constructed string (not a corpus passage) that exercises typographic folding.
    const chunk = "He said, “Begin the morning by saying to thyself” — and so on, for it’s right to do so.";
    expect(verifyQuote('he said, "begin the   morning by saying to thyself" - and so on', chunk)).toBe(true);
    expect(verifyQuote("and so on, for it's right to do so.", chunk)).toBe(true);
  });

  it("rejects ellipses (three dots or the ellipsis character)", () => {
    expect(quoteRejection("Remember how long thou hast ... put off these things", CHUNK)).toBe("ellipsis");
    expect(quoteRejection("Remember how long thou hast … put off these things", CHUNK)).toBe("ellipsis");
  });

  it("rejects fewer than 8 words even if present", () => {
    expect(quoteRejection("Remember how long thou hast already put", CHUNK)).toBe("too_short");
  });

  it("rejects paraphrase", () => {
    expect(quoteRejection("Remember how long you have already postponed these things", CHUNK)).toBe("not_in_chunk");
  });

  it("normalize is NFKC, quote/dash folding, whitespace collapse, lowercase", () => {
    expect(normalize("  A—B–C  ‘x’ “y”\n\tZ ")).toBe("a-b-c 'x' \"y\" z");
  });
});
