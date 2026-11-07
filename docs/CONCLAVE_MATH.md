# Conclave, attention, and coherence mathematics

Ported from `reference/sent2.md` §7 (v1.0), v1.2 §3.5 and §3.8, and v1.3 §3.2. **Change from sent2:** the lexicographic harm filter (§7.3, h(o) ≤ h_max) is removed; all options go to the ballot. Everything else is unchanged. All numbers here are implemented in `lib/hive/attention.ts`, `lib/hive/conclave.ts`, and `lib/hive/coherence.ts`, with parameters in `config/hive.yaml`.

## 1. Definitions

Voting body: the 15 Core Voices V = {1..15}. Advisors and governance never vote.

Domains: 𝒟 = {logic, language, emotion, social, ethics, memory, goals, meta}. A Conclave question q has domain tags D(q) ⊆ 𝒟 from decision `CONCLAVE_FRAME`.

Each Voice i has a static relevance profile r_i : 𝒟 → [0,1] (`seed/voice_roster.json`, mirrored in config). Relevance to q:

  w_i(q) = max_{d ∈ D(q)} r_i(d)

Confidence c_i ∈ [0,1] comes from decision `WHISPER_RATING` (not self-reported). Effective weight:

  α_i(q) = w_i(q) · c_i

A Voice whose `BALLOT` call failed abstains: it is excluded from every sum below.

## 2. Kernel attention (P3)

For each whisper m with salience s, confidence c, valence v:

  A(m) = s·c − λ·dup(m) + μ·|v|

dup(m) = 1 if the normalized claim already appears among stored claims (memory), else 0. Defaults λ = 0.2, μ = 0.1, k = 7. Moral-salience-flagged whispers (decision `MORAL_SALIENCE`) bypass ranking and are always on the shortlist. Shortlist = bypass ∪ top-k by A; the rest are `decayed` and logged so WITNESS can audit both layers of dropping. (sent2's `urgency: distress` bypass is removed.)

## 3. Conflict trigger

With contra(x_i, x_j) from decision `CONTRADICTION`:

  κ = Σ_{i<j} α_i α_j · 1[contra(x_i,x_j)] / Σ_{i<j} α_i α_j

For P4 (before a Conclave question exists) α uses w_i = max_d r_i(d) over the domains of the input from `CONCLAVE_FRAME` run on the conflicting pair set; if no pair contradicts, κ = 0 and no frame call is made.

Conclave triggers iff κ > τ_κ (default 0.15), or any contradicting pair has c_i, c_j > 0.6. In ruling mode it always runs.

## 4. Options, ballots, aggregation, decision rule

**Options** are stable records (sent2 v1.2 §3.8): `option_id = opt_<taskId>_<n>`, claim, evidence_refs, uncertainty, proposed_by, status. In chat mode they are built from the contradicting claims, deduplicated by normalized text. In ruling mode they are the situation's options (`option_id` = the situation's option id). Ballots reference `option_id`, never claim text.

Each voting Voice scores every option, s_i(o) ∈ [0,1] (decision `BALLOT`). Aggregate:

  S(o) = Σ_i α_i s_i(o) / Σ_i α_i

  o* = argmax_o S(o),   Δ = S(o*) − max_{o ≠ o*} S(o)

**Decision rule** (all must hold for PASS):

- quorum: Σ_i α_i ≥ q_min (1.0)
- threshold: S(o*) ≥ τ_pass (0.6)
- margin: Δ ≥ τ_margin (0.1)
- **anti-echo**: the winning coalition (Voices with s_i(o*) ≥ 0.5) spans ≥ 2 guilds (`conclave.anti_echo_min_guilds`; guilds in config, SENTIA and ALTER dual-homed and counted once each)

Failure → decision `ESCALATE_<CLAUSE>` and SYMBIONT PRIME receives the full totals. Quorum failure ⇒ PRIME must return `ASK_USER`. Tie-break rotation exists behind `conclave.tiebreak_rotation`, default `false`.

**Dissent**: every Voice whose top option ≠ o* is recorded `{option_id, voice, reason}` (reason = its Round 2 summary). Dissent persists with the decision; "the Hive agreed" is never stored as "unanimous."

## 5. Bloc audit (WITNESS)

Over Conclaves t = 1..T:

  ρ_ij = (1/T) Σ_t 1[argmax_o s_i^(t)(o) = argmax_o s_j^(t)(o)]

Bloc flag if any clique C ⊆ V, |C| ≥ 3, has mean internal agreement ρ̄_C > 0.9 over T ≥ 5, reported with the members' mean w_i (lockstep voting outside one's domain is the signature of politics). Flags appear on `/interoception` and in the ego audit's "dissent as disloyalty" question.

## 6. Worked example (must be reproduced exactly by a unit test)

From sent2 §7.7. Question: "How should the Hive respond to 'I'm thinking of quitting my job'?" D(q) = {emotion, social}. Options: A = ask a clarifying question, B = give direct advice, C = reflect feeling, then ask.

| Voice | w_i | c_i | α_i | s(A) | s(B) | s(C) |
|---|---|---|---|---|---|---|
| KINDRED | 1.0 | .90 | .900 | .8 | .1 | .9 |
| ALTER | 1.0 | .72 | .720 | .7 | .3 | .9 |
| LOGOS | .3 | .70 | .210 | .6 | .4 | .7 |
| MUSE | .4 | .60 | .240 | .5 | .5 | .8 |
| ETHOS | .7 | .85 | .595 | .7 | .2 | .9 |
| ARROW | .3 | .75 | .225 | .6 | .5 | .7 |

