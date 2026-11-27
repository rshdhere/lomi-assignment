# Exercise both profiles using local mock providers and plans only.
mock_provider "aws" {
  mock_data "aws_subnet" {
    override_during = plan
    defaults = {
      id                = "subnet-0aaa0000000000001"
      vpc_id            = "vpc-0aaa0000000000001"
      availability_zone = "us-east-1a"
      cidr_block        = "10.44.0.0/24"
    }
  }
  mock_data "aws_route_tables" {
    override_during = plan
    defaults        = { ids = [] }
  }
  mock_data "aws_vpc" {
    override_during = plan
    defaults        = { main_route_table_id = "rtb-0aaa0000000000001" }
  }
  mock_data "aws_internet_gateway" {
    override_during = plan
    defaults        = { id = "igw-0aaa0000000000001" }
  }
  mock_data "aws_caller_identity" {
    override_during = plan
    defaults        = { account_id = "123456789012" }
  }
  mock_data "aws_region" {
    override_during = plan
    defaults        = { region = "us-east-1" }
  }
  mock_data "aws_ssm_parameter" {
    override_during = plan
    defaults        = { value = "ami-0123456789abcdef0" }
  }
}

# Exercise the host's boundary against known outputs. documents.tftest.hcl
# plans the real child configuration and checks the policies it generates.
override_module {
  target          = module.s3
  override_during = plan
  outputs = {
    bucket_name = "test-review-pdfs"
    role_arns = {
      app    = "arn:aws:iam::123456789012:role/test-pdf-app"
      worker = "arn:aws:iam::123456789012:role/test-pdf-worker"
    }
  }
}

# Stable IDs allow the plan to prove that the replacement host reattaches the
# same volume and address. Separate resources own their lifetimes.
override_resource {
  target          = aws_instance.app
  override_during = plan
  values          = { id = "i-0123456789abcdef0" }
}
override_resource {
  target          = aws_ebs_volume.data
  override_during = plan
  values          = { id = "vol-0123456789abcdef0" }
}
override_resource {
  target          = aws_eip.app
  override_during = plan
  values          = { id = "eipalloc-0123456789abcdef0", public_ip = "192.0.2.1" }
}

variables {
  name             = "lomi-staging"
  environment      = "staging"
  subnet_id        = "subnet-0aaa0000000000001"
  app_hostname     = "review.staging.example.test"
  api_hostname     = "api.staging.example.test"
  zone_id          = null
  model_secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:lomi-model-AbCdEf"
  ingress_cidrs    = ["192.0.2.0/24"]
  app_image        = "123456789012.dkr.ecr.us-east-1.amazonaws.com/lomi/staging/app@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  web_image        = "123456789012.dkr.ecr.us-east-1.amazonaws.com/lomi/staging/web@sha256:1111111111111111111111111111111111111111111111111111111111111111"
}

