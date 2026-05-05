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
  default     = "us.anthropic.claude-opus-4-6-v1"
}

variable "daily_hint_quota_per_user" {
  description = "Per-user daily hint ceiling enforced by the hint Lambda."
  type        = number
  default     = 1000
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

variable "platform_domain_name" {
  description = "Subdomain hosting the educator-tools web app (sibling to the landing site)."
  type        = string
  default     = "platform.knowable.ca"
}

# ---- Apple Sign-In ----
# DEPRECATED (CRIT-1, audit 2026-05-04): credentials moved to AWS Secrets
# Manager (knowable/apple-signin). Variables retained with empty defaults
# so terraform does not error if older .env.tfvars files still set them.
# Safe to delete after one release cycle once all developer machines are
# updated. See infrastructure/SECRETS-ROTATION.md.

variable "apple_services_id" {
  description = "DEPRECATED: now read from Secrets Manager (knowable/apple-signin -> services_id)."
  type        = string
  default     = ""
}

variable "apple_team_id" {
  description = "DEPRECATED: now read from Secrets Manager (knowable/apple-signin -> team_id)."
  type        = string
  default     = ""
}

variable "apple_key_id" {
  description = "DEPRECATED: now read from Secrets Manager (knowable/apple-signin -> key_id)."
  type        = string
  default     = ""
}

variable "apple_private_key" {
  description = "DEPRECATED: now read from Secrets Manager (knowable/apple-signin -> private_key)."
  type        = string
  default     = ""
  sensitive   = true
}

# ---- Google Sign-In ----
# DEPRECATED (CRIT-1, audit 2026-05-04): credentials moved to AWS Secrets
# Manager (knowable/google-oauth). See infrastructure/SECRETS-ROTATION.md.

variable "google_client_id" {
  description = "DEPRECATED: now read from Secrets Manager (knowable/google-oauth -> client_id)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "google_client_secret" {
  description = "DEPRECATED: now read from Secrets Manager (knowable/google-oauth -> client_secret)."
  type        = string
  default     = ""
  sensitive   = true
}

# ---- Cloudflare Turnstile ----

variable "elevenlabs_default_voice_id" {
  description = "Default ElevenLabs voice ID for Milo TTS."
  type        = string
  default     = "JBFqnCBsd6RMkjVDRZzb" # "George" - warm, friendly male
}

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
