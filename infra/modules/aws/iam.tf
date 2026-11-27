locals {
  runtime_images = [
    for image in distinct([var.app_image, var.web_image]) :
    regex("^(?P<account>[0-9]{12})[.]dkr[.]ecr[.](?P<region>[a-z0-9-]+)[.]amazonaws[.]com/(?P<repository>[a-z0-9._/-]+)@sha256:[a-f0-9]{64}$", image)
  ]
  runtime_repositories = distinct([
    for image in local.runtime_images :
    "arn:aws:ecr:${image.region}:${image.account}:repository/${image.repository}"
  ])
}

resource "aws_iam_role" "runtime" {
  name                 = "${var.name}-runtime"
  permissions_boundary = var.workload_permissions_boundary_arn
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "session_manager" {
  role       = aws_iam_role.runtime.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "runtime" {
  name = "application-runtime"
  role = aws_iam_role.runtime.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Sid      = "ObtainRegistryToken"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
        Condition = {
          StringEquals = { "aws:RequestedRegion" = distinct([for image in local.runtime_images : image.region]) }
        }
      },
      {
        Sid      = "PullApplicationImages"
        Effect   = "Allow"
        Action   = ["ecr:BatchGetImage", "ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer"]
        Resource = local.runtime_repositories
      },
      {
        Sid      = "ReadModelCredential"
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = var.model_secret_arn
      },
      {
        Sid      = "IssueShortLivedDocumentCredentials"
        Effect   = "Allow"
        Action   = "sts:AssumeRole"
        Resource = values(module.s3.role_arns)
      },
      ], var.model_secret_kms_key_arn == null ? [] : [{
        Sid      = "DecryptOnlyTheModelCredential"
        Effect   = "Allow"
        Action   = "kms:Decrypt"
        Resource = var.model_secret_kms_key_arn
        Condition = {
          StringEquals = {
            "kms:ViaService"                  = "secretsmanager.${split(":", var.model_secret_arn)[3]}.amazonaws.com"
            "kms:EncryptionContext:SecretARN" = var.model_secret_arn
          }
        }
    }])
  })
}

resource "aws_iam_instance_profile" "runtime" {
  name       = "${var.name}-runtime"
  role       = aws_iam_role.runtime.name
  depends_on = [aws_iam_role_policy.runtime, aws_iam_role_policy_attachment.session_manager]
}
