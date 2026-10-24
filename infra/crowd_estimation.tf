variable "deploy_crowd_estimation" {
  description = "Opt in to the independent YOLO service after its real image has been built."
  type        = bool
  default     = false
}

variable "crowd_estimation_image" {
  description = "Full image tag or digest in this deployment's ACR, independent of backend_image."
  type        = string
  default     = ""
}

variable "crowd_estimation_min_replicas" {
  description = "Keep 0 replicas for scale-to-zero, or 1 for a warm demo with no model cold start."
  type        = number
  default     = 0
  validation {
    condition     = contains([0, 1], var.crowd_estimation_min_replicas)
    error_message = "Use 0 to scale to zero or 1 to keep the model warm."
  }
}

variable "crowd_estimation_max_replicas" {
  description = "Bound the CPU inference service to one or two independent replicas."
  type        = number
  default     = 2
  validation {
    condition     = contains([1, 2], var.crowd_estimation_max_replicas)
    error_message = "Use one or two crowd-estimation replicas."
  }
}

# These resources are absent until this service is explicitly enabled. The
# service's identity can pull images, but has no access to workspace storage.
resource "random_password" "crowd_estimation_token" {
  count   = var.deploy_crowd_estimation ? 1 : 0
  length  = 48
  special = false
}

resource "azurerm_user_assigned_identity" "crowd_estimation" {
  count               = var.deploy_crowd_estimation ? 1 : 0
  name                = "id-${local.name}-crowd"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  tags                = local.tags
}

resource "azurerm_role_assignment" "crowd_estimation_image_pull" {
  count                            = var.deploy_crowd_estimation ? 1 : 0
  scope                            = azurerm_container_registry.images.id
  role_definition_name             = "AcrPull"
  principal_id                     = azurerm_user_assigned_identity.crowd_estimation[0].principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_container_app" "crowd_estimation" {
  count                        = var.deploy_crowd_estimation ? 1 : 0
  name                         = "ca-${local.name}-crowd"
  resource_group_name          = azurerm_resource_group.main.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.crowd_estimation[0].id]
  }

  registry {
    server   = azurerm_container_registry.images.login_server
    identity = azurerm_user_assigned_identity.crowd_estimation[0].id
  }

  secret {
    name  = "crowd-estimation-token"
    value = random_password.crowd_estimation_token[0].result
  }

  ingress {
    external_enabled           = true
    target_port                = 8001
    transport                  = "http"
    allow_insecure_connections = false
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas                = var.crowd_estimation_min_replicas
    max_replicas                = var.crowd_estimation_max_replicas
    cooldown_period_in_seconds  = 300
    polling_interval_in_seconds = 30

    http_scale_rule {
      name                = "inference-requests"
      concurrent_requests = 1
    }

    container {
      name   = "crowd-estimation"
      image  = var.crowd_estimation_image
      cpu    = 1
      memory = "2Gi"

      env {
        name        = "CROWDY_CROWD_ESTIMATION_TOKEN"
        secret_name = "crowd-estimation-token"
      }
      env {
        name  = "CROWDY_YOLO_MODEL"
        value = "/srv/crowdy/models/yolo26n.pt"
      }
      env {
        name  = "CROWDY_YOLO_DEVICE"
        value = "cpu"
      }
      env {
        name  = "CROWDY_YOLO_THREADS"
        value = "2"
      }

      # Uvicorn binds only after the FastAPI lifespan loads and warms the model,
      # so TCP readiness waits for usable inference. TCP avoids Azure's lossy
      # HTTP probe scheme normalization; /readyz remains available to callers.
      startup_probe {
        transport               = "TCP"
        port                    = 8001
        initial_delay           = 10
        interval_seconds        = 10
        timeout                 = 5
        failure_count_threshold = 30
      }
      readiness_probe {
        transport               = "TCP"
        port                    = 8001
        interval_seconds        = 10
        timeout                 = 5
        success_count_threshold = 1
        failure_count_threshold = 3
      }
      liveness_probe {
        transport               = "TCP"
        port                    = 8001
        initial_delay           = 30
        interval_seconds        = 30
        timeout                 = 5
        failure_count_threshold = 5
      }
    }
  }

  tags = local.tags

  depends_on = [azurerm_role_assignment.crowd_estimation_image_pull]

  lifecycle {
    # Live Azure reads omit these documented defaults, producing 0 in provider
    # state even after a successful deployment. Ignore only that normalization;
    # image, security, resource limits, replicas, and HTTP rules remain managed.
    ignore_changes = [
      ingress[0].traffic_weight,
      template[0].cooldown_period_in_seconds,
      template[0].polling_interval_in_seconds,
    ]

    precondition {
      condition     = startswith(var.crowd_estimation_image, "${azurerm_container_registry.images.login_server}/crowdy-crowd-estimation:") || startswith(var.crowd_estimation_image, "${azurerm_container_registry.images.login_server}/crowdy-crowd-estimation@sha256:")
      error_message = "Build the crowdy-crowd-estimation image in this deployment's registry before enabling this service."
    }
  }
}

output "crowd_estimation_url" {
  description = "HTTPS base URL for authenticated server-to-server image estimates."
  value       = var.deploy_crowd_estimation ? "https://${azurerm_container_app.crowd_estimation[0].ingress[0].fqdn}" : null
}

output "crowd_estimation_token" {
  description = "Separate bearer token for CROWDY_CROWD_ESTIMATION_TOKEN on a trusted server. Never NEXT_PUBLIC_."
  value       = var.deploy_crowd_estimation ? random_password.crowd_estimation_token[0].result : null
  sensitive   = true
}

output "crowd_estimation_container_app_name" {
  value = var.deploy_crowd_estimation ? azurerm_container_app.crowd_estimation[0].name : null
}
