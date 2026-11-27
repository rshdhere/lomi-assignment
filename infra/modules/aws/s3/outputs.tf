output "bucket_name" {
  description = "Private document bucket ready for versioned uploads."
  value       = aws_s3_bucket.documents.bucket
  depends_on = [
    aws_s3_bucket_public_access_block.documents,
    aws_s3_bucket_ownership_controls.documents,
    aws_s3_bucket_versioning.documents,
    aws_s3_bucket_server_side_encryption_configuration.documents,
    aws_s3_bucket_cors_configuration.documents,
    aws_s3_bucket_policy.documents,
  ]
}

output "role_arns" {
  description = "Document role ARNs keyed by app and worker."
  value       = tomap({ for name, role in aws_iam_role.s3 : name => role.arn })
  depends_on  = [aws_iam_role_policy.s3]
}
