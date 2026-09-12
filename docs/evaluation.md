# Evaluation

The default checks run entirely offline with respect to model inference. They test implementation behavior and reference coverage; they do not assign human taste scores to every possible answer.

```sh
npm test
npm run eval:corpus
```

The current baseline is 238 passing Worker/library tests and 30 passing development acceptance cases. The corpus sweep reaches 407 distinct recipe IDs across 17 mechanisms. Those IDs are compositions of 108 active reference entries, not 407 independently researched facts.

## What the checks establish

Tests cover arithmetic, physical and temperature boundaries, spelling, fractions, data prefixes, exact offered-ID selection, malformed output, provider failures, history handling, Turnstile and rate limits. The acceptance sweep checks expected interpretations and dimensions, valid menus, source-link protocols and repeated-session variety. A previously unsupported coverage case may improve to an answer without rewriting its frozen expectation.

Prose and instruction-only acceptance cases use explicit parser fixtures. They establish integration behavior, not live model extraction accuracy or universal injection resistance. Repeated-session checks exercise deterministic menu and fallback selection; they do not predict which item the model will prefer. Source links and valid arithmetic do not prove that every source statement has been freshly verified.

Warm Node CPU timings printed by the script are useful for local regression investigation. They exclude Cloudflare cold starts and are not production latency or CPU guarantees.

## Reviewing a comparison

Inspect the complete answer and its basis. Ask whether the input quantity is preserved, the dimensions match, the reference has the stated scope, and the formula follows from that evidence. Then judge whether the result is easy to picture. Keep correctness and enjoyment separate: an amusing error fails, and an accurate but cumbersome answer still needs work.

For model or prompt experiments, freeze the input menus and grading criteria before inference. Keep failed outputs and missing cost data. Compare one change at a time, and use fresh held-out inputs after tuning. Paid inference is not part of CI or the default contribution workflow.

## Provenance of this baseline

Luna generated 85 candidate reference rows in two batches. Independent source review retained 30 for the production corpus, correcting scope or values where necessary. Duplicates, unavailable evidence and unsupported averages were rejected. The remaining inventory predates that expansion and retains its source notes and qualifications.

The September 2026 release passed five fresh live parser/selector probes, then two public browser conversions (`144 jouls` and `2 PB`) with actual Turnstile verification. A request without a token returned 403. These were representative release checks, not a broad live holdout or a service-level benchmark. Raw research-session logs and personal deployment records are not part of this public repository.

Several `evals/` files preserve earlier fixture names and statuses because regression tests use those exact inputs. Production uses `src/data/`; editing an old fixture alone does not change live reference data. The research modules retained in `src/lib/` support those tests; `comparison-flow.ts` identifies the production entry point.
