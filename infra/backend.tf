resource "azurerm_container_app" "backend" {
  count                        = var.deploy_backend ? 1 : 0
  name                         = "ca-${local.name}-backend"
  resource_group_name          = azurerm_resource_group.main.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.backend.id]
  }

  registry {
    server   = azurerm_container_registry.images.login_server
    identity = azurerm_user_assigned_identity.backend.id
  }

  secret {
    name  = "backend-token"
    value = random_password.backend_token.result
  }

  dynamic "secret" {
    for_each = nonsensitive(var.gemini_api_key != "") ? [1] : []
    content {
      name  = "gemini-api-key"
      value = var.gemini_api_key
    }
  }

  dynamic "secret" {
    for_each = nonsensitive(var.anthropic_api_key != "") ? [1] : []
    content {
      name  = "anthropic-api-key"
      value = var.anthropic_api_key
    }
  }

  dynamic "secret" {
    for_each = nonsensitive(var.ai_gateway_api_key != "") ? [1] : []
    content {
      name  = "ai-gateway-api-key"
      value = var.ai_gateway_api_key
    }
  }

  ingress {
    external_enabled           = true
    target_port                = 8000
    transport                  = "http"
    allow_insecure_connections = false
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = 1
    max_replicas = 1

    container {
      name   = "backend"
      image  = var.backend_image
      cpu    = local.backend_cpu
      memory = local.backend_memory

      env {
        name  = "PORT"
        value = "8000"
      }
      env {
        name  = "AZURE_STORAGE_ACCOUNT_URL"
        value = azurerm_storage_account.data.primary_blob_endpoint
      }
      env {
        name  = "AZURE_STORAGE_CONTAINER"
        value = azurerm_storage_container.data.name
      }
      env {
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.backend.client_id
      }
      env {
        name        = "CROWDY_BACKEND_TOKEN"
        secret_name = "backend-token"
      }
      dynamic "env" {
        for_each = nonsensitive(var.gemini_api_key != "") ? [1] : []
        content {
          name        = "GEMINI_API_KEY"
          secret_name = "gemini-api-key"
        }
      }
      dynamic "env" {
        for_each = nonsensitive(var.anthropic_api_key != "") ? [1] : []
        content {
          name        = "ANTHROPIC_API_KEY"
          secret_name = "anthropic-api-key"
        }
      }
      dynamic "env" {
        for_each = nonsensitive(var.ai_gateway_api_key != "") ? [1] : []
        content {
          name        = "AI_GATEWAY_API_KEY"
          secret_name = "ai-gateway-api-key"
        }
      }

      startup_probe {
        transport               = "TCP"
        port                    = 8000
        initial_delay           = 5
        interval_seconds        = 5
        timeout                 = 3
        failure_count_threshold = 30
      }
      readiness_probe {
        transport               = "TCP"
        port                    = 8000
        interval_seconds        = 10
        timeout                 = 3
        failure_count_threshold = 3
      }
      # TCP liveness allows CPU-bound simulations to finish without an HTTP
      # response deadline restarting a healthy, busy backend.
      liveness_probe {
        transport               = "TCP"
        port                    = 8000
        initial_delay           = 30
        interval_seconds        = 30
        timeout                 = 5
        failure_count_threshold = 10
      }
    }
  }

  tags = local.tags

  depends_on = [azurerm_role_assignment.blob_access, azurerm_role_assignment.image_pull]

  lifecycle {
    # Azure omits these defaults on reads in Single revision mode. Ignore only
    # the normalized fields; image, ingress security, replicas and probe
    # ports/timing remain managed. Explicit TCP probes avoid the provider's
    # lossy HTTP scheme default and wait for Uvicorn's listener to be ready.
    ignore_changes = [
      ingress[0].traffic_weight,
      template[0].cooldown_period_in_seconds,
      template[0].polling_interval_in_seconds,
    ]
    precondition {
      condition     = startswith(var.backend_image, "${azurerm_container_registry.images.login_server}/")
      error_message = "Build a backend image in this deployment's registry before setting deploy_backend=true."
    }
  }
}
