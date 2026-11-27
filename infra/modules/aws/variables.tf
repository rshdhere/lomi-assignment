variable "name" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}[a-z0-9]$", var.name))
    error_message = "Use a lowercase resource prefix of 3 through 22 characters."
  }
}

variable "environment" {
  type = string
  validation {
    condition     = contains(["staging", "prod"], var.environment)
    error_message = "Use staging or prod."
  }
}

variable "subnet_id" {
  type        = string
  description = "Existing IPv4 public subnet with a default route through an internet gateway."
  validation {
    condition     = can(regex("^subnet-[a-f0-9]+$", var.subnet_id))
    error_message = "Supply an existing subnet ID in the target region."
  }
}

variable "app_hostname" {
  type = string
}
variable "api_hostname" {
  type = string
  validation {
    condition     = var.api_hostname != var.app_hostname && alltrue([for host in [var.api_hostname, var.app_hostname] : can(regex("^[a-z0-9][a-z0-9.-]+\\.[a-z]{2,}$", host))])
    error_message = "Use two distinct lowercase DNS names without scheme or port."
  }
}
variable "zone_id" {
  description = "Optional existing public Route 53 zone for both A records."
  default     = null
  type        = string
}
variable "model_secret_arn" {
  type = string
}
variable "model_secret_kms_key_arn" {
  type    = string
  default = null
}
variable "ingress_cidrs" {
  type = set(string)
  validation {
    condition = length(var.ingress_cidrs) > 0 && alltrue([for cidr in var.ingress_cidrs :
      can(cidrnetmask(cidr)) && try(tonumber(split("/", cidr)[1]) > 0 && cidrhost(cidr, 0) == split("/", cidr)[0], false)
    ])
    error_message = "Use IPv4 network addresses with a prefix length of 1 to 32. Use /32 for a single reviewer address."
  }
}
variable "app_image" {
  type = string
}
variable "web_image" {
  type = string
  validation {
    condition     = alltrue([for image in [var.app_image, var.web_image] : can(regex("^[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$", image))])
    error_message = "Use immutable private ECR image URLs with a sha256 digest for both images."
  }
}

variable "workload_permissions_boundary_arn" {
  description = "Administrator-managed IAM permissions boundary for all four workload roles."
  type        = string
  default     = null
}
