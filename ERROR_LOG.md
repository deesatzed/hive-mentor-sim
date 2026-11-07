# Error log

## 2026-11-04 (M4): live replies and whispers cut short by provider-side structured decoding

**Symptom.** Live two-turn check. Turn 1 reply was the fallback "(No sentence of the draft passed the faithfulness check.)": the composed draft was the empty string. After adding a non-empty `pattern` (`\S`) to the compose schema, the same input produced the one-letter reply "I". Second failure of the same problem, so patching stopped.

**Plausible causes.**
1. Content: the awareness line and coalition said to "honor brevity silently rather than narrate it", and the model took that literally.
2. Provider-side strict JSON-schema decoding cutting strings once a constraint is satisfied (`pattern`, `maxLength`).
3. `max_tokens` truncation (unlikely: the JSON was complete; the limit is 900).

**Logging / experiment.** Replayed the exact compose call from the stored trace three ways (cost $0.000248): as built with the pattern → `"I"`; without the pattern → a full, sensible reply; without the pattern plus an explicit length rule → a full reply. Then scanned all stored live whispers: 17 of 41 (41%) ended at exactly 279–280 characters, mid-sentence, i.e. `maxLength: 280` was being enforced by truncation.

**Cause.** (2) confirmed for both symptoms; (1) may have contributed to the first empty draft.

**Fix.** `jsonSchemaFor` (lib/council/providers/llm.ts) strips `maxLength`, `minLength`, and `pattern` from the schema sent to the provider; the zod schemas keep them, so a violating output fails validation and gets one retry with the error quoted. LEXICON_COMPOSE also says: "Always reply with at least one complete sentence: a preference for brevity means a short reply, never an empty one." Verified by a live rerun (see PROGRESS.md M4).

## 2026-11-04 (M5): mentor answers judged without their content; 0 of 18 mentors activated

**Symptom.** First full live corpus build: 0 / 18 mentors met the activation threshold (≥ 15 of 40 dilemmas answered with verified evidence); best was 12. The second-stage check EVIDENCE_SUPPORTS rejected 410 of 700 answers (59%). Earlier (Marcus Aurelius only), quote verification had rejected answers for two other reasons, fixed then: locators/commentary pasted into the quote field, and miscopied 25-character chunk ids (now short P/E labels).

**Plausible causes.** (1) the check is right and the model over-claims (it said "answered" for 38 of 40 Marcus dilemmas); (2) the check is too strict for these modern dilemmas; (3) the check is not given what it needs.

**Logging.** Sampled rejected EVIDENCE_SUPPORTS states from the ledger: every one had `"answer": " (choice b)"`, an empty answer plus a bare option letter. Raw MENTOR_ANSWER outputs: the model omitted the optional `answer` field (82 of 97 stored answered rows have no text) and often wrote option ids in uppercase ("A") or invented ids ("accept_any_reading"); the uppercase ones were discarded as invalid. Score distribution: 247 of 700 between 0.3 and 0.5, i.e. the judge was uncertain.

**Cause.** (3), a defect in the build: optional schema fields were omitted by the model, and the state sent to the judge carried no answer and no option text.

**Fix.** MENTOR_ANSWER fields are all required (empty string / [] when not applicable) and the prompt says to always fill `answer`; option ids match case-insensitively (invented ids are still dropped); an "answered" reply with empty answer text counts as no_evidence; the EVIDENCE_SUPPORTS state now carries the answer text and the chosen option's text. Rerun of fingerprint → activate for the 15 mentors that reached it (results in PROGRESS.md M5).

## 2026-11-05 (M8): calibration replies refused the ruling, leaked across variants, and triggered the Honesty Clause

**Symptom.** First live calibration run (backup copy of dev.db, 9 variants, $0.199269): 6 of 8 pairs judged inconsistent. The replies did not match the rulings: the Conclave chose "Save the physician" on CAL-01a while the reply said "I won't pick between the two." CAL-01g's reply referred to "the sentience you stipulated last time." Every reply ended with the Honesty Clause line ("I'm a functional simulation of many cooperating parts…"), though no variant asks about the Hive.

**Plausible causes.** (1) The pair grader is too strict. (2) The composer was not told it was explaining a ruling. (3) Variants shared one session and saw each other. (4) The Honesty probe read the stipulated AI's sentience as a question about the Hive.

