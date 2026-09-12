<div align="center">

<img src="public/banana-ruler.svg" width="180" alt="A banana pretending to be a ruler">

# Anything But Metric

**Put a number in the machine. Get a much less sensible way to picture it.**

[Try anythingbutmetric.wtf](https://anythingbutmetric.wtf) · [How it works](docs/architecture.md) · [Contribute](CONTRIBUTING.md)

[![Checks](https://github.com/jasonm4130/anything-but-metric/actions/workflows/check.yml/badge.svg)](https://github.com/jasonm4130/anything-but-metric/actions/workflows/check.yml)

</div>

Enter a measurement, press **Convert**, and get one playful comparison. Typos welcome. No chat history, follow-up interrogation or compulsory punchline.

| You enter | One possible answer |
| --- | --- |
| `144 jouls` | About 83 iPhone 17s lifted onto one-metre shelves. |
| `2 PB` | Print it double-sided: a paper stack about 8.3 Earths tall. |

These examples were checked on the live site. Results vary; expand **Show the questionable maths** to see the assumptions and sources.

## AI tokens count too

Try **`1M AI tokens`**, **`250k output tokens`** or even **`1 AI token`** in the same input. The converter estimates an energy interval and turns it into a playful comparison. The result clearly labels the benchmark and treats an unspecified count as output tokens; it does not claim to measure your provider's actual consumption.

See [AI-token estimates](docs/ai-tokens.md) for the measured source, arithmetic and treatment of input/cached tokens.

## Silly comparisons, grounded arithmetic

The model chooses an image from a menu that code has already calculated. It cannot change a reference's size or write its own answer into the result.

- **109 reference entries:** objects, landmarks, appliances, media formats and full animal weight ranges.
- **414 comparison recipes** reached by the current magnitude sweep, using 17 mechanisms.
- **Variety between submissions:** recent source families are avoided while the page stays open.
- **One small model call for ordinary inputs:** Llama 3.2 3B chooses an offered comparison; unresolved prose gets a separate extraction call.
- **Useful fallback:** if selection fails, a valid menu item still works. Unsupported measurements and scales get an explicit message.

Astro builds the interface. A Cloudflare Worker serves the API and assets, Workers AI supplies inference, and Math.js handles units. Turnstile and rate limits protect the public form. Skopia records visits and a conversion event containing only the dimension; measurement text and answers are not included in that event.

## Run it locally

Use Node.js 24 and npm.

```sh
git clone https://github.com/jasonm4130/anything-but-metric.git
cd anything-but-metric
npm ci
npm run dev
```

This starts the **interface preview**. Conversions need the Worker, Workers AI and a correctly configured Turnstile widget; the Astro dev server alone does not serve `/api/convert`. All automated checks below run without credentials or paid inference.

```sh
npm test              # Worker and library tests
npm run check         # Astro and TypeScript diagnostics
npm run eval:corpus   # Frozen acceptance cases and variety sweep
npm run build         # Static production assets
```

The current baseline is **285 tests and 30 development acceptance cases passing**. These checks verify parsing, arithmetic, output contracts, protection and coverage. They are not a promise that every comparison is delightful or every possible unit is supported. See [evaluation notes](docs/evaluation.md).

## Deploy your own

Follow the [Cloudflare deployment guide](docs/deployment.md). It covers the Worker, custom domain, authenticated AI Gateway, spend limits, Turnstile and 1Password-backed configuration. The production site's infrastructure is managed separately in Terraform.

`.env.op.example` contains placeholders only. Keep your own `.env.op` local; it is ignored by Git. CI neither receives deployment credentials nor calls a paid model.

## Make the nonsense better

Good contributions include a source-backed reference, a clearer comparison, a missing unit or a reproducible bug. Start with [CONTRIBUTING.md](CONTRIBUTING.md). References should be surprising enough to picture and precise enough to calculate.

The source notes belong beside the facts. A manufacturer's specification is for that model; a specimen's size is for that specimen; an animal range stays a range. The source sites retain their own rights, and a link does not imply endorsement.

Inspired by the spirit of r/anythingbutmetric. Image generation is a possible later experiment; the current project focuses on a quick, enjoyable conversion.