run "staging_single_host" {
  command = plan

  assert {
    condition = (
      data.aws_route.public_default.route_table_id == "rtb-0aaa0000000000001" &&
      data.aws_route.public_default.gateway_id == "igw-0aaa0000000000001" &&
      data.aws_route.public_default.destination_cidr_block == "0.0.0.0/0"
    )
    error_message = "A subnet without an explicit association must use the VPC main table's IPv4 default route to its internet gateway."
  }
  assert {
    condition = (
      aws_instance.app.instance_type == "t3.medium" && aws_instance.app.subnet_id == var.subnet_id &&
      aws_security_group.app.vpc_id == data.aws_subnet.host.vpc_id &&
      aws_eip_association.app.allocation_id == aws_eip.app.id &&
      aws_eip_association.app.instance_id == aws_instance.app.id &&
      length(aws_route53_record.service) == 0
    )
    error_message = "The budget profile requires one t3.medium in the selected subnet with its reusable EIP."
  }
  assert {
    condition = (
      aws_instance.app.user_data_replace_on_change && aws_volume_attachment.data.stop_instance_before_detaching &&
      one(aws_instance.app.root_block_device).encrypted && one(aws_instance.app.root_block_device).delete_on_termination &&
      aws_ebs_volume.data.encrypted &&
      aws_ebs_volume.data.type == "gp3" && aws_ebs_volume.data.availability_zone == data.aws_subnet.host.availability_zone &&
      aws_volume_attachment.data.volume_id == aws_ebs_volume.data.id &&
      aws_volume_attachment.data.instance_id == aws_instance.app.id &&
      aws_volume_attachment.data.device_name == "/dev/sdf"
    )
    error_message = "Postgres and Redis need a separate encrypted data disk attached in the host AZ."
  }
  assert {
    condition = (
      toset(keys(aws_vpc_security_group_ingress_rule.web)) == toset(["80", "443"]) &&
      alltrue([for port, rule in aws_vpc_security_group_ingress_rule.web :
        rule.ip_protocol == "tcp" && rule.from_port == tonumber(port) && rule.to_port == tonumber(port)
      ]) &&
      one(aws_instance.app.metadata_options).http_tokens == "required" &&
      one(aws_instance.app.metadata_options).http_put_response_hop_limit == 1
    )
    error_message = "Only HTTP and HTTPS may reach the host. SSH and database ports must stay closed and IMDSv2 must be host-only."
  }
  assert {
    condition = (
      aws_dlm_lifecycle_policy.data.state == "ENABLED" &&
      one(aws_dlm_lifecycle_policy.data.policy_details).target_tags["LomiBackup"] == aws_ebs_volume.data.tags["LomiBackup"] &&
      one(one(one(aws_dlm_lifecycle_policy.data.policy_details).schedule).retain_rule).count == 3
    )
    error_message = "The staging data volume requires three retained snapshots."
  }
  assert {
    condition = (
      output.documents_bucket == module.s3.bucket_name &&
      local.runtime_config.s3_bucket == module.s3.bucket_name &&
      local.runtime_config.app_s3_role_arn == module.s3.role_arns.app &&
      local.runtime_config.worker_s3_role_arn == module.s3.role_arns.worker
    )
    error_message = "The host must receive the child's bucket and each container's own S3 role."
  }
  assert {
    condition = toset(one([
      for statement in jsondecode(aws_iam_role_policy.runtime.policy).Statement : statement.Resource
      if statement.Action == "sts:AssumeRole" && statement.Effect == "Allow"
    ])) == toset(values(module.s3.role_arns))
    error_message = "The host must assume only the two document roles supplied by the storage module."
  }
}

run "production_snapshot_retention" {
  command = plan

  override_data {
    target          = data.aws_route_tables.explicit
    override_during = plan
    values          = { ids = ["rtb-0bbb0000000000002"] }
  }
  assert {
    condition = (
      data.aws_route.public_default.route_table_id == "rtb-0bbb0000000000002" &&
      data.aws_route.public_default.gateway_id == "igw-0aaa0000000000001" &&
      data.aws_route.public_default.destination_cidr_block == "0.0.0.0/0"
    )
    error_message = "Explicit subnet routing must take precedence over the VPC main route table and use an IPv4 default route to the attached internet gateway."
  }
  variables {
    name         = "lomi-prod"
    environment  = "prod"
    app_hostname = "review.example.test"
    api_hostname = "api.example.test"
    zone_id      = "Z00000000000000000001"
    app_image    = "123456789012.dkr.ecr.us-east-1.amazonaws.com/lomi/prod/app@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    web_image    = "123456789012.dkr.ecr.us-east-1.amazonaws.com/lomi/prod/web@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }
  assert {
    condition = (
      aws_instance.app.instance_type == "t3.medium" &&
      aws_dlm_lifecycle_policy.data.state == "ENABLED" &&
      one(one(one(aws_dlm_lifecycle_policy.data.policy_details).schedule).create_rule).interval == 24 &&
      one(one(one(aws_dlm_lifecycle_policy.data.policy_details).schedule).retain_rule).count == 7
    )
    error_message = "Production should retain seven daily snapshots on the same single-host budget."
  }
  assert {
    condition = (
      toset(keys(aws_route53_record.service)) == toset(["app", "api"]) &&
      alltrue([for record in aws_route53_record.service : toset(record.records) == toset([aws_eip.app.public_ip])])
    )
    error_message = "Both production hostnames must resolve to the application Elastic IP."
  }
}
