locals {
  name = "${var.project}-${var.environment}"
  tags = {
    project     = var.project
    environment = var.environment
    managed_by  = "terraform"
  }
  # Fixed-size single replica prevents background imports from being scaled away
  # after the request returns. Dedicated headroom keeps HTTP polling responsive
  # during a full-agent POFA forecast; native physics still uses one CPU core.
  backend_cpu    = 2
  backend_memory = "4Gi"
}

resource "random_string" "suffix" {
  length  = 6
  upper   = false
  special = false
}

resource "random_password" "backend_token" {
  length  = 48
  special = false
}

resource "azurerm_resource_group" "main" {
  name     = "rg-${local.name}"
  location = var.location
  tags     = local.tags
}

resource "azurerm_storage_account" "data" {
  name                            = "${var.project}${random_string.suffix.result}"
  resource_group_name             = azurerm_resource_group.main.name
  location                        = azurerm_resource_group.main.location
  account_kind                    = "StorageV2"
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  access_tier                     = "Hot"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = false
  default_to_oauth_authentication = true

  # Blob access remains on the public HTTPS endpoint with identity authorization;
  # no public container access, keys, SAS links, paid private endpoint, or VNet.
  public_network_access_enabled = true

  blob_properties {
    versioning_enabled = true
    delete_retention_policy {
      days = 7
    }
    container_delete_retention_policy {
      days = 7
    }
  }

  tags = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_container" "data" {
  name                  = "crowdy"
  storage_account_id    = azurerm_storage_account.data.id
  container_access_type = "private"
}

resource "azurerm_storage_management_policy" "recovery" {
  storage_account_id = azurerm_storage_account.data.id

  rule {
    name    = "expire-previous-versions"
    enabled = true
    filters {
      prefix_match = ["${azurerm_storage_container.data.name}/"]
      blob_types   = ["blockBlob"]
    }
    actions {
      # Only previous versions and snapshots expire. Current workspace records
      # and original uploads have no automatic deletion rule.
      version {
        delete_after_days_since_creation = 7
      }
      snapshot {
        delete_after_days_since_creation_greater_than = 7
      }
    }
  }
}

resource "azurerm_container_registry" "images" {
  name                = "${var.project}${random_string.suffix.result}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "Basic"
  admin_enabled       = false
  tags                = local.tags
}

resource "azurerm_user_assigned_identity" "backend" {
  name                = "id-${local.name}-backend"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  tags                = local.tags
}

resource "azurerm_role_assignment" "blob_access" {
  scope                            = azurerm_storage_account.data.id
  role_definition_name             = "Storage Blob Data Contributor"
  principal_id                     = azurerm_user_assigned_identity.backend.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "image_pull" {
  scope                            = azurerm_container_registry.images.id
  role_definition_name             = "AcrPull"
  principal_id                     = azurerm_user_assigned_identity.backend.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_container_app_environment" "main" {
  name                = "cae-${local.name}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  # A v2 environment with only Consumption has no Dedicated management fee.
  # Omitting logs_destination streams logs without a paid Log Analytics workspace.
  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
  tags = local.tags
}

resource "azurerm_consumption_budget_resource_group" "monthly" {
  count             = var.create_budget ? 1 : 0
  name              = "budget-${local.name}"
  resource_group_id = azurerm_resource_group.main.id
  amount            = var.monthly_budget_usd
  time_grain        = "Monthly"

  time_period {
    start_date = var.budget_start_date
  }

  dynamic "notification" {
    for_each = toset([50, 80, 100])
    content {
      enabled        = true
      threshold      = notification.value
      operator       = "GreaterThanOrEqualTo"
      threshold_type = "Actual"
      contact_roles  = ["Owner"]
      contact_emails = var.budget_contact_emails
    }
  }

  notification {
    enabled        = true
    threshold      = 100
    operator       = "GreaterThanOrEqualTo"
    threshold_type = "Forecasted"
    contact_roles  = ["Owner"]
    contact_emails = var.budget_contact_emails
  }
}
