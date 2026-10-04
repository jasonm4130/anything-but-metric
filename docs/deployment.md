# Deploy to Cloudflare

This guide is for a maintainer deploying an existing configured instance or a contributor creating a separate instance. The repository contains the Worker, static assets and an OpenTofu stack for the production AI Gateway. Other account infrastructure and the Turnstile widget are configured separately.

## Configure a separate instance

Use a Cloudflare account with Workers AI available and a domain managed in Cloudflare. Create a managed Turnstile widget for that domain, then create an authenticated AI Gateway. Keep gateway request-content logging disabled if you want the production site's configuration. Cloudflare documents the [AI binding](https://developers.cloudflare.com/workers-ai/configuration/bindings/) and the [widget and server-verification setup](https://developers.cloudflare.com/turnstile/get-started/).

Update these instance-specific settings before deployment:

| File | Setting |
| --- | --- |
| `wrangler.jsonc` | Worker name, custom-domain route, rate-limit namespace and replay database |
| `astro.config.mjs` | Canonical site URL |
| `src/worker.ts` | `TURNSTILE_HOSTNAME` and `GATEWAY_ID` |
| `src/pages/index.astro` | Skopia site identifier, or remove the analytics integration |
| `.env.op` | Your account, deployment token and widget references |

The production gateway uses 30 requests per minute, US$1 over a rolling day and US$5 over thirty rolling days. Set your own [gateway spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/) before accepting public traffic. Gateway accounting is eventually consistent; these controls are not exact billing ceilings. For the production gateway they are set in [`infra/`](#manage-the-production-gateway); no deployment command raises them. A conversion now makes two to five gateway requests (reader, creative model and up to three Jev calls), so 30 requests per minute serves roughly six to fifteen conversions a minute; beyond that, the gateway returns 429 and the Worker falls back to the catalogue or skips Jev.

## Manage the production gateway

The `infra/` OpenTofu stack owns the `anything-but-metric` gateway, its spend and rate limits, and its OpenRouter hookup. OpenRouter's key is stored in the gateway, so requests send only the gateway token. See [`infra/README.md`](../infra/README.md) for resources, credentials and the first-apply gate.

Before the first apply, the account's token stack must have issued the Anything But Metric deploy token and per-project state credential (never the root Terraform R2 keys), and the account's root Terraform state must have released the gateway without destroying it. Never apply while both states own the gateway.

```sh
cd infra
cp .env.op.example .env.op            # then set your 1Password references
op run --env-file=.env.op -- tofu init -input=false -lockfile=readonly -backend-config=backend.hcl
op run --env-file=.env.op -- tofu plan -input=false -out=gateway.tfplan
op run --env-file=.env.op -- tofu apply gateway.tfplan
```

Review the saved plan before applying it. The first plan imports the gateway with no changes to it and creates only the OpenRouter custom provider, one secret and one provider key.

The Worker reaches models through gateway ID `anything-but-metric`:

| Use | Route |
| --- | --- |
| Workers AI | The `AI` binding with `gateway: { id: "anything-but-metric" }` |
| Jev decisions | `https://gateway.ai.cloudflare.com/v1/{account_id}/anything-but-metric/custom-openrouter-api/api/alpha/decisions` |

The custom route covers every OpenRouter path, so chat completions use `.../custom-openrouter-api/api/v1/chat/completions`. The Worker calls Workers AI for the reader and creative models and Jev for checks, choices and screening prose input. It reaches Jev only when both `JEV_DECISIONS_URL` and `AI_GATEWAY_TOKEN` are installed; otherwise it answers without Jev's checks. Applying the stack does not deploy the Worker.

## First release of the model-led flow

The model-led Worker needs these once, before or with its first release:

1. Apply the `infra/` stack so the custom OpenRouter route and its stored key exist, then send one decision request through it (see [`infra/README.md`](../infra/README.md#plan-and-apply)).
2. Create a gateway token: a Cloudflare API token with **AI Gateway Run** for the `anything-but-metric` gateway. Store it in 1Password and point `AI_GATEWAY_TOKEN` and `JEV_DECISIONS_URL` in `.env.op` at it and at the decisions route.
3. Create the replay database and its table:

   ```sh
   op run --env-file=.env.op -- npx wrangler d1 create anything-but-metric-replay
   ```

   Add the printed `database_id` to the `REPLAY_LOG` entry in `wrangler.jsonc`, then apply the migration:

   ```sh
   op run --env-file=.env.op -- npm run db:migrate
   ```

   The deploy token needs **D1 Edit** for this. A Worker without the table still converts; each failed log write is reported in Workers Logs.
4. Install the secrets with `npm run secrets:sync` (below). It sends `TURNSTILE_SECRET_KEY`, `JEV_DECISIONS_URL` and `AI_GATEWAY_TOKEN` when they are loaded.

The replay log stores people's measurement text for 30 days; every write and a daily Cron Trigger delete rows within a day of turning 30 days old. Keep the database private to the maintainer account.

## Load configuration

1. Copy `.env.op.example` to `.env.op`.
2. Replace each placeholder with your own 1Password reference.
3. Run commands through `op run --env-file=.env.op --`.

Use a deployment token scoped to the intended account and Worker. Custom-domain setup also requires the appropriate route permissions. `PUBLIC_TURNSTILE_SITE_KEY` is embedded in the page during the build. `TURNSTILE_SECRET_KEY` must be installed as a Worker secret; loading it into the build environment does not install it remotely. See [Cloudflare's secret configuration](https://developers.cloudflare.com/workers/configuration/secrets/).

For a new instance, build and deploy the Worker and its configured route:

```sh
op run --env-file=.env.op -- npm run build
op run --env-file=.env.op -- npx wrangler deploy
op run --env-file=.env.op -- npm run secrets:sync
```

The API will reject verification until its Worker secret is installed. `secrets:sync` sends the Turnstile secret, and the Jev route and gateway token when loaded, to Wrangler over standard input; it does not print the values or write a plaintext file. It does not install the Cloudflare API token into the Worker.

## Release an existing instance

Run all checks before releasing:

```sh
npm ci
npm test
npm run check
npm run eval:corpus
op run --env-file=.env.op -- npm run dry-run
op run --env-file=.env.op -- npm run deploy
```

The deployment script requires the public site key, builds the page, uploads a tagged Worker version and assigns it 100% of traffic. It preserves the existing custom-domain configuration. If you change routes or other triggers, apply them separately with the appropriate permissions; uploading a version does not apply those changes.

CI runs tests and a keyless build only. It does not deploy the app. Do not use that keyless build as your release assets; the deployment command rebuilds them with the configured public key.

## Verify and roll back

Open the deployed domain. Wait for verification, convert `144 jouls`, then `$50`, `3 slices of pizza` and `2 PB`. Confirm that the button becomes ready again and the calculation details open. Then check the replay log received rows and Jev ran: `npm run replay -- pull --days 1 --out release-check` followed by `npm run replay -- summary --file release-check` should show `jev-review` stages with outcome `ok`, not `unavailable`. A direct request without a Turnstile token should return 403. Results vary by design: the creative model proposes new comparisons each time.

Record the active version before each release with `npx wrangler deployments list`. If a release fails verification, redeploy the previous known-good version with `npx wrangler versions deploy <previous-version-id>@100 --yes`, using the same configured account. Record the failed version and the observed behavior before changing code.
