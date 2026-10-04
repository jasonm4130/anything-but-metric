<div align="center">

<img src="public/banana-ruler.svg" width="180" alt="A banana pretending to be a ruler">

# Anything But Metric

**Put a number in the machine. Get a much less sensible way to picture it.**

[Try anythingbutmetric.wtf](https://anythingbutmetric.wtf) · [How it works](docs/architecture.md) · [Contribute](CONTRIBUTING.md)

[![Checks](https://github.com/jasonm4130/anything-but-metric/actions/workflows/check.yml/badge.svg)](https://github.com/jasonm4130/anything-but-metric/actions/workflows/check.yml)

</div>

Enter a measurement, press **Convert**, and get one playful comparison. Typos welcome, and so are money (`$50`), counts and food portions (`3 slices of pizza`), odd units (`2 fortnights`) and things with no number at all (`the height of Everest`). No chat history, follow-up interrogation or compulsory punchline.

| You enter | One possible answer |
| --- | --- |
| `144 jouls` | About 83 iPhone 17s lifted onto one-metre shelves. |
| `2 PB` | Print it double-sided: a paper stack about 8.3 Earths tall. |

These examples were checked on the live site before the model-led flow. Results vary; expand **Show the questionable maths** to see the estimate, the arithmetic and any sources.

## AI tokens count too

Try **`1M AI tokens`**, **`250k output tokens`** or even **`1 AI token`** in the same input. The converter estimates an energy interval and turns it into a playful comparison. The result clearly labels the benchmark and treats an unspecified count as output tokens; it does not claim to measure your provider's actual consumption.

See [AI-token estimates](docs/ai-tokens.md) for the measured source, arithmetic and treatment of input/cached tokens.

## Silly comparisons, honest arithmetic

A creative model invents the comparison and estimates how big one of its things is. Jev, a decision model, checks that estimate and picks the best candidate. Code does the arithmetic and writes the number into the sentence, so the model never states the count itself.

- **Model-led:** GLM 5.3 Flash on Workers AI reads prose and unfamiliar units and proposes references; Jev (`typesafe/jev-1.13` on OpenRouter) checks sizes and chooses.
- **Wide units:** any Math.js unit, money in 26 currencies, counts of named things, and named quantities estimated on the spot.
- **A reviewed fallback:** 109 sourced reference entries and 17 recipe mechanisms answer when the creative model refuses, fails or is overruled by Jev; anything the catalogue cannot cover is restated plainly.
- **Variety between submissions:** recent families are avoided while the page stays open, and each request gets a random theme.
- **Replayable:** every verified question, model response, refusal and answer is kept for 30 days (deleted within a day after that) so prompts and models can be improved against real traffic.

Astro builds the interface. A Cloudflare Worker serves the API and assets, Workers AI and OpenRouter supply inference through Cloudflare AI Gateway, D1 holds the replay log, and Math.js handles units. Turnstile and rate limits protect the public form. Skopia records visits and a conversion event containing only the dimension. The replay log does contain measurement text and answers; it does not contain IP addresses. See [How it works](docs/architecture.md).

## Run it locally

Use Node.js 24 and npm.

```sh
git clone https://github.com/jasonm4130/anything-but-metric.git
cd anything-but-metric
npm ci
npm run dev
```

This starts the **interface preview**. Conversions need the Worker, Workers AI, the Jev route and a correctly configured Turnstile widget; the Astro dev server alone does not serve `/api/convert`. All automated checks below run without credentials or paid inference.

```sh
npm test              # Worker and library tests
npm run check         # Astro and TypeScript diagnostics
npm run eval:corpus   # Frozen acceptance cases, variety and offline evaluation sweeps
npm run build         # Static production assets
```

The current baseline is **317 tests and 30 development acceptance cases passing**. These checks verify parsing, arithmetic, output contracts, protection and coverage. They are not a promise that every comparison is delightful or every possible unit is supported. See [evaluation notes](docs/evaluation.md).

`npm run eval:live` is a separate, opt-in harness for paid model evaluation. It refuses to run without `--live`, never runs in CI, enforces spend budgets and keeps a replayable log of every request and response outside Git.

## Deploy your own

Follow the [Cloudflare deployment guide](docs/deployment.md). It covers the Worker, custom domain, authenticated AI Gateway, spend limits, Turnstile and 1Password-backed configuration. The production AI Gateway is managed by the OpenTofu stack in [`infra/`](infra/README.md); other account infrastructure is managed separately.

`.env.op.example` contains placeholders only. Keep your own `.env.op` local; it is ignored by Git. CI neither receives deployment credentials nor calls a paid model.

## Make the nonsense better

Good contributions include a source-backed reference, a clearer comparison, a missing unit or a reproducible bug. Start with [CONTRIBUTING.md](CONTRIBUTING.md). References should be surprising enough to picture and precise enough to calculate.

The source notes belong beside the facts. A manufacturer's specification is for that model; a specimen's size is for that specimen; an animal range stays a range. The source sites retain their own rights, and a link does not imply endorsement.

Inspired by the spirit of r/anythingbutmetric. Image generation is a possible later experiment; the current project focuses on a quick, enjoyable conversion.
