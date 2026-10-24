output "resource_group_name" {
  description = "Resource group containing the student deployment."
  value       = azurerm_resource_group.main.name
}

output "registry_name" {
  description = "ACR name for az acr build."
  value       = azurerm_container_registry.images.name
}

output "registry_login_server" {
  value = azurerm_container_registry.images.login_server
}

output "storage_account_name" {
  value = azurerm_storage_account.data.name
}

output "storage_account_url" {
  value = azurerm_storage_account.data.primary_blob_endpoint
}

output "storage_container" {
  value = azurerm_storage_container.data.name
}

output "backend_managed_identity_client_id" {
  value = azurerm_user_assigned_identity.backend.client_id
}

output "backend_url" {
  description = "HTTPS base URL. Set CROWDY_BACKEND_URL in the frontend server environment."
  value       = var.deploy_backend ? "https://${azurerm_container_app.backend[0].ingress[0].fqdn}" : null
}

output "backend_token" {
  description = "Server-to-server bearer token. Set CROWDY_BACKEND_TOKEN on the frontend server; never NEXT_PUBLIC_."
  value       = random_password.backend_token.result
  sensitive   = true
}

output "container_app_name" {
  value = var.deploy_backend ? azurerm_container_app.backend[0].name : null
}
