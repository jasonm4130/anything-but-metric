# Deploy to Cloudflare

This guide is for a maintainer deploying an existing configured instance or a contributor creating a separate instance. The repository contains the Worker and static assets. Account infrastructure, gateway spend controls and the Turnstile widget are configured separately.

## Configure a separate instance

Use a Cloudflare account with Workers AI available and a domain managed in Cloudflare. Create a managed Turnstile widget for that domain, then create an authenticated AI Gateway. Keep gateway request-content logging disabled if you want the production site's configuration. Cloudflare documents the [AI binding](https://developers.cloudflare.com/workers-ai/configuration/bindings/) and the [widget and server-verification setup](https://developers.cloudflare.com/turnstile/get-started/).

Update these instance-specific settings before deployment:

| File | Setting |
| --- | --- |
| `wrangler.jsonc` | Worker name, custom-domain route and rate-limit namespace |
| `astro.config.mjs` | Canonical site URL |
| `src/worker.ts` | `TURNSTILE_HOSTNAME` and gateway ID passed to `runStage` |
| `src/pages/index.astro` | Skopia site identifier, or remove the analytics integration |
| `.env.op` | Your account, deployment token and widget references |

The production gateway uses 30 requests per minute, US$1 over a rolling day and US$5 over thirty rolling days. Set your own [gateway spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/) before accepting public traffic. Gateway accounting is eventually consistent; these controls are not exact billing ceilings. The repository does not automatically provision or raise those limits.

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

The API will reject verification until its Worker secret is installed. `secrets:sync` sends only the Turnstile secret to Wrangler over standard input; it does not print the value or write a plaintext file. It does not install the Cloudflare API token into the Worker.

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

Open the deployed domain. Wait for verification, convert `144 jouls`, then convert `2 PB`. Confirm that the button becomes ready again and the calculation details open. A direct request without a Turnstile token should return 403. Results may vary because the selector chooses among multiple valid comparisons.

Record the active version before each release with `npx wrangler deployments list`. If a release fails verification, redeploy the previous known-good version with `npx wrangler versions deploy <previous-version-id>@100 --yes`, using the same configured account. Record the failed version and the observed behavior before changing code.