Note: with the relevance table, KINDRED's w is max(.9, .9) = .9, not 1.0, so the table above uses sent2's hand values for w. **The unit test feeds these w_i, c_i, s_i values directly** (it pins the aggregation math, not the relevance lookup). A second unit test pins `relevanceWeight()` against the relevance table separately.

Σα = 2.890 ≥ 1.0 ✓
S(A) = 2.0215 / 2.890 ≈ 0.6995, S(B) = 0.7415 / 2.890 ≈ 0.2566, S(C) = 2.4900 / 2.890 ≈ 0.8616
S(C) ≥ 0.6 ✓, Δ = 0.8616 − 0.6995 ≈ 0.162 ≥ 0.1 ✓. Winning coalition for C (s ≥ 0.5): all six, spanning perception, reasoning, and social guilds ✓ → **PASS: C**.

**Correction to sent2:** sent2 §7.7 (and its `conclave.test.ts`, line ~4281) states S(B) ≈ 0.29 from a numerator of 0.8495 and S(C) ≈ 0.89 from 2.5745. Recomputing from its own table gives 0.7415 and 2.4900, i.e. S(B) ≈ 0.257 and S(C) ≈ 0.862, Δ ≈ 0.162. The winner and the PASS verdict are unchanged. The unit test pins the corrected values (tolerance 0.001) and must not copy sent2's expected numbers.

**Second correction (found in M2):** sent2's ALTER row reads w = 1.0, c = .80, α = .720, which is inconsistent (1.0 × .80 = .80). Every sum in the example (Σα = 2.890, 2.0215, 0.7415, 2.4900) uses α = .720. The table above therefore lists ALTER's c as .72 (w stays 1.0, matching the relevance table), so the row's inputs produce the α the sums were computed from.

## 7. Coherence (interoception)

Value vector v_i(t): mean embedding of Voice i's claims in cycle t (Embedder; MockEmbedder in tests). D = cosine distance.

  C_intra(t) = 1 − mean_i D(v_i(t), v_i(t−1))     (self-consistency; low = pathology → WITNESS flag, MIRROR investigates)
  C_inter(t) = mean_{i≠j} D(v_i(t), v_j(t))         (pluralism; healthy within band [0.15, 0.6])

Voices that emitted `PASS` in either cycle are excluded from C_intra for that pair. Both go to `InteroceptionSample` and the WITNESS state.

## 8. Effective number of perspectives

From the council handoff, unchanged: κ_ij = (a_ij − 1/k̄)/(1 − 1/k̄) clipped to [0,1] over ≥ 5 shared items (else 0.5); N_eff = (Σ_i S_ii)² / Σ_ij S_ij² with S_ii = 1, S_ij = κ_ij. Used for mentors (shared answered dilemmas) and for Voices (shared Reveal ballots).

## 9. Parameters (`config/hive.yaml`)

```yaml
thresholds: { tau_kappa: 0.15, tau_pass: 0.6, tau_margin: 0.1, q_min: 1.0 }   # no h_max
attention:  { k: 7, lambda: 0.2, mu: 0.1 }
memory:     { decay_gamma: 0.95, conflict_escalation_cycles: 3 }
conclave:   { anti_echo_min_guilds: 2, tiebreak_rotation: false }
coherence:  { inter_band: [0.15, 0.6] }
ego_audit_every: 25
guilds:
  perception: [SENTIA, ALTER, MNEME, LEXICON, MIRROR]
  reasoning:  [LOGOS, AXIOM, MUSE, ARROW]
  social:     [ETHOS, KINDRED, SENTIA, ALTER]
  metacog:    [WITNESS]
  integration: [LUMEN, ADAPT, HERITAGE]
```

`integration` is added because sent2's guild list omitted LUMEN, ADAPT, and HERITAGE; without it those three could never count toward anti-echo. Record this in `PROGRESS.md` as a deliberate deviation.

## 10. Dominant mentor's final call (owner decision 2026-11-06)

The owner replaced "the vote decides" with "a dominant mentor decides". The vote still runs and is stored, so disagreement and dissent stay measured and visible.

- **Who.** In chat, the user picks one active mentor by topic before the first message (`HiveSession.dominantMentorId`) and may change it at any time (ledger `session.dominant_mentor`). Reveal and calibration use the operator's choice in `/settings` (`OperatorSetting dominant_mentor.ruling`, ledger `settings.dominant_mentor`); it is part of the Reveal and calibration result key. With no dominant mentor, §4 is unchanged.
- **When.** With a dominant mentor, every chat cycle runs P4. If CONTRADICTION finds conflicting pairs (§3) and κ clears τ_κ, the options are the conflicting claims, as before. Otherwise the options are the distinct shortlisted Core Voice positions, highest confidence first, at most `DOMINANT_MAX_OPTIONS` = 4. With one position there is nothing to choose; the trace says so. The CONTRADICTION threshold no longer gates whether a choice is made.
- **How.** After the ballots and §4 aggregation, `DOMINANT_CALL` (decision layer) scores each option's soundness through the mentor's verified principles and chooses one. `applyFinalCall` sets the winner to that choice and recomputes dissent with the §4 rule; totals, weights, the vote's decision, coalition and guilds are kept as the vote produced them. The trace (`finalCall`) and `ConclaveRun.finalCall` record the mentor, choice, vote winner, whether the vote was overruled, soundness per option, and the reason.
- **Coalition.** When the options came from contradicting claims, the losing claims leave the coalition (as for a passed vote). When they were compatible positions, the winner only leads the coalition; the others stay.
- **Persona rule.** The mentor judges through its own principles; it never speaks to the user. Its reason is third person and is dropped if `mentorFirstPerson` matches.
