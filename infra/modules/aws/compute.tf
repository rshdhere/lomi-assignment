data "aws_ssm_parameter" "application_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_ebs_volume" "data" {
  availability_zone = data.aws_subnet.host.availability_zone
  type              = "gp3"
  size              = 40
  encrypted         = true
  tags = {
    Name       = "${var.name}-data"
    LomiBackup = var.name
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_instance" "app" {
  ami                         = data.aws_ssm_parameter.application_ami.value
  instance_type               = "t3.medium"
  subnet_id                   = data.aws_subnet.host.id
  vpc_security_group_ids      = [aws_security_group.app.id]
  associate_public_ip_address = true
  iam_instance_profile        = aws_iam_instance_profile.runtime.name
  user_data_base64            = base64gzip(local.user_data)
  user_data_replace_on_change = true
  tags                        = { Name = "${var.name}-app" }

  credit_specification {
    cpu_credits = "standard"
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  root_block_device {
    encrypted             = true
    volume_type           = "gp3"
    volume_size           = 24
    delete_on_termination = true
    tags                  = { Name = "${var.name}-root" }
  }

  depends_on = [
    aws_vpc_security_group_egress_rule.https,
    aws_vpc_security_group_ingress_rule.web
  ]
}

resource "aws_volume_attachment" "data" {
  instance_id                    = aws_instance.app.id
  volume_id                      = aws_ebs_volume.data.id
  device_name                    = "/dev/sdf"
  stop_instance_before_detaching = true
}
