variable "subscription_id" {
  description = "The explicitly authorized Azure for Students subscription. Never use the CLI default subscription."
  type        = string
  default     = "146aa8b7-dd72-4385-a658-2e1e39da630c"
  validation {
    condition     = var.subscription_id == "146aa8b7-dd72-4385-a658-2e1e39da630c"
    error_message = "This deployment is restricted to the authorized Azure for Students subscription."
  }
}

variable "tenant_id" {
  description = "Tenant owning the Azure for Students subscription, from az account show --subscription."
  type        = string
}

variable "location" {
  description = "Azure region permitted by the student subscription's location policy."
  type        = string
  default     = "westus2"
}

variable "project" {
  description = "Short lower-case resource name prefix."
  type        = string
  default     = "crowdy"
  validation {
    condition     = can(regex("^[a-z][a-z0-9]{2,9}$", var.project))
    error_message = "Use 3–10 lower-case letters or numbers, beginning with a letter."
  }
}

variable "environment" {
  description = "Resource group and tag environment."
  type        = string
  default     = "student"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,11}$", var.environment))
    error_message = "Use 2–12 lower-case letters, numbers, or hyphens."
  }
}

variable "deploy_backend" {
  description = "Deploy the app only after its real image has been built. Foundation never exposes a placeholder API."
  type        = bool
  default     = false
}

variable "backend_image" {
  description = "Full immutable image tag or digest from this deployment's ACR. Required when deploy_backend is true."
  type        = string
  default     = ""
}

variable "gemini_api_key" {
  description = "Optional server-side Gemini API key for image interpretation. Never exposed to the browser."
  type        = string
  sensitive   = true
  default     = ""
}

variable "anthropic_api_key" {
  description = "Optional server-side Anthropic API key for image interpretation. Never exposed to the browser."
  type        = string
  sensitive   = true
  default     = ""
}

variable "create_budget" {
  description = "Create resource group cost alerts. Alerts do not impose a spending cap or shut resources down."
  type        = bool
  default     = true
}

variable "monthly_budget_usd" {
  description = "Monthly alert threshold in USD; the student credit is a total balance, not a monthly allowance."
  type        = number
  default     = 40
  validation {
    condition     = var.monthly_budget_usd > 0 && var.monthly_budget_usd <= 100
    error_message = "The monthly alert threshold must be greater than zero and at most 100 USD."
  }
}

variable "budget_start_date" {
  description = "First day of the deployment month in UTC. Keep unchanged after creation."
  type        = string
  default     = "2026-10-01T00:00:00Z"
}

variable "budget_contact_emails" {
  description = "Optional budget alert recipients. Resource group Owners also receive alerts."
  type        = list(string)
  default     = []
}
