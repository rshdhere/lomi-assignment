variable "account_id" {
  type = string
}
variable "region" {
  type    = string
  default = "ap-south-1"
}
variable "app_hostname" {
  type = string
}
variable "api_hostname" {
  type = string
}
variable "zone_id" {
  default = null
  type    = string
}
variable "model_secret_arn" {
  type = string
}
variable "model_secret_kms_key_arn" {
  type    = string
  default = null
}
variable "subnet_id" {
  type = string
}
variable "ingress_cidrs" {
  type = set(string)
}
variable "app_image" {
  type = string
}
variable "web_image" {
  type = string
}

variable "workload_permissions_boundary_arn" {
  description = "Administrator-managed IAM permissions boundary for all four workload roles."
  type        = string
  default     = null
}
