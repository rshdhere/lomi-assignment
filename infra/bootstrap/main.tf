terraform {
  required_version = ">= 1.11, < 2.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

variable "account_id" {
  type        = string
  description = "AWS account allowed to own the state and registries."
}
variable "region" { type = string }
variable "environments" {
  type    = set(string)
  default = ["staging"]
  validation {
    condition     = length(var.environments) > 0 && alltrue([for e in var.environments : contains(["staging", "prod"], e)])
    error_message = "Select staging, prod or both. Use separate AWS accounts where available."
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = { Application = "lomi", ManagedBy = "terraform", Stack = "bootstrap" }
  }
}

resource "aws_s3_bucket" "state" {
  for_each = var.environments
  bucket   = "lomi-${each.key}-tfstate-${var.account_id}-${var.region}"
  tags     = { Environment = each.key }
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_ownership_controls" "state" {
  for_each = aws_s3_bucket.state
  bucket   = each.value.id
  rule { object_ownership = "BucketOwnerEnforced" }
}
resource "aws_s3_bucket_public_access_block" "state" {
  for_each                = aws_s3_bucket.state
  bucket                  = each.value.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "state" {
  for_each = aws_s3_bucket.state
  bucket   = each.value.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  for_each = aws_s3_bucket.state
  bucket   = each.value.id
  rule {
    bucket_key_enabled = true
    apply_server_side_encryption_by_default { sse_algorithm = "aws:kms" }
  }
}
resource "aws_s3_bucket_policy" "state" {
  for_each = aws_s3_bucket.state
  bucket   = each.value.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "RequireTLS", Effect = "Deny", Principal = "*", Action = "s3:*",
      Resource = [each.value.arn, "${each.value.arn}/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

locals {
  repositories = { for pair in setproduct(var.environments, ["app", "web"]) : "lomi/${pair[0]}/${pair[1]}" => pair[0] }
}
resource "aws_ecr_repository" "release" {
  for_each             = local.repositories
  name                 = each.key
  image_tag_mutability = "IMMUTABLE"
  tags                 = { Environment = each.value }
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "AES256" }
  lifecycle { prevent_destroy = true }
}
output "state_buckets" { value = { for k, b in aws_s3_bucket.state : k => b.id } }
output "repositories" { value = { for k, r in aws_ecr_repository.release : k => r.repository_url } }
