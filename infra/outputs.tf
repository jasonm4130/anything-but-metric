output "gateway_id" {
  description = "Gateway ID used by the Worker's AI binding and gateway URLs."
  value       = local.gateway_id
}

output "jev_systemone_path" {
  description = "Path after https://gateway.ai.cloudflare.com/v1/{account_id}/ that reaches Jev through OpenRouter's System One API."
  value       = "${local.gateway_id}/${local.openrouter_route_slug}/api/v1/systemone"
}