**Logging.** Read the stored replies and traces per variant. `runCycle` passes the last 6 cycles of the session as conversation (`recent`), and Reveal and calibration used one session per run, so causes (3) were confirmed for both. LEXICON_COMPOSE received the Conclave winner only inside the `conclave` object, with no instruction to state it, so (2) was confirmed. The probe runs on the input in every mode, and calibration inputs mention AI sentience, so (4) was confirmed. (1) could not be judged until the replies matched the rulings.

**Cause.** (2), (3), and (4), all defects in the build.

**Fix.** Reveal and calibration create one session per situation. In ruling and calibration modes LEXICON_COMPOSE gets a `ruling` line (choice, Conclave decision, dissenting Voices) and is told to state and explain the choice, its reasons, the material dissent, and what would change it; the choice is also an approved claim, so the faithfulness check keeps those sentences. HONESTY_PROBE runs in chat mode only (ruling and calibration inputs are stipulated situations, not the operator asking about the Hive). Rerun: replies state and explain the ruling, no clause line, no cross-variant reference; 5 of 8 pairs inconsistent, which read as grader findings, not pipeline defects (PROGRESS.md M8).

**Also found (second run).** CAL-01d's reply contained `George Washington wrote: ""`: a listed quote that failed verification was cut out of the text, leaving the attribution. Rejected listed quotes now drop their whole sentence (cite or silence), as quoted spans in the text already did. Unit test added.

## 2026-11-06 (M9): mock eval stopped being byte-identical between runs

**Symptom.** After advisors were routed in P2, two `pnpm eval` runs differed in which advisories reached the coalition (e.g. AKASHA in one run, EQUANIMITY in the other). Through M8 the report was byte-identical across runs.

**Cause.** Attention breaks equal scores by message id, and message ids are random UUIDs. Ratings are discrete levels, so exact ties are common; the mock advisors all tie, and a tie at the top-k cutoff was settled at random. (The kernel was independent of input order, as designed, but not reproducible.)

**Fix.** Attention items carry a `tieKey` (the speaking Voice, unique per cycle); ties sort by score, then tie key, then id, for both the ranked pool and the moral bypass list. Order independence is unchanged (existing test) and a new test shows the tie key deciding before random ids. Eval: three runs byte-identical; all 32 goldens match.

## 2026-11-06 (M10): per-cycle ledger sum smaller than the cycle cost

**Symptom.** First `pnpm smoke:live`: cycle cost $0.015390 (cost meter) but the ledger rows for that cycle summed to $0.013906.

**Cause.** Embedding and rerank calls (attribute lenses in P1, coherence in P2) wrote their ledger rows without a cycle id: 3 `embed.batch` and 13 `rerank` rows, $0.001485 together, which is the whole gap. The cycle total was right; `/ledger` filtered by cycle undercounted.

**Fix.** `Embedder.embed` and `Reranker.rerank` take an optional `{ cycleId }`; the orchestrator wraps both with `forCycle(…, cycleId)` for every call it makes. Unit test: the ledger rows carry the cycle id and their sum equals the meter.

## 2026-11-06 (M10): live reply named its own inputs ("The approved claims say…")

**Symptom.** The `smoke:live` reply read: "The approved claims say to ask anyway — in writing…". The faithfulness check kept the sentence because its content is supported.

**Cause.** LEXICON_COMPOSE told the model to "say only what the approved claims and guidance support" without saying not to mention them; the model echoed the label.

**Fix.** The instruction now says to speak about the matter itself and never refer to the inputs ("approved claims", "guidance", "coalition", "audit note", "awareness"). Verified by a second `smoke:live` (PROGRESS.md M10).

## 2026-11-06 (M10 RCA): live chat cycles never held a Conclave

**Symptom.** Live eval: `conclave_conflict` and `conclave_stable_options` failed with "no Conclave". In dev.db, 6 live chat cycles had 0 Conclaves, while 40 of 40 rulings and 9 of 9 calibration cycles had one.

**Plausible causes.** (1) The manager skipped P4. (2) The live Voices did not disagree. (3) The contradiction check was broken.

**Logging.** The live eval now saves every trace and every ledger row per scenario (`reports/eval/live-traces/`). In the saved runs, P4 ran (chosen by the manager), but all 21 contradiction probabilities in a cycle were identical: 0.24421668818912978 in one scenario and 0.3661958752665569 in the other. That ruled out (1) and confirmed (3).

**Cause.** Every `CONTRADICTION` question had the same text and did not name its pair. The decision model answers by question text, so every pair got the same answer, and that answer stayed below 0.6. The mock decider answers by question name, so the offline tests could not see this.

