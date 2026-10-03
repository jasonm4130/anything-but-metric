# The gateway already exists. Import it only after the central Cloudflare state
# has released it without destroying it; see README.md.
import {
  to = cloudflare_ai_gateway.anything_but_metric
  id = "${var.cloudflare_account_id}/anything-but-metric"
}
