module "s3" {
  source                            = "./s3"
  name                              = var.name
  app_hostname                      = var.app_hostname
  runtime_role_arn                  = aws_iam_role.runtime.arn
  workload_permissions_boundary_arn = var.workload_permissions_boundary_arn
}
