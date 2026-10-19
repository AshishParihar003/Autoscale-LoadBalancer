
resource "azurerm_resource_group" "main" {
  name     = var.resource_group_name
  location = var.location

  tags = {
    project    = var.project_name
    managed_by = "terraform"
  }
}

# -------------------------
# Networking
# -------------------------

resource "azurerm_virtual_network" "main" {
  name                = "${var.project_name}-vnet"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  address_space       = ["10.20.0.0/16"]

  tags = {
    project = var.project_name
  }
}

resource "azurerm_subnet" "main" {
  name                 = "${var.project_name}-subnet"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.20.1.0/24"]
}

resource "azurerm_network_security_group" "main" {
  name                = "${var.project_name}-nsg"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  security_rule {
    name                       = "Allow-HTTP"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "80"
    source_address_prefix      = "Internet"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "Allow-SSH-Restricted"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = var.admin_ssh_source_cidr
    destination_address_prefix = "*"
  }

  tags = {
    project = var.project_name
  }
}

resource "azurerm_subnet_network_security_group_association" "main" {
  subnet_id                 = azurerm_subnet.main.id
  network_security_group_id = azurerm_network_security_group.main.id
}

# -------------------------
# Public Load Balancer
# -------------------------

resource "azurerm_public_ip" "lb" {
  name                = "${var.project_name}-lb-public-ip"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  allocation_method   = "Static"
  sku                 = "Standard"

  tags = {
    project = var.project_name
  }
}

resource "azurerm_lb" "main" {
  name                = "${var.project_name}-lb"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "Standard"

  frontend_ip_configuration {
    name                 = "public"
    public_ip_address_id = azurerm_public_ip.lb.id
  }

  tags = {
    project = var.project_name
  }
}

resource "azurerm_lb_backend_address_pool" "main" {
  name            = "${var.project_name}-backend-pool"
  loadbalancer_id = azurerm_lb.main.id
}

resource "azurerm_lb_probe" "http" {
  name            = "http-health-probe"
  loadbalancer_id = azurerm_lb.main.id
  protocol        = "Tcp"
  port            = 80
}

resource "azurerm_lb_rule" "http" {
  name                           = "http-rule"
  loadbalancer_id                = azurerm_lb.main.id
  protocol                       = "Tcp"
  frontend_port                  = 80
  backend_port                   = 80
  frontend_ip_configuration_name = "public"
  backend_address_pool_ids       = [azurerm_lb_backend_address_pool.main.id]
  probe_id                       = azurerm_lb_probe.http.id
  disable_outbound_snat          = true
}

# Allow VM instances to reach package repositories and other
# public endpoints using the load balancer's outbound rule.
resource "azurerm_lb_outbound_rule" "main" {
  name                     = "vmss-outbound"
  loadbalancer_id          = azurerm_lb.main.id
  protocol                 = "All"
  backend_address_pool_id  = azurerm_lb_backend_address_pool.main.id
  allocated_outbound_ports = 1024
  tcp_reset_enabled        = true
  idle_timeout_in_minutes  = 15

  frontend_ip_configuration {
    name = "public"
  }
}

# -------------------------
# Linux Virtual Machine Scale Set
# -------------------------

resource "azurerm_linux_virtual_machine_scale_set" "main" {
  name                = "${var.project_name}-vmss"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location

  sku       = var.vm_size
  instances = var.vm_count
  zones     = [var.availability_zone]

  admin_username                  = var.admin_username
  disable_password_authentication = true
  upgrade_mode                    = "Manual"
  overprovision                   = false

  admin_ssh_key {
    username   = var.admin_username
    public_key = var.admin_ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
  }

  source_image_reference {
    publisher = var.os_publisher
    offer     = var.os_offer
    sku       = var.os_sku
    version   = var.os_version
  }

  network_interface {
    name    = "${var.project_name}-vmss-nic"
    primary = true

    ip_configuration {
      name      = "internal"
      primary   = true
      subnet_id = azurerm_subnet.main.id

      load_balancer_backend_address_pool_ids = [
        azurerm_lb_backend_address_pool.main.id
      ]
    }
  }

  custom_data = base64encode(<<-CLOUDINIT
    #cloud-config
    package_update: true
    packages:
      - nginx
    write_files:
      - path: /var/www/html/index.html
        permissions: "0644"
        content: |
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>AutoScale Cloud Controller</title>
          </head>
          <body>
            <h1>AutoScale Cloud Controller</h1>
            <p>Website served by an Azure VM Scale Set instance.</p>
          </body>
          </html>
    runcmd:
      - systemctl enable --now nginx
  CLOUDINIT
  )

  tags = {
    project    = var.project_name
    managed_by = "terraform"
  }
}
