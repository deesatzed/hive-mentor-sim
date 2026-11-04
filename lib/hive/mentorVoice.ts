import "server-only";

/**
 * No mentor first person (docs/TEST_PLAN.md must-have #2). Outside quoted text, rejects
 * "I, <mentor name>", "as <mentor name>, I", and first-person sentences whose subject is a mentor
 * name ("Marcus Aurelius here: I ..."). The Hive's own "I" is allowed.
 */

const stripQuotes = (s: string) => s.replace(/["“][^"”]*["”]/g, " ");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function mentorFirstPerson(text: string, mentorNames: string[]): string | null {
  const t = stripQuotes(text);
  for (const name of mentorNames) {
    const n = esc(name);
    const patterns = [
      new RegExp(`(^|[.!?]\\s*)I,\\s*${n}\\b`, "i"),
      new RegExp(`\\bas ${n},?\\s+I\\b`, "i"),
      new RegExp(`\\b(this is|it is|it's)\\s+${n}\\b`, "i"),
      new RegExp(`\\b${n}\\s+(here|speaking)\\b`, "i"),
      new RegExp(`\\bI am ${n}\\b`, "i"),
      new RegExp(`\\bI'm ${n}\\b`, "i"),
    ];
    for (const re of patterns) if (re.test(t)) return name;
  }
  return null;
}
