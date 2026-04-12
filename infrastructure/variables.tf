variable "region" {
  description = "Primary AWS region for Knowable resources."
  type        = string
  default     = "us-east-1"
}

variable "project" {
  description = "Project name used for tagging and resource prefixing."
  type        = string
  default     = "knowable"
}

variable "env" {
  description = "Deployment environment name."
  type        = string
  default     = "prod"
}

variable "bedrock_model_id" {
  description = "Bedrock foundation model ID used by the hint Lambda."
  type        = string
  default     = "anthropic.claude-3-5-sonnet-20240620-v1:0"
}

variable "daily_hint_quota_per_user" {
  description = "Per-user daily hint ceiling enforced by the hint Lambda."
  type        = number
  default     = 30
}

variable "daily_hint_quota_global" {
  description = "Global daily hint ceiling (circuit breaker) enforced by the hint Lambda."
  type        = number
  default     = 500
}

variable "monthly_budget_usd" {
  description = "Monthly Bedrock cost budget threshold in USD."
  type        = number
  default     = 50
}

variable "config_fetch_ttl_minutes" {
  description = "TTL in minutes for the client-side cache of /config?key=stuck_detection."
  type        = number
  default     = 10
}

variable "domain_name" {
  description = "Primary apex domain for the landing page."
  type        = string
  default     = "knowable.ca"
}

variable "alt_domain_names" {
  description = "Alternate domains for the landing page CloudFront distribution."
  type        = list(string)
  default     = ["www.knowable.ca"]
}

# ---- Apple Sign-In ----

variable "apple_services_id" {
  description = "Apple Services ID (e.g. ca.knowable.auth) registered in the Apple Developer Portal."
  type        = string
  default     = ""
}

variable "apple_team_id" {
  description = "Apple Developer Team ID."
  type        = string
  default     = ""
}

variable "apple_key_id" {
  description = "Apple Sign-In key ID associated with the private key."
  type        = string
  default     = ""
}

variable "apple_private_key" {
  description = "Apple Sign-In private key (PEM). Sourced from gitignored .env.tfvars."
  type        = string
  default     = ""
  sensitive   = true
}

# ---- Google Sign-In ----

variable "google_client_id" {
  description = "Google OAuth 2.0 client ID used for Sign in with Google."
  type        = string
  default     = ""
  sensitive   = true
}

variable "google_client_secret" {
  description = "Google OAuth 2.0 client secret used for Sign in with Google."
  type        = string
  default     = ""
  sensitive   = true
}

# ---- Cloudflare Turnstile ----

variable "turnstile_site_key" {
  description = "Cloudflare Turnstile site key (public). Injected into the Astro landing build."
  type        = string
  default     = ""
}

# ---- OAuth callback scheme ----

variable "callback_url_scheme" {
  description = "Custom URL scheme used for Cognito Hosted UI callbacks into the iOS app."
  type        = string
  default     = "knowable"
}
