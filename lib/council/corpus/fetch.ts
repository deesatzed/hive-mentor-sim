import "server-only";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stripGutenberg, wikisourceText } from "./text";

/**
 * Corpus fetch (docs/MENTOR_CORPUS.md step 1, with the owner-approved Gutenberg plan of 2026-11-04):
 * Project Gutenberg books by number from gutenberg.org (Gutendex served a Cloudflare challenge), and
 * Seneca's letters from Wikisource. Raw downloads go to corpus/raw/<slug>/ (gitignored). Network
 * failures retry twice, then the work is reported failed.
 */

export type GetText = (url: string) => Promise<string>;

export const realGet: GetText = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": "hive-mentor-sim (research simulation; corpus build)" }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
};

async function withRetry<T>(fn: () => Promise<T>, tries = 3, waitMs = 1500): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, waitMs * (i + 1)));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface FetchedWork {
  sourceUrl: string;
  license: string;
  text: string;
  sha256: string;
  rawFile: string;
}

export const gutenbergUrl = (id: number) => `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`;

export async function fetchGutenberg(id: number, rawDir: string, get: GetText = realGet): Promise<FetchedWork> {
  const url = gutenbergUrl(id);
  const file = path.join(rawDir, `pg${id}.txt`);
  const raw = existsSync(file) ? readFileSync(file, "utf8") : await withRetry(() => get(url));
  mkdirSync(rawDir, { recursive: true });
  if (!existsSync(file)) writeFileSync(file, raw);
  const text = stripGutenberg(raw);
  return { sourceUrl: url, license: `Public domain in the US; source: Project Gutenberg #${id}`, text, sha256: sha256(raw), rawFile: file };
}

/** One letter's body: the extracted page text without the collection title and the letter's own title line. */
export function letterBody(html: string): string {
  return wikisourceText(html)
    .replace(/^THE EPISTLES OF SENECA\s*/i, "")
    .replace(/^[IVXLC]+\.\s+[^\n]*\n/, "")
    .trim();
}

export const wikisourceRenderUrl = (title: string) => `https://en.wikisource.org/w/index.php?title=${encodeURIComponent(title.replace(/ /g, "_"))}&action=render`;

/** Seneca's Moral letters: subpages "Letter 1".."Letter N" of the index page, joined with "LETTER n" headings. */
export async function fetchWikisourceLetters(index: string, rawDir: string, get: GetText = realGet, maxLetters = 124): Promise<FetchedWork & { letters: number; failed: number[] }> {
  mkdirSync(rawDir, { recursive: true });
  const parts: string[] = [];
  const failed: number[] = [];
  let raws = "";
  for (let n = 1; n <= maxLetters; n++) {
    const file = path.join(rawDir, `letter_${n}.html`);
    let html: string;
    try {
      html = existsSync(file) ? readFileSync(file, "utf8") : await withRetry(() => get(wikisourceRenderUrl(`${index}/Letter ${n}`)));
    } catch {
      failed.push(n);
      continue;
    }
    if (!existsSync(file)) writeFileSync(file, html);
    raws += html;
    parts.push(`LETTER ${n}\n\n${letterBody(html)}`); // the letter's own title line is replaced by this heading
  }
  return {
    sourceUrl: wikisourceRenderUrl(index),
    license: "Public domain in the US (Gummere translation, Loeb 1917-1925); source: Wikisource",
    text: parts.join("\n\n"),
    sha256: sha256(raws),
    rawFile: rawDir,
    letters: parts.length,
    failed,
  };
}
