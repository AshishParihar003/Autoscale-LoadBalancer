
output "resource_group_name" {
  description = "Azure resource group containing the controller infrastructure"
  value       = azurerm_resource_group.main.name
}

output "virtual_network_id" {
  description = "Virtual network ID"
  value       = azurerm_virtual_network.main.id
}

output "subnet_id" {
  description = "Subnet ID used by the VM Scale Set"
  value       = azurerm_subnet.main.id
}

output "load_balancer_public_ip" {
  description = "Public IP address of the load balancer"
  value       = azurerm_public_ip.lb.ip_address
}

output "website_url" {
  description = "Public URL for the demo website"
  value       = "http://${azurerm_public_ip.lb.ip_address}"
}

output "vm_scale_set_id" {
  description = "Azure VM Scale Set resource ID"
  value       = azurerm_linux_virtual_machine_scale_set.main.id
}

output "vm_scale_set_capacity" {
  description = "Configured desired number of VM instances"
  value       = azurerm_linux_virtual_machine_scale_set.main.instances
}
