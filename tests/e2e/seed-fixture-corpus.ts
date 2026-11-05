/**
 * e2e FIXTURE CORPUS (mock run only): Seneca's Letter 1 (real public-domain text from
 * tests/fixtures/corpus) chunked and embedded with MockEmbedder, one TEST-FIXTURE mentor principle
 * (text written for the test; its two receipts are verbatim sentences extracted from the real chunk),
 * and Seneca marked active. Never used outside e2e.db.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { disconnectAll, getDb } from "@/lib/council/db";
import { letterBody } from "@/lib/council/corpus/fetch";
import { chunkWork } from "@/lib/council/corpus/text";
import { toBytes } from "@/lib/council/corpus/vectors";
import { MockEmbedder } from "@/lib/council/providers/mocks";

async function main() {
  const db = getDb(process.env.DATABASE_URL ?? "file:./e2e.db");
  const html = readFileSync(path.join(process.cwd(), "tests", "fixtures", "corpus", "seneca_letter_1.html"), "utf8");
  const work = await db.corpusWork.create({ data: { mentorId: "seneca", title: "Moral letters to Lucilius", translator: "Richard M. Gummere", sourceUrl: "fixture:seneca_letter_1", license: "Public domain in the US (fixture excerpt)", sha256: "fixture" } });
  const chunks = chunkWork("Moral letters to Lucilius", `LETTER 1\n\n${letterBody(html)}`);
  const e = new MockEmbedder();
  const vecs = await e.embed(chunks.map((c) => c.text));
  for (let i = 0; i < chunks.length; i++)
    await db.corpusChunk.create({ data: { workId: work.id, mentorId: "seneca", locator: chunks[i].locator, ordinal: chunks[i].ordinal, text: chunks[i].text, tokenCount: chunks[i].tokenCount, embedding: toBytes(vecs[i]), embedModel: e.model } });
  const first = await db.corpusChunk.findFirstOrThrow({ where: { mentorId: "seneca" }, orderBy: { ordinal: "asc" } });
  const sentences = (first.text.match(/[^.!?]+[.!?]/g) ?? []).map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= 8);
  const [pv] = await e.embed(["saving time"]);
  await db.mentorPrinciple.create({ data: { mentorId: "seneca", text: "(e2e fixture) Seneca urges saving time instead of letting it be taken.", axis: "time", receipts: JSON.stringify(sentences.slice(0, 2).map((quote) => ({ chunkId: first.id, quote }))), embedding: toBytes(pv) } });
  await db.mentor.update({ where: { id: "seneca" }, data: { active: true, corpusStats: JSON.stringify({ answered: 0, principles: 1, steps: {} }) } });
  await disconnectAll();
}
main();
