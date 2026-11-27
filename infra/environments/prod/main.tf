terraform {
  required_version = ">= 1.11, < 2.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
  backend "s3" {
    key          = "environments/prod/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = { Application = "lomi", Environment = "prod", ManagedBy = "terraform" }
  }
}

module "deployment" {
  source                            = "../../modules/aws"
  name                              = "lomi-prod"
  environment                       = "prod"
  app_hostname                      = var.app_hostname
  api_hostname                      = var.api_hostname
  zone_id                           = var.zone_id
  model_secret_arn                  = var.model_secret_arn
  model_secret_kms_key_arn          = var.model_secret_kms_key_arn
  ingress_cidrs                     = var.ingress_cidrs
  app_image                         = var.app_image
  web_image                         = var.web_image
  subnet_id                         = var.subnet_id
  workload_permissions_boundary_arn = var.workload_permissions_boundary_arn
}

output "dashboard_url" { value = module.deployment.dashboard_url }
output "api_url" { value = module.deployment.api_url }
output "instance_id" { value = module.deployment.instance_id }
output "public_ip" { value = module.deployment.public_ip }
output "data_volume_id" { value = module.deployment.data_volume_id }
output "documents_bucket" { value = module.deployment.documents_bucket }
