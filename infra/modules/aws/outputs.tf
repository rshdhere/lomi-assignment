output "dashboard_url" { value = "https://${var.app_hostname}" }
output "api_url" { value = "https://${var.api_hostname}" }
output "instance_id" { value = aws_instance.app.id }
output "public_ip" { value = aws_eip.app.public_ip }
output "data_volume_id" { value = aws_ebs_volume.data.id }
output "documents_bucket" { value = module.s3.bucket_name }
