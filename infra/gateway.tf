# Existing production gateway. Keep these arguments equal to the former central
# Terraform resource so the import plans no changes to it.
resource "cloudflare_ai_gateway" "anything_but_metric" {
  account_id = var.cloudflare_account_id
  id         = "anything-but-metric"

  authentication             = true
  collect_logs               = false
  cache_invalidate_on_update = true
  cache_ttl                  = 0
  workers_ai_billing_mode    = "postpaid"

  # Pin API defaults: v5.22 sends null on update for omitted optional values.
  logpush = false
  zdr     = false
  # Stored provider keys live in this Secrets Store.
  store_id                = var.secrets_store_id
  log_management          = 10000000
  log_management_strategy = "DELETE_OLDEST"

  rate_limiting_interval  = 60
  rate_limiting_limit     = 30
  rate_limiting_technique = "sliding"

  # Spend tracking is eventually consistent; concurrent requests can overshoot.
  # Windows are seconds: one day and thirty days.
  spend_limits = {
    enabled = true
    rules = [
      {
        id         = "daily"
        enabled    = true
        limit      = var.daily_budget_usd
        limit_type = "cost"
        window     = 86400
        technique  = "sliding"
      },
      {
        id         = "thirty-days"
        enabled    = true
        limit      = var.monthly_budget_usd
        limit_type = "cost"
        window     = 2592000
        technique  = "sliding"
      },
    ]
  }

  lifecycle {
    prevent_destroy = true
  }
}
