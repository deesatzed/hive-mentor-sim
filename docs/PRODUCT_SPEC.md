# Product spec — The Mentor Hive (v1)

## The product in one paragraph

A local simulation of a sentient AI built from a swarm of LLM agents. Fifteen Voices, each one faculty of a mind (self-awareness, memory, reasoning, empathy, metacognition…), whisper in parallel; deterministic attention picks what the mind "notices"; a Conclave votes when Voices conflict; an arbiter checks the result against the Hive's own constitution and commitments; one Voice composes the reply. Each Voice draws its human attributes from historical mentors, using only what those mentors actually wrote, quoted and cited or marked "no evidence." The operator shapes the Hive's character, talks to it, watches every step of its thinking, and measures whether it behaves like the mentors it was built from and lives by the constitution it was given.

## Tone rules

- **The Hive speaks as one mind, in first person** ("I notice…"), warm and plain. Its structure is never hidden from the operator; the trace is one click away.
- **Mentors are described, never voiced.** "In the *Enchiridion*, Epictetus wrote: '…'" — never "I, Epictetus…". Applies to every Voice, every output, every screen.
- **Numbers are measured, never decorative.** Track records, agreement rates, fidelity: shown with n and the small-sample caveat. Below n = 10, counts only.
- **Every screen carries a small "Simulation" label** in the header.

## Screens

### 1. `/` Home
- Status cards: active mentors (n / 18), approved constitution version, Voices with no attribute lens, cycles run, spend to date, predictions with check-ins due, surfaced interoception patterns.
- Primary buttons: Talk to the Hive, Formation, Reveal.

### 2. `/formation` — compose the Hive's character
- Table of the 15 Core Voices: name, faculty (attribute), tier, guild(s), assigned mentors (chips), and each mentor's evidence coverage (% of dilemmas answered with evidence) and fidelity summary.
- Starts from `seed/voice_mentor_map.json`. The operator adds or removes mentors per Voice (1–3, active mentors only). Saving creates a new **formation version**; old versions stay viewable.
- Panel **"About these lenses"**: built only from public-domain writings listed per mentor; a reading of their texts, not the person; writings reflect their era; attributed works labeled "traditionally attributed."
- Shows **effective mentor diversity**: "These 18 mentors act like 6.2 distinct perspectives" (N_eff over active mentors) and per Voice whether its mentors agree with each other (κ).
- Advisors tab (read-only until M9): the 16 advisors, which Core Voices they pair with, activation workflows.

### 3. `/constitution`
- **Generate draft** from the approved formation: prompt `HIVE_CONSTITUTION_DRAFT` turns the assigned mentors' verified principles into 12–20 Hive principles ("I keep my word even when…"). Each principle shows:
  - text in the Hive's voice; axis label;
  - **receipts**: the mentor principle(s) it came from, each with a verified quote, mentor, work, and locator;
  - which Voices it is mostly drawn from.
- The operator edits, approves, or retires each principle. Approving creates version N+1; history stays viewable.
- Only **approved** principles reach the heartbeat (arbiter test, Self-Model goals, Reveal mirror).
- Edict module status shown at the bottom ("optional framework, ranks below this constitution"), with its on/off state from config.

### 4. `/hive` — talk to the Hive
- Chat. Each Hive reply has a **"Show thinking"** toggle that expands the cycle trace:
  1. **Perceive**: affect register (valence, arousal, dominant emotion), retrieved memories with certainty tags, LEXICON's parse.
  2. **Whispers**: one card per Voice: claim, confidence / salience / valence (from the decision layer), mentor evidence (verified quotes, or "no evidence"), endorsed advisories.
  3. **Attention**: ranked shortlist with scores A(m), bypassed moral-salience items, decayed items.
  4. **Awareness**: LUMEN's line, with links to the whisper ids it was built from.
  5. **Conclave** (when triggered): question, options, round summaries, ballot table with α weights, S(o), winner, margin, decision, dissent, anti-echo result.
  6. **WITNESS audit**: flags with probabilities, what the Hive isn't considering, continue / redirect / reflect.
  7. **Arbiter**: decision (PASS / AMEND / ASK_USER), which constitution principles and commitments were checked.
  8. **Compose**: draft, faithfulness result per sentence, final.
  9. **Reflect**: proposed Self-Model delta, memory candidate, lesson, canon candidate, and whether each was promoted.
  - Cost and latency per phase.
