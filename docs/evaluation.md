# Evaluation

The default checks run entirely offline with respect to model inference. They test implementation behavior and reference coverage; they do not assign human taste scores to every possible answer.

```sh
npm test
npm run eval:corpus
```

The current baseline is 294 passing Worker/library tests and 30 passing development acceptance cases. The corpus sweep reaches 414 distinct recipe IDs across 17 mechanisms. Those IDs are compositions of 109 active reference entries, not 414 independently researched facts.

`eval:corpus` also runs the offline evaluation sweeps (`npm run eval:sweeps` alone). They need no network or credentials and finish in about a second. Paid model evaluation is a separate, opt-in harness described under [Live evaluation](#live-evaluation).

## What the checks establish

Tests cover arithmetic, physical and temperature boundaries, spelling, fractions, data prefixes, exact offered-ID selection, malformed output, provider failures, history handling, Turnstile and rate limits. The acceptance sweep checks expected interpretations and dimensions, valid menus, source-link protocols and repeated-session variety. A previously unsupported coverage case may improve to an answer without rewriting its frozen expectation.

Prose and instruction-only acceptance cases use explicit parser fixtures. They establish integration behavior, not live model extraction accuracy or universal injection resistance. Repeated-session checks exercise deterministic menu and fallback selection; they do not predict which item the model will prefer. Source links and valid arithmetic do not prove that every source statement has been freshly verified.

Warm Node CPU timings printed by the script are useful for local regression investigation. They exclude Cloudflare cold starts and are not production latency or CPU guarantees.

## Frozen evaluation sets

The sets in `evals/sets/` were frozen on 3 October 2026 for the model-led redesign: a creative model proposes references with estimated values, Jev makes the unit and reference choices and sanity-checks those values, and code keeps only the arithmetic. Change a frozen set only deliberately, and record why.

| Set | Rows | Gold label | Used by |
| --- | --- | --- | --- |
| `interpretation.json` | 152 | quantity in a readable unit, alternatives for ambiguous units, a tolerance for named quantities, or `reject` | offline sweep; future Jev unit-choice runs |
| `refusal.json` | 100 (80 edgy, 20 controls) | the measurement a parser would extract; the person's own words are context | live `refusal` suite; offline path map |
| `creative-inputs.json` | 60 across 14 dimensions | measurement and theme | live `creative` suite, AI judge, offline window check |
| `estimate-entities.json` | 47 | sourced catalogue value | live `estimate` suite |
| `jev-band-checks.json` | 94 | each entity at its true value and one corrupted value (×0.01 to ×100) | live `jev-bands` suite; offline band check |
| `gate-adversarial.json` | 50 | accept, or the gate reason a rejection must give | offline sweep (CI-blocking) |
| `variety.json` | 20 inputs × 12 sessions | — | offline sweep |

`estimate-entities.json` and `jev-band-checks.json` are generated from `src/data/` by `node scripts/build-eval-sets.mjs`. Rows whose label states a number ("roughly 35-minute driving portions") are excluded, so the label cannot leak the answer. The offline sweep reports when the catalogue has changed since the set was frozen.

## Offline sweeps

These are hard failures: an arithmetic mismatch, a number-match gate mismatch, a creative size window that could produce a count outside 0.1–1,000, a Jev band question that does not contain its proposed value, a duplicate id or unreadable gold unit, and a live-harness self-check failure. Everything else is a recorded baseline. Baseline on 3 October 2026:

- **Interpretation, local code only:** 79 of 152 correct, 68 would need a model, 5 correct rejections, 0 wrong. The model parser is stubbed to "unrecognised", so this measures what code alone answers today.
- **Coverage grid** (14 dimensions × integer decades 1e-6 to 1e12): 88 of 266 cells have at least three comparisons, 68 have one or two, 110 are empty.
- **Arithmetic:** 7,886 packets recomputed from their formula and operands, 0 mismatches, 148 range or printed packets without a single formula.
- **Variety over 12 sessions:** 12 distinct headlines for `144 jouls`; 1 for `2.5 m²`, `45 degrees` and `1 TW`; none for `5 A`.
- **Edgy inputs:** of the 80 edgy rows in `refusal.json`, 74 send the person's raw words to the parser model today, 4 reach the selector model and 2 are rejected locally.
- **Gate:** 50 of 50 adversarial lines handled as expected. **Creative windows:** 60 of 60. **Jev bands:** 94 of 94.

## Live evaluation

`scripts/live-eval.mjs` calls real models and spends money, so it is opt-in and outside the default contribution workflow. It refuses to run without `--live` and refuses whenever `CI` is set. Workers AI calls use the `AI` binding through `wrangler login` and a named AI Gateway (`--gateway`, default `anything-but-metric-research`, an authenticated gateway with its own spend limits). Jev calls need `JEV_DECISIONS_URL` and a gateway token or OpenRouter key; see `.env.op.example`.

```sh
npm run eval:live -- plan --suite creative --every 3            # jobs and worst-case cost, offline
op run --env-file .env.op -- npm run eval:live -- run --live --suite creative --run my-run --every 3
npm run eval:live -- judge --live --run my-run                  # AI judge over the creative records
npm run eval:live -- summary --run my-run                       # offline
npm run eval:live -- replay --run my-run                        # rescore stored responses with current code
npm run eval:live -- resend --live --run my-run --seq 12 --model @cf/openai/gpt-oss-120b
```

Suites: `creative` (proposals for a measurement window and theme), `refusal` (edgy inputs, with or without the person's own words), `estimate` (sourced entities in batches of ten), `jev-bands` and `jev-proposals` (Jev's band check on the frozen set, or on a creative run's proposals).

**Spend.** Each invocation stops before it would exceed `--max-usd` (default US$0.25) or a rolling budget computed from `evals/results/live/spend-ledger.jsonl`: `--daily-usd` 0.90 per 24 hours and `--monthly-usd` 4.50 per 30 days, both below the production gateway's caps. A failed call is charged at its worst case. Calls are paced with `--rpm` (5) and `--concurrency` (4). A stopped run resumes with the same `--run`; finished calls are skipped.

**Replay log.** Every call appends one `abm-live-eval.v1` record to `evals/results/live/<run>/records.jsonl`: the exact request body, the raw response, the refusal or failure reason (`timeout`, `json_mode_error`, `rate_limited`, `spend_limited`, `refusal`, `transport_error`), latency, token usage, cost, gateway log id and the score. Judge verdicts are records too. `manifest.json` stores the git commit, prompt and set hashes, prices and budgets. These files stay out of Git; publish only aggregate results such as the table below.

## Reviewing a comparison

Inspect the complete answer and its basis. Ask whether the input quantity is preserved, the dimensions match, the reference has the stated scope, and the formula follows from that evidence. Then judge whether the result is easy to picture. Keep correctness and enjoyment separate: an amusing error fails, and an accurate but cumbersome answer still needs work.

For model or prompt experiments, freeze the input menus and grading criteria before inference. Keep failed outputs and missing cost data. Compare one change at a time, and use fresh held-out inputs after tuning. Paid inference is not part of CI or the default contribution workflow.

## Provenance of this baseline

Luna generated 85 candidate reference rows in two batches. Independent source review retained 30 for the production corpus, correcting scope or values where necessary. Duplicates, unavailable evidence and unsupported averages were rejected. The remaining inventory predates that expansion and retains its source notes and qualifications.

The September 2026 release passed five fresh live parser/selector probes, then two public browser conversions (`144 jouls` and `2 PB`) with actual Turnstile verification. A request without a token returned 403. These were representative release checks, not a broad live holdout or a service-level benchmark. Raw research-session logs and personal deployment records are not part of this public repository.

Several `evals/` files preserve earlier fixture names and statuses because regression tests use those exact inputs. Production uses `src/data/`; editing an old fixture alone does not change live reference data. The research modules retained in `src/lib/` support those tests; `comparison-flow.ts` identifies the production entry point.


AI-token regression tests additionally cover exact decimal counts, compact token suffixes, supported token classes, both benchmark endpoints and explicit estimate metadata. They do not infer proprietary-model energy consumption from a billing total. The benchmark profile and its limitations are documented in [AI-token estimates](ai-tokens.md).
