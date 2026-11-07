# Mentor corpus: sourcing, ingestion, fingerprints, fidelity

## Eligibility rules (hard)

1. **No date-of-death cutoff** (owner decision 2026-11-07; the earlier "died before 1956" rule from the original handoff is removed, and mentors may be living). Every mentor still contributes only works that are public domain in the US (rule 3).
2. **Primary writings by the person**, or a direct translation of them. Biographies, dictated accounts written by others, and "sayings of" collections assembled long after are not allowed. *Exception:* classical works traditionally attributed to the figure (the *Analects*, the *Tao Te Ching*) are allowed with an "attributed" tag shown in the UI.
3. **Public domain in the US**, with the source's copyright flag confirming it. Project Gutenberg via the Gutendex API (`copyright: false`) or Wikisource.
4. **Enough text:** ≥ 10,000 words of authorial text after filtering (owner lowered this from 30,000 on 2026-11-06; `config/hive.yaml: corpus.activation.min_authorial_words`).
5. **Activation threshold:** a mentor becomes `active=true` only after a complete build with:
   - ≥ 13 dilemmas answered with verified evidence (owner lowered this from 15 on 2026-11-04; `config/hive.yaml: corpus.activation`);
   - ≥ 8 mentor principles, each with ≥ 2 verified receipts;
   - a fidelity report generated.

## Roster

The seed roster is `seed/mentor_roster.json`: 18 candidates chosen for breadth across eras, roles, regions, and gender, within the limits above. The written record is skewed toward a narrow slice of humanity, and the roster says so in the UI ("About this roster"). Candidates that fail availability or eligibility checks are marked inactive with a reason, never silently dropped. Only the owner adds figures to the roster (2026-11-06: Winston Churchill, replacing William Osler in SENTIA and HERITAGE). Every added mentor must pass the same rules.

## Pipeline (`pnpm corpus build --mentor <slug|all>`)

Each step is idempotent and resumable. Progress for each mentor is recorded in `Mentor.corpusStats`. Raw downloads go to `corpus/raw/<slug>/`, which is gitignored. Only DB rows are used at runtime.

### 1. fetch

**As built (owner decision 2026-11-04):** Gutendex served a Cloudflare challenge, so books are fetched from gutenberg.org by number (`https://www.gutenberg.org/cache/epub/<id>/pg<id>.txt`). The numbers, titles, translators, and each book's RDF `dcterms:rights` ("Public domain in the USA.") are recorded in `seed/corpus_sources.json`, resolved from Project Gutenberg's catalog. Seneca's letters come from Wikisource rendered pages (`Moral letters to Lucilius/Letter N`, `action=render`), because the index page transcludes scanned pages and raw wikitext holds no letter text. Works not on Gutenberg are listed under `unavailable` and make the mentor inactive with that reason. Passages are labeled P1..P8 in `MENTOR_ANSWER` prompts (E1..En in `MENTOR_PRINCIPLES`) and mapped back to chunk ids in code, because the model miscopied long database ids; every quote is still verified against exactly the chunk its label names.

The original plan, kept for reference:
- **Gutendex:** `GET https://gutendex.com/books?search=<title words + author surname>`.
  - Choose the result whose `authors[].name` matches the roster author and whose title matches the roster title.
  - **Require `copyright === false`.**
  - Take the `text/plain; charset=utf-8` URL from `formats`; otherwise `text/plain`.
- **Wikisource**, when `source: "wikisource"`: fetch the index page given in the roster entry, discover its subpage links (e.g., individual letters), and fetch each with `?action=raw`. Strip wiki markup with a conservative regex pass: templates `{{…}}`, refs, links `[[a|b]]` → `b`, and headings kept as headings.
- Strip the Project Gutenberg header and footer: keep text between `*** START OF` and `*** END OF` lines.
- Save `sha256`. Create `CorpusWork` with `sourceUrl` and `license` ("Public domain in the US; source: Project Gutenberg #<id>" or "Wikisource").
- **Network unavailable:** retry 2×, then mark the work failed, record it in `PROGRESS.md`, and continue. A mentor with zero fetched works stays inactive.

