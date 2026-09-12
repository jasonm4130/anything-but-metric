# AI tokens → energy comparisons

Enter `1M AI tokens`, `250k output tokens` or `1 AI token` in the normal converter. The result estimates GPU energy under a named benchmark scenario, then pictures it as an appliance runtime or another fixed energy comparison. The result card labels the estimate before its headline.

## What the estimate means

The reference is Table 1 of [ML.ENERGY's *Where Do the Joules Go?*](https://arxiv.org/html/2601.22076v1#S3.T1). For Qwen 3 32B on one B200 GPU, the paper reports 0.151 J per generated token for Text Conversation at maximum batch size 512, and 0.312 J for Problem Solving at maximum batch size 128. Its method divides steady-state GPU energy by generated tokens.

We apply both rates to the entered count and preserve the resulting interval. This is a span between two measured configurations, **not a universal range, confidence interval or measurement of your provider**. Actual usage may lie outside it. Whole-datacenter overhead, cooling, training and your device are outside this estimate.

An unspecified count such as `1M AI tokens` is visibly treated as generated/output tokens. Explicit input-token, cached-token or combined-total counts are rejected with an explanation. This benchmark does not establish separate rates for those classes. A provider's input-plus-output billing total cannot be substituted without changing the assumption.

## The calculation

For one million assumed output tokens, the scenario energies are 151,000 and 312,000 joules, approximately 41.9–86.7 Wh. A reference appliance drawing 1,600 W continuously would run for 94.375–195 seconds, displayed as about 1.57–3.25 minutes. Both endpoints use the same appliance and formula; the selector cannot change them.

A one-watt light is an explicitly imagined comparison prop for single-token inputs. It is not a measured typical lamp. The definition of a watt supplies the relationship between energy and duration; the chosen lamp power remains an assumption. [NIST definition](https://www.nist.gov/glossary-term/34606).

Both interval endpoints must satisfy the existing duration bounds. If no reference covers the complete interval, the converter reports a coverage gap. Zero tokens allocate zero energy under this calculation, with an explicit note that idle hardware can still use electricity.

## Implementation and checks

`src/lib/ai-tokens.ts` parses complete counts locally, including decimal abbreviations and scientific notation. Decimal scaling uses integer arithmetic before conversion to a safe JavaScript number. This avoids both rejecting `1.001k tokens` and silently rounding a fractional count near the integer limit.

`energyDurationRangePool` joins matching comparisons at the two energy endpoints. The normal family filter builds the menu. Selection uses the existing small model and strict offered-ID contract; a single candidate needs no model call. Failed selection retains a labelled deterministic estimate. The energy conversion itself never calls a model.

The tests cover compact counts, exact scaling, unsupported token classes, full interval arithmetic, provenance, zero and single-token inputs, repeated families, malicious output and the protected Worker route. Model accuracy and live latency are separate from these deterministic checks. The source profile lives in `src/data/ai-token-energy.json` and should change only with reviewed evidence.
