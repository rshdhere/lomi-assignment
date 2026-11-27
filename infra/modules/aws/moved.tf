# Keep existing document storage and its access roles when upgrading to the S3 child module.
moved {
  from = aws_s3_bucket.documents
  to   = module.s3.aws_s3_bucket.documents
}

moved {
  from = aws_s3_bucket_public_access_block.documents
  to   = module.s3.aws_s3_bucket_public_access_block.documents
}

moved {
  from = aws_s3_bucket_ownership_controls.documents
  to   = module.s3.aws_s3_bucket_ownership_controls.documents
}

moved {
  from = aws_s3_bucket_versioning.documents
  to   = module.s3.aws_s3_bucket_versioning.documents
}

moved {
  from = aws_s3_bucket_server_side_encryption_configuration.documents
  to   = module.s3.aws_s3_bucket_server_side_encryption_configuration.documents
}

moved {
  from = aws_s3_bucket_cors_configuration.documents
  to   = module.s3.aws_s3_bucket_cors_configuration.documents
}

moved {
  from = aws_s3_bucket_policy.documents
  to   = module.s3.aws_s3_bucket_policy.documents
}

moved {
  from = aws_iam_role.s3
  to   = module.s3.aws_iam_role.s3
}

moved {
  from = aws_iam_role_policy.s3
  to   = module.s3.aws_iam_role_policy.s3
}
