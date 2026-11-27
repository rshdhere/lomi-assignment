# Deploy Lomi on one EC2 instance

Staging and production are independent Terraform roots. **Apply staging alone to run one server.** Applying production as well runs a second server with its own data and billing.

For a first deployment before committing to Git, follow the [manual staging walkthrough](first-staging-deploy.md) and its [exact staging IAM policy JSON and setup commands](bootstrap/staging-iam/README.md). After bootstrapping the account, you can publish images, apply Terraform and verify the host through separate GitHub Actions workflows for staging and production. [Configure CI/CD](github-actions.md)

| Component        | Per deployed environment                                                                                                                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compute          | One `t3.medium` with standard CPU credits. The dashboard, API, one extraction worker, PostgreSQL with pgvector, Redis, and Caddy share the instance.                                                                                                            |
| Network          | One existing public subnet, one Elastic IP and a security group. The module looks up the subnet and verifies its IPv4 default route leads to the VPC's internet gateway. A public subnet in the account's default VPC works.                                    |
| HTTPS and access | Caddy obtains and renews certificates for the dashboard and API. Ports 80 and 443 are public for certificate validation. Caddy restricts document access on both hostnames to the configured reviewer IP ranges. Operators connect through SSM Session Manager. |
| Data             | 24 GiB encrypted gp3 root disk and a separate encrypted 40 GiB gp3 data disk for database files, local credentials and TLS state. PDFs use a private versioned S3 bucket. Daily EBS snapshots retain three recovery points in staging and seven in production.  |
| Availability     | A host outage, update or replacement interrupts the whole application. The replacement reattaches the same data disk and Elastic IP.                                                                                                                            |