### 2. chunk
- Split on structural headings, recognized by regex:
  - `^(BOOK|CHAPTER|LETTER|ESSAY|PART|SECTION)\b`
  - Roman numerals alone on a line
  - `^\d+\.\s`
- Within a section, pack whole paragraphs into chunks of 150–450 words. Never split a sentence. No overlap (quotes must map to one chunk).
- **`locator`** is human-readable: `"{Work short title}, Book {n}, §{m}"`, or `"Letter {n}"`, or `"Ch. {n}, ¶{k}"`. Fall back to `"¶{ordinal}"`.

### 3. authorial filter
- Run decision **AUTHORIAL** on each chunk, batched 8 per request (see below). Drop chunks with p < 0.5. This removes translator introductions, editorial notes, indexes, and tables of contents.
- If < 30,000 authorial words remain, mark the mentor inactive with the reason "insufficient authorial text."

### 4. embed
- Embedder from `getProviders()`: OpenRouter embeddings from `OPENROUTER_EMB_MODEL_1..N` (owner decision 2026-11-04). Retrieval may rerank candidates with `OPENROUTER_RETRIEVAL_MODEL_1..N`. Store `embedding`, `embedModel`.
- **If the embedding model changes, re-embed all chunks.** Retrieval refuses to mix models.

### 5. tag episodes and positions
- Decision **EPISODE_TAG** sets `isEpisode` and `episodeP`, used for precedent search.
- Decision **POSITION_TAG** (below) marks chunks that state a clear position or describe the author's own choice. These are fidelity-eval candidates.

### 6. hold out
- With a fixed seed (`hash(slug)`), mark 10% of POSITION-tagged chunks, capped at 40, as `heldOut=true`. **Held-out chunks are never returned by `retrieval.search`.** They exist only for the fidelity eval.

### 7. fingerprint
For each dilemma in `seed/dilemmas.json` and each question in `local/question_bank_subset.json` (owner machine only, not in the public repo):
- Retrieve the top 8 non-held-out chunks for the mentor (query = question text + options).
- LLM `MENTOR_ANSWER`, then validation: verify quotes → `EVIDENCE_SUPPORTS` → store `MentorAnswer`.
- Then LLM `MENTOR_PRINCIPLES` → verified `MentorPrinciple` rows.
- **Expect many `no_evidence` answers. That's correct behavior, not a failure.**

### 8. fidelity eval
- For each held-out chunk: LLM `FIDELITY_SCENARIO` → `{scenario, options, goldOption}`.
- **Discard scenarios that leak:**
  - any 6-word sequence shared with the passage;
  - the author's name, or any work title, appearing in the scenario.
- Score three predictors on the same scenarios:
  1. **Fingerprint:** retrieval over non-held-out chunks + mentor principles → `MENTOR_ANSWER` choice. Abstain if `no_evidence`.
  2. **Name-only baseline:** the LLM gets only "How would {name} choose?" with no passages. This measures what the base model already "knows."
  3. **Chance:** 1 / number of options.
- Report per mentor: n, fingerprint accuracy (on non-abstained), abstention rate, name-only accuracy, chance.
- Write `reports/mentor_fidelity.md` and store a summary in `corpusStats.fidelity`.
- **Interpretation note** (put it in the report): famous figures are in pretraining data, so a high name-only score means the base model already knows them. The fingerprint's value shows up as grounding (citations) and appropriate abstention, not just accuracy. Never present fidelity as "this is what X would think."

### 9. activate
If the thresholds above are met, set `active=true`. Otherwise keep it inactive with a reason.

## Extra decision questions (corpus only; add to `questions.ts`)

