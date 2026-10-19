
variable "subscription_id" {
  description = "Azure subscription ID"
  type        = string
}

variable "location" {
  description = "Azure region"
  type        = string
  default     = "centralindia"
}

variable "resource_group_name" {
  description = "Resource group for our demo"
  type        = string
  default     = "autoscale-demo-rg"
}

variable "project_name" {
  description = "Name prefix for our project resources"
  type        = string
  default     = "autoscale-demo"
}
variable "vm_size" {
  type = string
}
variable "availability_zone" {
  type    = string
  default = "3"

}
variable "admin_username" {
  type = string
}
variable "os_publisher" {
  type = string
}
variable "os_offer" {
  type = string
}
variable "os_sku" {
  type = string
}
variable "os_version" {
  type = string
}
variable "admin_ssh_source_cidr" {
  description = "Public IP CIDR allowed to connect through SSH"
  type        = string

  validation {
    condition     = can(cidrnetmask(var.admin_ssh_source_cidr))
    error_message = "Enter a valid IPv4 CIDR, for example 203.0.113.25/32."
  }
}

variable "admin_ssh_public_key" {
  description = "SSH public key used to access the Ubuntu VM"
  type        = string
  sensitive   = true
}

variable "vm_count" {
  description = "Desides the no of vm"
  type        = number
  default     = 0

  validation {
    condition     = var.vm_count >= 0 && var.vm_count <= 5
    error_message = "vm_count must be between 0 and 5."
  }

}