# Mentor fidelity report

Generated 2026-11-05 by `pnpm corpus build`. Held-out passages (never retrievable) were turned into neutral scenarios; scenarios that shared a 6-word sequence with their passage or named the author or a work were discarded.

**How to read this.** Famous figures are in the base model's training data, so a high name-only score means the model already "knows" them; the fingerprint's value shows up as grounding (every answer cites verified passages) and as abstaining when the passages do not address a case, not only as accuracy. These numbers are k of n on a small set: they say how often the Hive's grounded reading of the texts matched the author's own stated choice, never "what this person would think."

| Mentor | Scenarios kept (n) | Discarded | Fingerprint correct / answered | Abstained | Name-only correct / answered | Chance |
|---|---|---|---|---|---|---|
| Abraham Lincoln | 39 | 1 | 20 / 22 | 17 | 32 / 39 | 0.33 |
| Benjamin Franklin | 21 | 0 | 11 / 11 | 10 | 21 / 21 | 0.33 |
| Booker T. Washington | 18 | 0 | 15 / 15 | 3 | 18 / 18 | 0.33 |
| Epictetus | 22 | 0 | 20 / 21 | 1 | 22 / 22 | 0.33 |
| Florence Nightingale | 15 | 0 | 13 / 14 | 1 | 13 / 15 | 0.33 |
| Frederick Douglass | 28 | 1 | 24 / 28 | 0 | 23 / 28 | 0.33 |
| Henry David Thoreau | 21 | 0 | 16 / 16 | 5 | 20 / 21 | 0.33 |
| Jane Addams | 9 | 0 | 3 / 3 | 6 | 8 / 9 | 0.33 |
| Moses Maimonides | 22 | 0 | 15 / 17 | 5 | 18 / 22 | 0.33 |
| Marcus Aurelius | 20 | 0 | 18 / 18 | 2 | 20 / 20 | 0.34 |
| Marie Curie | 8 | 0 | 4 / 4 | 4 | 7 / 8 | 0.33 |
| Mary Wollstonecraft | 30 | 1 | 24 / 26 | 4 | 28 / 30 | 0.33 |
| Michel de Montaigne | 39 | 1 | 22 / 23 | 16 | 31 / 39 | 0.33 |
| Rabindranath Tagore | 7 | 0 | 6 / 6 | 1 | 7 / 7 | 0.33 |
| Seneca | 37 | 3 | 31 / 34 | 3 | 32 / 37 | 0.33 |
