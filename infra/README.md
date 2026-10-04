# Anything But Metric infrastructure

This OpenTofu stack owns the production AI Gateway `anything-but-metric` and its
OpenRouter hookup. It does not deploy the Worker, change its bindings or own the
Cloudflare token it runs with. The gateway already exists: the stack adopts it with
an import block and keeps its settings unchanged.

## Defined resources

| Address | Purpose |
| --- | --- |
| `cloudflare_ai_gateway.anything_but_metric` | Existing gateway, imported. Authentication on, request logs off, 30 requests per minute, US$1 per rolling day and US$5 per thirty rolling days. |
| `restful_resource.openrouter_custom_provider` | Account custom provider `openrouter-api`, base URL `https://openrouter.ai`. |
| `cloudflare_secrets_store_secret.openrouter` | Stored OpenRouter key for the custom provider. |
| `restful_resource.openrouter_provider_key` | Gateway provider key (BYOK) for provider slug `openrouter-api` that points at that secret, alias `default`. |

The gateway keeps `prevent_destroy`. Its arguments match the former central
Terraform resource, including the Secrets Store association (`secrets_store_id`).

## Routes the Worker uses

All gateway URLs start with `https://gateway.ai.cloudflare.com/v1/{account_id}/anything-but-metric/`.
Requests send `cf-aig-authorization: Bearer <gateway token>` because authentication
is on. With stored keys, send no provider `Authorization` header: the gateway adds
the stored key only when that header is absent.

| Use | Route |
| --- | --- |
| Workers AI (reader and creative models) | `env.AI.run(model, input, { gateway: { id: "anything-but-metric" } })` |
| Jev (`typesafe/jev-1.13`) | `POST .../anything-but-metric/custom-openrouter-api/api/v1/systemone` |

Cloudflare documents the native [OpenRouter route](https://developers.cloudflare.com/ai-gateway/usage/providers/openrouter/)
only as a replacement for `https://openrouter.ai/api/v1/chat/completions`. A
[custom provider](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/)
is documented to append everything after `custom-{slug}/` to its base URL. That holds
for paths with a `/v1/` segment: `/api/v1/models`, `/api/v1/chat/completions` and
`/api/v1/systemone` reach OpenRouter. Jev's Decisions API,
`https://openrouter.ai/api/alpha/decisions`, does not: on 4 October 2026 the gateway sent
it to an OpenRouter page that does not exist and returned 404, the behaviour reported in
[cloudflare/ai#476](https://github.com/cloudflare/ai/issues/476). The Worker therefore
calls Jev through OpenRouter's [System One API](https://openrouter.ai/docs/guides/community/typesafe-sdk),
which takes the same `model`, `state` and `questions` and returns the same `answers`.
A probe of that route returned 200 when the OpenRouter key was sent in the request.

[BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)
looks keys up by secret name `{gateway_id}_{provider_slug}_{alias}`, not by secret ID,
and this stack creates the secret before the provider key. A provider key with slug
`custom-openrouter-api` was never attached: requests without an `Authorization` header
reached OpenRouter unauthenticated. The stack now uses the custom provider's bare slug,
`openrouter-api`, for both the secret name and the provider key. Cloudflare's docs do
not say which slug custom providers use, so this is unproven until the probe in
[Plan and apply](#plan-and-apply) returns 200. The Worker calls this route once
`JEV_DECISIONS_URL` and `AI_GATEWAY_TOKEN` are installed as Worker secrets.

## Provider choices

Cloudflare provider 5.22.0 (and 5.26.0, the newest checked) has no resource for
custom providers or gateway provider keys. Both use `magodo/restful` 0.25.2 against
the documented API, as the central account repository does for older gateways.
Provider keys cannot be edited in place, so any change to their attributes replaces
them. Rotating the OpenRouter key updates the secret in place.

The OpenRouter key is persisted in encrypted state, because the Secrets Store secret
resource has no write-only value in this provider version. Never print state.

## Credentials

Copy `.env.op.example` to the ignored `.env.op` and point each placeholder at the
real 1Password item. The stack needs:

- The Anything But Metric deploy token, issued by the account's token stack. It
  needs **AI Gateway Write** and **Secrets Store Write** for this account. Cloudflare
  lists provider-key creation under Secrets Store Write.
- An independent state passphrase of at least 32 characters.
- The OpenRouter API key.
- The per-project state credential, issued by the account's token stack and scoped
  to this stack's own state (with a dedicated bucket if R2 cannot scope it to the
  `anything-but-metric/` prefix). Never use the root Cloudflare Terraform R2 keys.
- The account ID and the gateway's live Secrets Store ID as plain values.

Copy `backend.hcl.example` outside the repository or to the ignored `backend.hcl`
and set the state bucket and the account's R2 endpoint. State lives at
`anything-but-metric/infra.tfstate`, reached only with the per-project state
credential, which must exist before the first `tofu init`.

## Ordering

The gateway currently belongs to the account repository's root Terraform state.
Apply this stack only after both of these are done there:

1. The Anything But Metric token stack is applied and its deploy token and
   per-project state credential are saved in 1Password.
2. The root state has released `cloudflare_ai_gateway.anything_but_metric` without
   destroying it, for example with a `removed` block and `destroy = false`.

Never apply this stack while the root state still owns the gateway. Two owners would
each try to correct the other's changes.

## Plan and apply

Run from this directory with OpenTofu 1.12.6 and the committed lockfile:

```sh
op run --env-file=.env.op -- tofu init -input=false -lockfile=readonly -backend-config=backend.hcl
op run --env-file=.env.op -- tofu plan -input=false -out=gateway.tfplan
```

The first plan must show exactly one import, with no changes to the gateway, and
these creates: one custom provider, one secret and one provider key. Stop on any
gateway update, replacement or deletion, or any other change. Only after review:

```sh
op run --env-file=.env.op -- tofu apply gateway.tfplan
```

A following plan must report no changes. Then send one Jev request through the
custom route with only the gateway token. From the repository root, with
`JEV_DECISIONS_URL` and `AI_GATEWAY_TOKEN` set in its `.env.op`:

```sh
op run --env-file=.env.op -- sh -c 'printf "cf-aig-authorization: Bearer %s\n" "$AI_GATEWAY_TOKEN" |
  curl -sS -H @- -H "content-type: application/json" "$JEV_DECISIONS_URL" -d "{\"model\":\"typesafe/jev-1.13\",\"state\":\"3 metres\",\"questions\":{\"q\":{\"type\":\"choice\",\"instructions\":\"Is this a measurement?\",\"criteria\":{\"yes\":\"A measurement\",\"no\":\"Anything else\"}}}}"'
```

A 200 with an `answers` object proves the stored key is attached, at about
US$0.00002. A 401 from OpenRouter means it is not. Workers AI traffic should continue
unchanged. The backend has no locking: keep one writer.

If the slug is already taken by a manually created custom provider, do not create a
second one. Import it into `restful_resource.openrouter_custom_provider` in a
separately reviewed change.

## Local checks

No credential, backend or Cloudflare call is needed:

```sh
(
  cd infra
  export TF_DATA_DIR=$(mktemp -d)
  trap 'rm -rf "$TF_DATA_DIR"' EXIT
  export TF_VAR_state_passphrase=synthetic-validation-only-passphrase
  tofu fmt -check
  tofu init -backend=false -input=false -lockfile=readonly
  tofu validate
)
```

These checks do not prove credentials, backend access, the import or a no-change plan.
