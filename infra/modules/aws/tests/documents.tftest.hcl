# Exercise the S3 child directly so its public outputs stay limited to the
# identifiers the host needs. All mutations here are hypothetical plans.
mock_provider "aws" {
  mock_resource "aws_s3_bucket" {
    override_during = plan
    defaults = {
      id     = "test-review-pdfs"
      bucket = "test-review-pdfs"
      arn    = "arn:aws:s3:::test-review-pdfs"
    }
  }
}

run "private_versioned_document_storage" {
  command = plan

  module {
    source = "./s3"
  }

  variables {
    name             = "test-review"
    app_hostname     = "review.example.test"
    runtime_role_arn = "arn:aws:iam::123456789012:role/test-review-runtime"
  }

  override_resource {
    target          = aws_iam_role.s3["app"]
    override_during = plan
    values = {
      id  = "test-review-pdf-app"
      arn = "arn:aws:iam::123456789012:role/test-review-pdf-app"
    }
  }
  override_resource {
    target          = aws_iam_role.s3["worker"]
    override_during = plan
    values = {
      id  = "test-review-pdf-worker"
      arn = "arn:aws:iam::123456789012:role/test-review-pdf-worker"
    }
  }

  assert {
    condition = (
      aws_s3_bucket_public_access_block.documents.block_public_acls &&
      aws_s3_bucket_public_access_block.documents.ignore_public_acls &&
      aws_s3_bucket_public_access_block.documents.block_public_policy &&
      aws_s3_bucket_public_access_block.documents.restrict_public_buckets &&
      one(aws_s3_bucket_versioning.documents.versioning_configuration).status == "Enabled" &&
      one(aws_s3_bucket_ownership_controls.documents.rule).object_ownership == "BucketOwnerEnforced" &&
      one(one(aws_s3_bucket_server_side_encryption_configuration.documents.rule).apply_server_side_encryption_by_default).sse_algorithm == "AES256"
    )
    error_message = "The bucket must keep private, encrypted, bucket-owned versions of the uploaded PDFs."
  }

  assert {
    condition = (
      toset(one(aws_s3_bucket_cors_configuration.documents.cors_rule).allowed_origins) == toset(["https://${var.app_hostname}"]) &&
      toset(one(aws_s3_bucket_cors_configuration.documents.cors_rule).allowed_methods) == toset(["POST"])
    )
    error_message = "Browser upload CORS must grant signed POSTs only from the configured HTTPS dashboard."
  }

  assert {
    condition = (
      one(jsondecode(aws_s3_bucket_policy.documents.policy).Statement).Effect == "Deny" &&
      one(jsondecode(aws_s3_bucket_policy.documents.policy).Statement).Principal == "*" &&
      one(jsondecode(aws_s3_bucket_policy.documents.policy).Statement).Action == "s3:*" &&
      one(jsondecode(aws_s3_bucket_policy.documents.policy).Statement).Condition.Bool["aws:SecureTransport"] == "false" &&
      toset(one(jsondecode(aws_s3_bucket_policy.documents.policy).Statement).Resource) == toset([aws_s3_bucket.documents.arn, "${aws_s3_bucket.documents.arn}/*"])
    )
    error_message = "The bucket policy must deny insecure requests to the bucket and its objects."
  }

  assert {
    condition = (
      toset(one(jsondecode(aws_iam_role_policy.s3["worker"].policy).Statement).Action) == toset(["s3:GetObjectVersion"]) &&
      toset(one(jsondecode(aws_iam_role_policy.s3["app"].policy).Statement).Action) == toset(["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"]) &&
      alltrue([for name, policy in aws_iam_role_policy.s3 :
        policy.role == aws_iam_role.s3[name].id &&
        one(jsondecode(policy.policy).Statement).Effect == "Allow" &&
        one(jsondecode(policy.policy).Statement).Resource == "${aws_s3_bucket.documents.arn}/documents/*"
      ])
    )
    error_message = "The worker may read pinned versions. The API may upload and verify PDFs. Both grants must target only the documents prefix."
  }

  assert {
    condition = alltrue([for role in aws_iam_role.s3 :
      role.max_session_duration == 3600 &&
      one(jsondecode(role.assume_role_policy).Statement).Effect == "Allow" &&
      one(jsondecode(role.assume_role_policy).Statement).Action == "sts:AssumeRole" &&
      one(jsondecode(role.assume_role_policy).Statement).Principal == { AWS = var.runtime_role_arn }
    ])
    error_message = "Only the runtime role may assume either document role for a short-lived session."
  }

  assert {
    condition = (
      output.bucket_name == aws_s3_bucket.documents.bucket &&
      output.role_arns == tomap({ app = aws_iam_role.s3["app"].arn, worker = aws_iam_role.s3["worker"].arn })
    )
    error_message = "Return the created bucket and correctly assigned document role ARNs to the host."
  }
}
