output "gateway_id" {
  description = "Gateway ID used by the Worker's AI binding and gateway URLs."
  value       = local.gateway_id
}

output "jev_decisions_path" {
  description = "Path after https://gateway.ai.cloudflare.com/v1/{account_id}/ that reaches OpenRouter's decision API."
  value       = "${local.gateway_id}/custom-${local.openrouter_custom_slug}/api/alpha/decisions"
}

output "openrouter_chat_path" {
  description = "Path after https://gateway.ai.cloudflare.com/v1/{account_id}/ for OpenRouter chat completions."
  value       = "${local.gateway_id}/openrouter/chat/completions"
}
