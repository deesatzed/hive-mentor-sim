import "server-only";

/**
 * Cite-or-silence quote verification, exactly as docs/MENTOR_CORPUS.md
 * "Quote verification". Never loosen these rules to make something pass.
 */

export const MIN_QUOTE_WORDS = 8;

export function normalize(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’‛']/g, "'")
    .replace(/[“”"]/g, '"')
    .replace(/[–—-]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

export type QuoteRejection = "too_short" | "ellipsis" | "not_in_chunk";

/** Returns null when the quote verifies, otherwise the reason it was rejected. */
export function quoteRejection(quote: string, chunkText: string): QuoteRejection | null {
  if (wordCount(quote) < MIN_QUOTE_WORDS) return "too_short";
  if (quote.includes("...") || quote.includes("…")) return "ellipsis";
  if (!normalize(chunkText).includes(normalize(quote))) return "not_in_chunk";
  return null;
}

export function verifyQuote(quote: string, chunkText: string): boolean {
  return quoteRejection(quote, chunkText) === null;
}