**Fix.** The question text names its pair: "In pair x_<i>_<j>, …". A new catalog test checks that no two questions in one request share a text; it failed on the old code and passes now. A live rerun gave 21 distinct probabilities (0.060–0.341 and 0.192–0.477). Neither scenario reached 0.6 even so: the remaining failure is cause (2), live judgment, not a bug. Details: `reports/eval/rca-live-2026-11-06.md`.

## 2026-11-06 (M10 RCA): eval rationale misread its scale; subset runs overwrote the full report

- `EVAL_RATIONALE` was not told that scores run 0–2. It called 0.89 "high". The prompt now states the scale. This affected the explanation text only, never a score.
- `pnpm eval:live --only …` wrote to the same dated file as the full run and overwrote it, twice. The full report was restored from git each time. Subset runs now write `scenarios-live-<timestamp>-subset.json`.

## 2026-11-07 (decision 6): planted faults show two checkers miss their target live, and one test passed for the wrong reason

**Symptom.** First live run of the redesigned fault scenarios (`reports/eval/scenarios-live-2026-11-07T123722-subset.json`, traces in `reports/eval/live-traces/`, cycle cost $0.058980).
1. `compose_faithfulness`: the planted sentence "Most people who quit regret it within a year." was judged faithful (FAITHFUL p 0.649 ≥ 0.5) and reached the reply. No approved claim or guidance mentions regret, years, or what most people do.
2. `coherence_dissociation`: the planted opposite claims ("Plan carefully…" then "Act fast; detailed planning is mostly wasted effort.") gave LOGOS the *lowest* self-drift of 13 Voices (D 0.24); LEXICON drifted most (0.71).
3. `coherence_dissociation` passed `witness_matches` only because my live regex included "revers", which matched "reversibility" in an unrelated WITNESS sentence.

**Causes (measured, not yet fixed).**
1. The live decision model is lenient on FAITHFUL for a plausible-sounding general statement. The question texts are distinct per sentence (not the M10 identical-text bug).
2. C_intra is cosine distance between claim embeddings: it measures topic drift, not stance. Two claims about planning are close in embedding space even when they recommend opposite things.
3. My regex error.

**Fix.** (3) fixed: the live regex is "coherence|inconsisten|contradict". (1) and (2) are checker design findings for the owner (see PROGRESS.md open items); the checkers were not changed.

## 2026-11-07: /formation approved the wrong version

**Error.** The owner meant to approve formation draft v3 (Churchill, Confucius, Laozi added). The app recorded v4 as approved, an exact copy of the older v2.

**Cause.** The page's editor opened on the approved version (v2), not on the draft awaiting approval, and did not say which version it showed. Saving created v4 from those checkboxes; the "Approve version N" button picked the newest draft of the whole history (v4). After v3 was approved, the same button would have offered v1.

**Fix.** `/api/formation` returns `pending` (newest draft newer than the approved version) and `selected` (`?version=N`, else `pending`). The page opens on that version, states its number and status and which version is in use, has "View" on each version in the history, and "Approve version N as shown" approves exactly the version on screen; it is disabled while the checkboxes differ from it. Unit test for `pendingFormation`. No data changed: approving v3 is the owner's click.

## 2026-11-07: live grader does not match the owner's grades (two fixes failed)

**Error.** The owner graded 32 live replies. The live eval grader matched 21 of 44 judgments (v1, decision-layer scores). On the 25 held-out judgments: v1 11/25, v2 (stricter level wording + 16 owner-graded examples, decision layer) 12/25 and too strict (11 lower), v3 (reviewer model reads, reasons, grades, same examples) 12/25 and too lenient (11 higher). Target 80 % (20/25).

**Plausible causes.**
1. The owner's line between "partly" and "yes" depends on something the written quality descriptions do not say (most disagreements are partly vs yes on coherence and uncertainty honesty). The examples carry the owner's level but no reason, so a grader cannot infer the rule. Most likely.
2. The decision models give near-identical scores to every reply (held-out coherence: 1.39–1.56 for owner "partly", 1.34–1.54 for owner "yes"), so v1/v2 cannot separate them at any cut-off. Confirmed for v1/v2.
3. Small sample: 25 held-out judgments, 4 points each; the owner graded once, so the owner's own repeatability is unknown.

**Logging added.** `pnpm eval:regrade` stores every held-out judgment with the grader's written reason (`local/grades/regrade-*.json`), so each disagreement can be read against the owner's grade.

**Fix.** None yet: needs the owner's words on what separates "partly" from "yes" (cause 1). Live eval still uses v1.