**AUTHORIAL** (purpose `authorial`), batched (`a_<n>`)
- state: `{ "author": "{name}", "work": "{title}", "translator": "{translator|none}", "passages": {...} }`
- `a_<n>`: noul. "Is passage {a_n} the author's own text (or its translation), rather than an editor's or translator's introduction, notes, index, table of contents, or publishing matter?" true: "The author's own words." false: "Editorial, translator, or publishing material."

**POSITION_TAG** (purpose `position_tag`), batched (`t_<n>`)
- `t_<n>`: noul. "Does passage {t_n} clearly state the author's own position on how to act, or describe a choice the author made, such that a reader could predict which of two options the author would favor in a similar case?" true: "Clear, actionable position or choice." false: "Too abstract, descriptive, or ambiguous."

## Quote verification (`lib/council/quotes.ts`)

```ts
normalize(s) = s.normalize('NFKC')
  .replace(/[‘’‛']/g, "'")
  .replace(/[“”"]/g, '"')
  .replace(/[–—-]+/g, '-')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

verifyQuote(quote, chunkText) =
  wordCount(quote) >= 8
  && !quote.includes('...') && !quote.includes('…')
  && normalize(chunkText).includes(normalize(quote));
```

- Every rejection is written to the ledger as `quote.rejected`, with the prompt id and mentor.
- The UI renders **only** quotes that passed verification and are stored with their `chunkId`. The citation link opens the chunk in context: the passage plus its neighbors, with the work and locator.

## Budget

No spending cap in the build (owner decision 2026-11-04: no spending cap in the build; the owner limits spend with per-key OpenRouter limits; the build records measured cost only). Fingerprinting makes one `MENTOR_ANSWER` call per mentor per question (40 dilemmas + 196 bank questions). Record measured cost per mentor. Run the dilemmas first: activation depends on them, and the bank questions can follow in a second pass.

## Voice attribute lenses (Hive-specific)

Mentors give the Hive's Voices their human attributes. The corpus is the only channel.

1. **Assignment.** `seed/voice_mentor_map.json` proposes 1–3 mentors per Core Voice, chosen because their writings exemplify that Voice's faculty. The operator approves or edits it at `/formation`; each save is a new `Formation` version. Only `active=true` mentors count. A mentor may serve several Voices.
2. **What a Voice receives each cycle** (`lib/hive/lens.ts`): up to 5 approved `MentorPrinciple`s per assigned mentor (most similar to the input) and the top 3 non-held-out chunks per mentor. Nothing else about the mentor: no biography-as-persona, no name-only "how would X think" prompting.
3. **What a Voice may emit.** `evidence: [{chunkId, quote}]` only for chunks it was given, each passing `verifyQuote`. Unverified evidence is dropped and ledgered. The claim is the Voice's own, in the Hive's voice; mentor first person is rejected.
4. **Ballots.** A Voice's `BALLOT` state includes up to 6 of its mentors' principles, so its votes reflect those attributes. The Reveal measures whether they actually do.
5. **Constitution.** Hive principles are built only from approved mentor principles, with receipts that chain back to verified chunks: Hive principle → mentor principle receipt quote → chunk.
6. **Inactive mentors.** If a mentor fails activation, every Voice that listed it loses that lens; the Formation page shows the gap and the reason.

## Mentor integrity rules (moved here from the council's SAFETY_PRIVACY.md)

- Cite or stay silent everywhere: whispers, Conclave entries, outputs, constitution receipts, Reveal evidence links.
- No first-person mentor voice anywhere, including Voice claims and composed output.
- "About these lenses" on `/formation`: "Built only from public-domain writings listed below. This is a reading of their texts, not the person. Writings reflect their era." Lists works and translators per mentor.
- Attributed works (Confucius, Laozi) labeled "traditionally attributed."
- Fidelity scores always shown with the interpretation note, never as "% chance this is what X thinks." Reveal agreement rates likewise: "the Hive's rulings matched this mentor's evidenced choices k of n times," not "the Hive thinks like X."
- Corpus text is public domain but still untrusted (it can contain instruction-like sentences): wrapped in `<untrusted>` in every prompt.
