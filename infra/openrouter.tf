# OpenRouter through the gateway, using one stored key and no key in requests.
#
# The native `openrouter` route documents only chat completions. Jev's decision
# API is POST https://openrouter.ai/api/alpha/decisions, so a custom provider
# with the bare origin as its base URL forwards any OpenRouter path:
#   /custom-openrouter-api/api/alpha/decisions -> https://openrouter.ai/api/alpha/decisions
# https://developers.cloudflare.com/ai-gateway/usage/providers/openrouter/
# https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/
# https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/

locals {
  gateway_id = cloudflare_ai_gateway.anything_but_metric.id

  # Custom providers are addressed with a `custom-` prefix on their slug.
  openrouter_custom_slug = "openrouter-api"
  byok_alias             = "default"
  openrouter_provider_slugs = toset([
    "openrouter",
    "custom-${local.openrouter_custom_slug}",
  ])
}

# Custom providers are account-wide; the slug must be unique in the account.
resource "restful_resource" "openrouter_custom_provider" {
  path            = "/accounts/${var.cloudflare_account_id}/ai-gateway/custom-providers"
  read_path       = "$(path)/$(body.id)"
  create_selector = "result"
  read_selector   = "result"

  update_method        = "PATCH"
  merge_patch_disabled = true

  body = {
    name        = "OpenRouter API"
    slug        = local.openrouter_custom_slug
    base_url    = "https://openrouter.ai"
    description = "Full OpenRouter API for paths the native route does not document, such as /api/alpha/decisions."
    enable      = true
  }

  output_attrs = ["id", "slug"]
}

# BYOK reads a key by its secret name, {gateway_id}_{provider_slug}_{alias};
# the secret must exist before the provider key that refers to it.
resource "cloudflare_secrets_store_secret" "openrouter" {
  for_each = local.openrouter_provider_slugs

  account_id = var.cloudflare_account_id
  store_id   = var.secrets_store_id
  name       = "${local.gateway_id}_${each.key}_${local.byok_alias}"
  value      = var.openrouter_api_key
  scopes     = ["ai_gateway"]
  comment    = "OpenRouter key for the ${local.gateway_id} gateway (${each.key})."
}

# A stored provider key cannot be edited apart from its secret, so any change
# to these attributes replaces it. Rotating the key updates the secret in place.
resource "restful_resource" "openrouter_provider_key" {
  for_each = local.openrouter_provider_slugs

  path            = "/accounts/${var.cloudflare_account_id}/ai-gateway/gateways/${local.gateway_id}/provider_configs"
  read_path       = "$(path)/$(body.id)"
  create_selector = "result"
  read_selector   = "result"

  body = {
    provider_slug  = each.key
    alias          = local.byok_alias
    default_config = true
    secret_id      = cloudflare_secrets_store_secret.openrouter[each.key].id
  }
  force_new_attrs = ["provider_slug", "alias", "default_config", "secret_id"]

  output_attrs = ["id", "provider_slug", "alias"]

  depends_on = [restful_resource.openrouter_custom_provider]
}
