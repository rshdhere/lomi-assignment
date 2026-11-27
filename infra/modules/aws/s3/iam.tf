# Containers receive short-lived credentials for one document role. The host alone
# reads the model credential, signs into ECR and issues these sessions.
locals {
  document_actions = {
    app    = ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"]
    worker = ["s3:GetObjectVersion"]
  }
}

resource "aws_iam_role" "s3" {
  for_each             = local.document_actions
  name                 = "${var.name}-pdf-${each.key}"
  max_session_duration = 3600
  permissions_boundary = var.workload_permissions_boundary_arn
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { AWS = var.runtime_role_arn }
    }]
  })
}

resource "aws_iam_role_policy" "s3" {
  for_each = local.document_actions
  name     = "document-${each.key}"
  role     = aws_iam_role.s3[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = each.value
      Resource = "${aws_s3_bucket.documents.arn}/documents/*"
    }]
  })
}
