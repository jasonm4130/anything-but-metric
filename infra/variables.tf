variable "cloudflare_account_id" {
  description = "Cloudflare account that owns the anything-but-metric gateway."
  type        = string
  nullable    = false
}

variable "cloudflare_api_token" {
  description = "Dedicated Anything But Metric Cloudflare deploy token."
  type        = string
  sensitive   = true
  ephemeral   = true
  nullable    = false
}

variable "state_passphrase" {
  description = "Independent OpenTofu state-encryption passphrase; never commit it."
  type        = string
  sensitive   = true
  ephemeral   = true
  nullable    = false
  validation {
    condition     = length(var.state_passphrase) >= 32
    error_message = "Use a separately generated passphrase of at least 32 characters."
  }
}

variable "secrets_store_id" {
  description = "Secrets Store already associated with the gateway; must equal its live store_id."
  type        = string
  nullable    = false
}

variable "openrouter_api_key" {
  description = "OpenRouter API key stored for the gateway. Persisted only in encrypted state."
  type        = string
  sensitive   = true
  nullable    = false
}

variable "daily_budget_usd" {
  description = "AI Gateway spend threshold in USD over a rolling day."
  type        = number
  default     = 1
  validation {
    condition     = var.daily_budget_usd > 0
    error_message = "The daily budget must be positive."
  }
}

variable "monthly_budget_usd" {
  description = "AI Gateway spend threshold in USD over thirty rolling days."
  type        = number
  default     = 5
  validation {
    condition     = var.monthly_budget_usd > 0
    error_message = "The rolling 30-day budget must be positive."
  }
}
