subscription_id = "1ad03871-1b64-40bc-860e-9e3935ba2088"
location        = "centralindia"

vm_size             = "Standard_B2ats_v2"
resource_group_name = "autoscale-demo-rg"
admin_username      = "azureuser"

os_publisher          = "Canonical"
os_offer              = "0001-com-ubuntu-server-jammy"
os_sku                = "22_04-lts-gen2"
os_version            = "latest"
admin_ssh_public_key  = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAbszx0bGrDsIu+C1stwwNXSPEF9BNXu4+dvxXoZS/LZ autoscale-controller"
availability_zone     = "3"
admin_ssh_source_cidr = "152.58.56.11/32"
vm_count = 1