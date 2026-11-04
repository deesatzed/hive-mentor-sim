import "server-only";

/**
 * Corpus text handling (docs/MENTOR_CORPUS.md steps 1–2): Gutenberg header/footer strip, Wikisource
 * HTML extraction, and chunking into 150–450-word chunks of whole paragraphs with readable locators.
 * Pure functions; tested against real public-domain excerpts in tests/fixtures/corpus/.
 */

/** Keeps the text between the "*** START OF" and "*** END OF" lines. Throws if either marker is missing. */
export function stripGutenberg(raw: string): string {
  const text = raw.replace(/\r\n?/g, "\n");
  const start = text.search(/^\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG.*$/im);
  const end = text.search(/^\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG.*$/im);
  if (start < 0 || end < 0 || end <= start) throw new Error("Gutenberg START/END markers not found");
  const afterStart = text.indexOf("\n", start);
  return text.slice(afterStart + 1, end).trim();
}

const decodeEntities = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");

/**
 * Text of a rendered Wikisource page (action=render): the proofread page output only, without
 * layout data, page numbers, footnote markers, or the reference list.
 */
export function wikisourceText(html: string): string {
  let s = html.replace(/\s(data-[a-z-]+|about|typeof|id|style)=("[^"]*"|'[^']*')/g, "");
  const i = s.indexOf('class="prp-pages-output"');
  if (i >= 0) s = s.slice(s.indexOf(">", i) + 1);
  s = s
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, "")
    .replace(/<sup[^>]*class="reference"[^>]*>[\s\S]*?<\/sup>/g, "")
    .replace(/<span[^>]*class="pagenum[^"]*"[^>]*>[\s\S]*?<\/span>/g, "")
    .replace(/<ol class="references"[\s\S]*$/, "")
    .replace(/<div[^>]*class="[^"]*(reflist|references)[^"]*"[\s\S]*$/, "")
    .replace(/<\/(p|div|h\d|li)>|<br\s*\/?>/g, "\n\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(s)
    .replace(/\[\d+\]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** Structural headings (MENTOR_CORPUS.md): short lines only, so numbered prose paragraphs are not headings. */
export function isHeading(par: string): boolean {
  const p = par.trim();
  if (!p || wordCount(p) > 14 || p.includes("\n\n")) return false;
  return /^(BOOK|CHAPTER|LETTER|ESSAY|PART|SECTION)\b/.test(p) || /^[IVXLCDM]+\.?$/.test(p) || /^\d+\.\s/.test(p) || /^[IVXLCDM]+\.\s+[A-Z][A-Z ,'’;:-]+$/.test(p);
}

/** Splits a long paragraph at sentence ends into pieces of at most `max` words (a sentence is never split). */
export function splitParagraph(par: string, max: number): string[] {
  if (wordCount(par) <= max) return [par];
  const sentences = par.match(/[^.!?]+[.!?]+["'’”)\]]*\s*|[^.!?]+$/g) ?? [par];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && wordCount(cur) + wordCount(s) > max) {
      out.push(cur.trim());
      cur = "";
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export interface Chunk {
  ordinal: number;
  locator: string;
  text: string;
  tokenCount: number;
}

const shortTitle = (title: string) => title.replace(/[,;:(].*$/, "").split(/\s+/).slice(0, 4).join(" ");
const sectionLabel = (heading: string) => {
  const h = heading.replace(/\s+/g, " ").trim();
  const m = h.match(/^(BOOK|CHAPTER|LETTER|ESSAY|PART|SECTION)\s+([IVXLCDM\d]+)/i);
  if (m) return `${m[1][0]}${m[1].slice(1).toLowerCase()} ${m[2]}`;
  const r = h.match(/^([IVXLCDM]+)\.?(\s|$)/);
  if (r) return `§${r[1]}`;
  const n = h.match(/^(\d+)\./);
  if (n) return `§${n[1]}`;
  return h.slice(0, 40);
};

/**
 * Chunks a work: split into sections at structural headings; within a section, pack whole paragraphs
 * into chunks of `min`–`max` words (a short final chunk joins the previous one when it fits); no
 * overlap. Locator: "<short title>, <section>, ¶<k>" or "<short title>, ¶<ordinal>".
 */
export function chunkWork(title: string, text: string, opts: { min?: number; max?: number; minKeep?: number } = {}): Chunk[] {
  const min = opts.min ?? 150;
  const max = opts.max ?? 450;
  const minKeep = opts.minKeep ?? 25;
  const paras = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
  const sections: { label: string | null; paras: string[] }[] = [{ label: null, paras: [] }];
  for (const p of paras) {
    if (isHeading(p)) sections.push({ label: sectionLabel(p), paras: [] });
    else sections[sections.length - 1].paras.push(...splitParagraph(p, max));
  }
  const st = shortTitle(title);
  const out: Chunk[] = [];
  for (const sec of sections) {
    const groups: string[][] = [];
    let cur: string[] = [];
    let n = 0;
    for (const p of sec.paras) {
      const w = wordCount(p);
      if (cur.length && n + w > max) {
        groups.push(cur);
        cur = [];
        n = 0;
      }
      cur.push(p);
      n += w;
      if (n >= min) {
        groups.push(cur);
        cur = [];
        n = 0;
      }
    }
    if (cur.length) {
      const last = groups[groups.length - 1];
      if (last && wordCount(last.join(" ")) + n <= max && n < min) last.push(...cur);
      else groups.push(cur);
    }
    groups.forEach((g, k) => {
      const body = g.join("\n\n");
      if (wordCount(body) < minKeep) return;
      out.push({ ordinal: out.length + 1, locator: sec.label ? `${st}, ${sec.label}, ¶${k + 1}` : `${st}, ¶${out.length + 1}`, text: body, tokenCount: Math.round(wordCount(body) * 1.33) });
    });
  }
  return out;
}