The stacks create no VPC, NAT gateway, load balancer, RDS instance or ElastiCache cluster. Recurring costs include EC2, EBS, snapshots, the public IPv4 address, stored images and documents, secret storage, traffic and model calls. Stopping EC2 pauses compute charges. The allocated IP and stored data still incur charges. Standard CPU credits limit sustained performance when the balance runs low. [AWS default VPC](https://docs.aws.amazon.com/vpc/latest/userguide/default-vpc.html) · [CPU credit behavior](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-performance-instances-standard-mode.html) · [IPv4 pricing](https://aws.amazon.com/vpc/pricing/)

The AWS module delegates the document bucket and the API and worker object-access roles to its S3 child module. The parent supplies the bucket naming prefix, dashboard hostname and runtime role ARN. Existing deployments pick up the new resource addresses through Terraform `moved` blocks during the next plan and apply. Review the plan for address moves that retain the existing bucket, objects and roles. [Document storage module and local MinIO configuration](modules/aws/s3/README.md)

## 1. Bootstrap staging

Use Terraform 1.11 or newer within 1.x and AWS CLI v2. These commands run from the repository root. Set the account you intend to deploy into and check the identity before planning.

```sh
export AWS_PROFILE=your-staging-profile
export AWS_REGION=ap-south-1
export AWS_ACCOUNT_ID=123456789012
aws sts get-caller-identity
cp infra/bootstrap/terraform.tfvars.example infra/bootstrap/terraform.tfvars
```

Edit the bootstrap variables with the real account and region. The default creates a private, versioned state bucket and two immutable ECR repositories for staging. This step starts no compute.

```sh
terraform -chdir=infra/bootstrap init
terraform -chdir=infra/bootstrap plan -out=bootstrap.tfplan
terraform -chdir=infra/bootstrap apply bootstrap.tfplan
terraform -chdir=infra/bootstrap output
cp infra/environments/staging/backend.tfbackend.example infra/environments/staging/backend.tfbackend
cp infra/environments/staging/terraform.tfvars.example infra/environments/staging/terraform.tfvars
```

Edit `backend.tfbackend` to match the bucket from the bootstrap output, account, region and AWS-managed S3 key. To move the initial local bootstrap state into that same bucket, run the following once. The bootstrap and application have distinct state keys. Restrict operator access to the state, saved plans, KMS key and native S3 lockfiles. [S3 backend permissions](https://developer.hashicorp.com/terraform/language/backend/s3)

```sh
cp infra/bootstrap/backend.tf.example infra/bootstrap/backend.tf
terraform -chdir=infra/bootstrap init -migrate-state -backend-config=../environments/staging/backend.tfbackend
```

## 2. Configure access and publish the release

In staging's `terraform.tfvars`, set the following.

- **Subnet.** Supply an existing public IPv4 subnet in the account and region. Enable VPC DNS resolution and ensure its network ACL permits web traffic and return traffic. To find default subnet candidates, run `aws ec2 describe-subnets --filters Name=default-for-az,Values=true --query 'Subnets[].[SubnetId,VpcId,AvailabilityZone]' --output table`.
- **DNS.** Supply two public hostnames you control. Set `zone_id` to their existing public Route 53 zone to create both A records, or leave it null and point both A records to the `public_ip` output after apply. Use direct DNS records with this IPv4-only setup. Remove stale AAAA records for these names so browser traffic and certificate challenges reach the host.
- **Reviewers.** Set `ingress_cidrs` to actual office, VPN, or individual public IPv4 addresses in CIDR notation. An individual address uses `/32`. Reviewers share a workspace and can see and edit all its documents.
- **Model credential.** Create the secret directly in Secrets Manager in the deployment account and region. A JSON object can contain `api_key`, `model`, `base_url` and `embedding_model`. Use a chat model with structured output and tool calling, and an embedding model supporting 1,536 dimensions. Supply its ARN in Terraform. If using a customer-managed KMS key, also supply the key ARN and grant the instance role access through the key policy.

From a cloud builder with Docker Buildx, a clean committed checkout, and permission to push to the staging ECR repositories, run the publisher. Substitute the configured API hostname. The frontend compiles this origin into its browser bundle. The script writes both immutable image digests to a Terraform input file. [Runtime and publishing details](modules/aws/runtime/README.md)

```sh
infra/modules/aws/runtime/publish.sh staging "$AWS_ACCOUNT_ID" "$AWS_REGION" https://api-review.staging.example.com > infra/environments/staging/release.auto.tfvars.json
```

## 3. Apply and verify

```sh
terraform -chdir=infra/environments/staging init -backend-config=backend.tfbackend
terraform -chdir=infra/environments/staging validate
terraform -chdir=infra/environments/staging plan -out=release.tfplan
terraform -chdir=infra/environments/staging show release.tfplan
apply_log=$(mktemp)
terraform -chdir=infra/environments/staging apply -json release.tfplan > "$apply_log" &&
  bash .github/scripts/authorize-new-volume.sh staging infra/environments/staging/release.tfplan "$apply_log"
terraform -chdir=infra/environments/staging output
```

On first creation the helper uses SSM to authorize initialization of the exact new volume. Set `HOST_ADMIN_PROFILE` if a separate profile manages host commands. Keep the private apply log with your saved plan until the host is ready.

Inspect the plan for the intended account, one instance and any replacements. With external DNS, publish both A records now. Apply returns before the application is ready. Allow time for the data disk, image pulls, migrations, initial fixture extraction and TLS issuance. From an allowed reviewer IP, open `dashboard_url` and `api_url/health`. Upload a PDF, review a field, upload its revision, and open a citation from **Ask documents**. This exercises browser-to-S3 access, the worker and the model. [Browser walkthrough](../docs/browser-walkthrough.md)

**Production.** To run both in one account, expand the existing bootstrap configuration to `environments = ["staging", "prod"]` and apply it before publishing. Keep every active environment in this list. Use the prod root, backend, model secret, hostnames and release file; publish the tested commit with the production API hostname. For separate accounts, use a separate bootstrap state per account. Staging seeds example documents. Production runs migrations and starts with an empty library.

## Operations and recovery

- **Inspect startup.** Connect with `aws ssm start-session --target "$(terraform -chdir=infra/environments/staging output -raw instance_id)"`. Run `sudo cloud-init status --long` and `sudo journalctl -u lomi-volume -u lomi --since today`. For container logs, run `sudo docker compose -f /opt/lomi/compose.yaml --env-file /run/lomi/compose.env logs --tail=100`. Check free space on both filesystems. Docker rotates logs locally.
- **Release or roll back.** Publish new digests and inspect the Terraform plan. Changes to embedded startup settings, image digests or the AMI can replace the host. Use a maintenance window, wait for active extraction to settle and take a fresh data-volume snapshot before a database migration. To roll back compatible code, restore the previous image digests and apply. Database migrations require their own recovery plan.
- **Recover data.** The daily snapshots are crash-consistent. A disk loss can cost up to one snapshot interval of database changes. Restore a snapshot to an encrypted volume in the target AZ. Verify it on an isolated host first, including PostgreSQL recovery and matching S3 object versions. During cutover, stop the application, retain the original disk, and reconcile the restored disk with Terraform's data-volume resource via import before applying the reviewed attachment and host changes. Recovery needs the credential files on the same snapshot, access to the model secret, and the original document bucket and its object versions.
- **Pause staging.** Stop and later start its instance using EC2. The Elastic IP and data volume stay allocated. Use a separately reviewed retirement plan to release them permanently. Terraform protects the data volume, state buckets and repositories from accidental destruction.

## Verification

From a clean validation checkout, run `terraform fmt -check -recursive infra`. Run `terraform init -backend=false` and `terraform validate` in `bootstrap` and in each environment directory. In `infra/modules/aws`, initialize the same way and run `terraform test -parallelism=1` for the mocked deployment plans. Successful mock plans cover configuration. DNS, certificate issuance, model access and restore need a real staging run.