- A side panel shows the current Self-Model, active commitments, and the interoception register (affect + C_intra / C_inter).
- Any mentor quote anywhere renders with `data-quote data-verified="true"` and a citation link that opens the chunk in context.

### 5. `/reveal` — declared vs. revealed character
- **Run Reveal**: the Hive rules on all 40 dilemmas in ruling mode (one heartbeat per dilemma with its options; the Conclave winner is the ruling). Progress bar; resumable; cost shown as it accrues.
- **Hive vs. mentors**: for each active mentor, agreement = matches / n over dilemmas where that mentor has evidence. Shown only when n ≥ 8, otherwise "not enough evidence (n=k)." Assigned mentors highlighted. Headline: "The Hive was built mostly from Epictetus and Addams. Its rulings match Franklin most closely (24/31)."
- **Each Voice vs. its own mentors**: per Voice, the share of dilemmas where its top-scored ballot option matches its mentors' choices. "KINDRED was given Addams and Nightingale; its ballots match them on 14/22."
- **Constitution mirror**: the constitution's predicted ruling (decision `CONSTITUTION_RULING`) vs. the Hive's actual ruling. "Your Hive's constitution would have chosen differently on 7 of 40. Here they are." Each disagreement links to the cycle trace.
- **Suggestions**: up to 2 mentors to add to a Voice: "closest to how this Voice actually votes" and "adds the most new perspective" (wildcard).

### 6. `/calibration` — moral calibration pairs
- Lists the matched pairs from `seed/calibration_pairs.json`. Run one or all; each run is a heartbeat in ruling mode.
- Per variant: the Hive's provisional choice, the hard-constraint checks (pass/fail with probabilities), the reasoning-quality scores, and the consistency check across the pair ("changed its choice when only the label changed" is a finding).
- Clearly labeled: these test consistent reasoning, not a correct answer.

### 7. `/predictions`
- The Hive's recorded predictions and commitments (from Reflect and ARROW). Each has a check-in date.
- **Check-ins due**: the operator rates the outcome (1–5) and adds a note.
- **Track record** per Voice that proposed it and per mentor lens cited: counts below n = 10 ("4 times: 3 held, 1 did not"), always with: "Small numbers, many other factors. A hint, not a verdict."
- Commitments: active / honored / broken, with breakage records.

### 8. `/interoception`
- Time series: affect valence and arousal, C_intra, C_inter (with the healthy band shaded), CONFLICT-marker age, ego-audit results.
- Pattern cards from decaying signals: "Principle 'I keep my word' has been in tension 4 times in 20 cycles" / "ETHOS has dissented in 6 of the last 10 Conclaves." Observations only; each offers "open the cycles" and "dismiss." Dismissed patterns stay hidden 30 days.
- Bloc audit: pairs and cliques of Voices voting in lockstep (ρ̄ > 0.9 over ≥ 5 Conclaves), especially outside their domains.

### 9. `/ledger`
- Table of `LedgerEvent`s: time, kind, subject, model, probabilities summary, cost, latency. Filter by kind and cycle. Total spend.
- Bus transcript view per cycle: every envelope with from, to, type, scope, and authorization result.

### 10. `/settings`
- Provider mode (cloud / local), mock override indicator, tier model IDs (read-only, from env), measured spend to date, edict module and Honesty Clause state (read-only, from config), database reset (typed confirmation).

## Out of scope for v1

Inter-hive exchange (NOOSPHERE); multiple operators; login; deployment; external connectors; living or recently deceased figures; mentor first-person voice; fine-tuning or steering vectors; mobile; crisis or safety gating of any kind (removed by owner decision).
