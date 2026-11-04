import "server-only";

/**
 * Fidelity-eval leak filter (docs/MENTOR_CORPUS.md step 8): a generated scenario is discarded when
 * it shares any 6-word sequence with its passage, or names the author or any of the author's works.
 */

const norm = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export function shingles(text: string, n = 6): Set<string> {
  const w = norm(text).split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}

export interface LeakCheck {
  leaks: boolean;
  reasons: string[];
}

export function scenarioLeaks(args: { scenario: string; options: { text: string }[]; passage: string; authorName: string; workTitles: string[] }): LeakCheck {
  const reasons: string[] = [];
  const scen = [args.scenario, ...args.options.map((o) => o.text)].join(" ");
  const p = shingles(args.passage);
  const shared = [...shingles(scen)].find((s) => p.has(s));
  if (shared) reasons.push(`shares the 6-word sequence "${shared}" with the passage`);
  const s = ` ${norm(scen)} `;
  const nameParts = norm(args.authorName).split(" ").filter((x) => x.length > 2);
  if (s.includes(` ${norm(args.authorName)} `) || nameParts.some((x) => s.includes(` ${x} `))) reasons.push("names the author");
  for (const t of args.workTitles) {
    const nt = norm(t.replace(/[,;:(].*$/, ""));
    if (nt.split(" ").length >= 2 && s.includes(` ${nt} `)) reasons.push(`names the work "${t}"`);
  }
  return { leaks: reasons.length > 0, reasons };
}
