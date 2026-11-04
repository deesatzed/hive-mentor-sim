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
