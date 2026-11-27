# The caller supplies a subnet with an IPv4 default route to an internet gateway.
# Assigning a public IP explicitly also supports subnets with auto-assignment disabled.
data "aws_subnet" "host" {
  id = var.subnet_id
}

# A subnet with no explicit association inherits the VPC's main route table.
data "aws_route_tables" "explicit" {
  vpc_id = data.aws_subnet.host.vpc_id
  filter {
    name   = "association.subnet-id"
    values = [data.aws_subnet.host.id]
  }
}

data "aws_vpc" "host" {
  id = data.aws_subnet.host.vpc_id
}

data "aws_internet_gateway" "host" {
  filter {
    name   = "attachment.vpc-id"
    values = [data.aws_subnet.host.vpc_id]
  }
}

# This lookup fails during planning if the selected subnet's IPv4 default
# route is missing or points anywhere other than the VPC's attached IGW.
data "aws_route" "public_default" {
  route_table_id         = coalesce(one(data.aws_route_tables.explicit.ids), data.aws_vpc.host.main_route_table_id)
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = data.aws_internet_gateway.host.id
}

resource "aws_security_group" "app" {
  name_prefix = "${var.name}-web-"
  description = "Caddy HTTP certificate challenges and HTTPS service"
  vpc_id      = data.aws_subnet.host.vpc_id
  depends_on  = [data.aws_route.public_default]
}

resource "aws_vpc_security_group_ingress_rule" "web" {
  for_each          = toset(["80", "443"])
  security_group_id = aws_security_group.app.id
  ip_protocol       = "tcp"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.app.id
  description       = "AWS services, HTTPS package mirrors, ACME and model provider"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}
