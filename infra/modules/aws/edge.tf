resource "aws_eip" "app" {
  domain = "vpc"
  tags   = { Name = "${var.name}-app" }
}

resource "aws_eip_association" "app" {
  allocation_id = aws_eip.app.id
  instance_id   = aws_instance.app.id
}

resource "aws_route53_record" "service" {
  for_each = var.zone_id == null ? {} : { app = var.app_hostname, api = var.api_hostname }
  zone_id  = var.zone_id
  name     = each.value
  type     = "A"
  ttl      = 300
  records  = [aws_eip.app.public_ip]
}
