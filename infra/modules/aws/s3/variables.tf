variable "name" {
  type        = string
  description = "Environment prefix used in the bucket and document role names."
}

variable "app_hostname" {
  type        = string
  description = "Dashboard hostname allowed to submit signed S3 POST forms over HTTPS."
}

variable "runtime_role_arn" {
  type        = string
  description = "EC2 host role allowed to assume the application and worker document roles."
}

variable "workload_permissions_boundary_arn" {
  description = "Administrator-managed IAM permissions boundary for all four workload roles."
  type        = string
  default     = null
}
