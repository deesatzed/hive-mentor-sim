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
