locals {
  snapshot_arn = "arn:aws:ec2:${data.aws_region.deployment.region}::snapshot/*"
}

resource "aws_iam_role" "snapshots" {
  name                 = "${var.name}-data-snapshots"
  permissions_boundary = var.workload_permissions_boundary_arn
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "dlm.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.deployment.account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:dlm:${data.aws_region.deployment.region}:${data.aws_caller_identity.deployment.account_id}:policy/*" }
      }
    }]
  })
}

resource "aws_iam_role_policy" "snapshots" {
  name = "daily-data-volume-snapshots"
  role = aws_iam_role.snapshots.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Action    = ["ec2:DescribeVolumes", "ec2:DescribeSnapshots", "ec2:DescribeInstances", "ec2:DescribeAvailabilityZones"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = data.aws_region.deployment.region } }
      },
      {
        Effect   = "Allow"
        Action   = "ec2:CreateSnapshot"
        Resource = [aws_ebs_volume.data.arn, local.snapshot_arn]
      },
      {
        Effect   = "Allow"
        Action   = "ec2:CreateTags"
        Resource = local.snapshot_arn
      },
      {
        Effect    = "Allow"
        Action    = "ec2:DeleteSnapshot"
        Resource  = local.snapshot_arn
        Condition = { StringEquals = { "ec2:ResourceTag/LomiBackup" = var.name } }
      },
      {
        Effect   = "Allow"
        Action   = ["events:PutRule", "events:DeleteRule", "events:DescribeRule", "events:EnableRule", "events:DisableRule", "events:ListTargetsByRule", "events:PutTargets", "events:RemoveTargets"]
        Resource = "arn:aws:events:${data.aws_region.deployment.region}:${data.aws_caller_identity.deployment.account_id}:rule/AwsDataLifecycleRule.managed-cwe.*"
      }
    ]
  })
}

resource "aws_dlm_lifecycle_policy" "data" {
  description        = "Daily crash-consistent snapshots of the ${var.name} data volume"
  execution_role_arn = aws_iam_role.snapshots.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]
    target_tags    = { LomiBackup = var.name }

    schedule {
      name        = "daily-data-backup"
      tags_to_add = { LomiBackup = var.name }

      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["03:00"]
      }

      retain_rule {
        count = var.environment == "prod" ? 7 : 3
      }
    }
  }
  depends_on = [aws_iam_role_policy.snapshots]
}
