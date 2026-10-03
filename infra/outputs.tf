output "gateway_id" {
  description = "Gateway ID used by the Worker's AI binding and gateway URLs."
  value       = local.gateway_id
}

output "jev_decisions_path" {
  description = "Path after https://gateway.ai.cloudflare.com/v1/{account_id}/ that reaches OpenRouter's decision API."
  value       = "${local.gateway_id}/${local.openrouter_provider_slug}/api/alpha/decisions"
}
