data "aws_region" "deployment" {}
data "aws_caller_identity" "deployment" {}

locals {
  runtime_config = {
    region             = data.aws_region.deployment.region
    environment        = var.environment
    app_image          = var.app_image
    web_image          = var.web_image
    app_s3_role_arn    = module.s3.role_arns["app"]
    worker_s3_role_arn = module.s3.role_arns["worker"]
    app_hostname       = var.app_hostname
    api_hostname       = var.api_hostname
    reviewer_cidrs     = sort(tolist(var.ingress_cidrs))
    data_volume_id     = aws_ebs_volume.data.id
    model_secret_arn   = var.model_secret_arn
    s3_bucket          = module.s3.bucket_name
  }
  user_data = templatefile("${path.module}/runtime/user-data.sh.tftpl", {
    config_b64  = base64encode(jsonencode(local.runtime_config))
    compose_b64 = filebase64("${path.module}/runtime/compose.yaml")
    refresh_b64 = filebase64("${path.module}/runtime/start.sh")
  })
}

# Fail at plan time if a release points at another account or region.
resource "terraform_data" "deployment_identity" {
  lifecycle {
    precondition {
      condition = alltrue([for image in local.runtime_images :
      image.account == data.aws_caller_identity.deployment.account_id && image.region == data.aws_region.deployment.region])
      error_message = "Both images must be in ECR in this environment's account and region."
    }
    precondition {
      condition = alltrue([for service, arn in {
        secretsmanager = var.model_secret_arn
        kms            = var.model_secret_kms_key_arn
      } : startswith(arn, "arn:aws:${service}:${data.aws_region.deployment.region}:${data.aws_caller_identity.deployment.account_id}:") if arn != null])
      error_message = "The model secret and optional KMS key must be in the environment's account and region."
    }
  }
}
