# First staging deployment from the working tree

This walkthrough deploys the files on your machine before the first Git commit or push. It creates a manual image release in ECR and one `t3.medium` in an existing public subnet. The GitHub workflow can later take ownership of releases using the same Terraform state.

Use one Bash terminal for the numbered steps. The examples use Mumbai (`ap-south-1`). Have your AWS account ID, two hostnames you control, a reviewer public IPv4 address, and a working model provider account ready.

## 1. Give your human operator access

An AWS administrator sets up the IAM user and role once. The terminal profile uses an active access key for `lomi-operator` to obtain temporary credentials for `LomiStagingOperator`. Someone holding that key can assume the staging role. An administrator with a working CLI profile can check the existing setup:

```bash
ADMIN_PROFILE=my-admin-profile
aws iam get-user --profile "$ADMIN_PROFILE" --user-name lomi-operator --query User.Arn --output text
aws iam list-access-keys --profile "$ADMIN_PROFILE" --user-name lomi-operator --query 'AccessKeyMetadata[].Status' --output text
aws iam get-role --profile "$ADMIN_PROFILE" --role-name LomiStagingOperator --query Role.Arn --output text
```

If the user is new, the administrator can create it with `aws iam create-user --profile "$ADMIN_PROFILE" --user-name lomi-operator`. For a missing access key, the administrator can run `aws iam create-access-key --profile "$ADMIN_PROFILE" --user-name lomi-operator` in a private terminal. AWS returns the secret only at creation. Transfer the key pair to the operator securely and enter it only at the local credential prompts in step 2. [IAM access keys](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html)

Use the trust and user policies below, substituting the staging account ID and the user's exact ARN. The administrator creates `LomiStagingOperator` with this trust, grants the user permission to assume it, and attaches the [exact staging provisioning policies](bootstrap/staging-iam/README.md) to the role. That setup also creates the workload permissions boundary.

For a new staging role, save the following document as `staging-trust.json` with the actual user ARN.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::ACCOUNT_ID:user/lomi-operator" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

If the administrator’s `get-role` check returned `NoSuchEntity`, create the role:

```bash
aws iam create-role --profile "$ADMIN_PROFILE" --role-name LomiStagingOperator \
  --assume-role-policy-document file://staging-trust.json --query Role.Arn --output text
```

For an existing role, inspect its current trust before editing:

```bash
aws iam get-role --profile "$ADMIN_PROFILE" --role-name LomiStagingOperator \
  --query Role.AssumeRolePolicyDocument --output json
```

In the allow statement for the exact `lomi-operator` user ARN, remove the `aws:MultiFactorAuthPresent` requirement and any now-empty condition blocks. Preserve other conditions and statements. If the statement covers multiple principals, split out this user so the change applies only to them. Save the complete reviewed document as `staging-trust.json`, then apply it with the administrator profile:

```bash
aws iam update-assume-role-policy --profile "$ADMIN_PROFILE" --role-name LomiStagingOperator \
  --policy-document file://staging-trust.json
```

Save the following user grant as `assume-staging-role.json` with the actual role ARN.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::ACCOUNT_ID:role/LomiStagingOperator"
    }
  ]
}
```

An administrator can apply this grant directly to `lomi-operator` if the user does not already receive it:

```bash
aws iam put-user-policy --profile "$ADMIN_PROFILE" --user-name lomi-operator \
  --policy-name AssumeLomiStagingOperator --policy-document file://assume-staging-role.json
```

## 2. Configure the CLI and verify the account

Start in the repository root. For a new `lomi-operator` profile, run `aws configure --profile lomi-operator` and enter the IAM user's access key pair, region `ap-south-1`, and output format `json`. If the profile exists, go straight to the identity check.

```bash
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN
export AWS_REGION=ap-south-1
export AWS_DEFAULT_REGION="$AWS_REGION"
aws sts get-caller-identity --profile lomi-operator --query '{Account:Account,Caller:Arn}' --output table
```

Verify the staging account and `lomi-operator` user ARN. Set up the role profile once. The `source_profile` command also repairs a profile from the earlier walkthrough that still points to `lomi-mfa`. Keep the braces around `${AWS_ACCOUNT_ID}` in the role ARN so Zsh preserves the following colon.

```bash
export AWS_ACCOUNT_ID
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --profile lomi-operator --query Account --output text)
aws configure set source_profile lomi-operator --profile lomi-terraform
aws configure set role_arn "arn:aws:iam::${AWS_ACCOUNT_ID}:role/LomiStagingOperator" --profile lomi-terraform
aws configure set region "$AWS_REGION" --profile lomi-terraform
```

Select the profile in your deployment shell. The CLI, the Terraform provider, and the S3 backend use the IAM user's key to request temporary role credentials. [AWS CLI role profiles](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-role.html)

```bash
export AWS_PROFILE=lomi-terraform
aws sts get-caller-identity --profile "$AWS_PROFILE" --query '{Account:Account,Caller:Arn}' --output table
```

Continue when the account matches the intended staging account and the ARN contains `assumed-role/LomiStagingOperator/`. Set the Terraform inputs in this shell:

```bash
export AWS_ACCOUNT_ID
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export TF_VAR_account_id="$AWS_ACCOUNT_ID"
export TF_VAR_region=$(aws configure get region --profile lomi-terraform)
```

If the source identity check returns `InvalidClientTokenId`, verify the user’s key is active and entered correctly. If that check succeeds and role assumption returns `AccessDenied`, have the administrator check the role exists, its trust names the exact user ARN, and the user’s permission allows `sts:AssumeRole` on the exact role ARN. Account or organization policies can also require MFA.

## 3. Select the network, DNS names and model secret

Use the existing subnet the administrator selected when rendering the policy. You can inspect the default subnets below. Terraform checks the selected subnet’s route to the internet gateway during planning.

```bash
aws ec2 describe-subnets --filters Name=default-for-az,Values=true \
  --query 'Subnets[].[SubnetId,VpcId,AvailabilityZone]' --output table
```

1. Choose two real public hostnames, for example `review.staging.yourdomain.com` and `api-review.staging.yourdomain.com`. For an existing Route 53 public zone, copy its zone ID. With external DNS, you will create two A records after apply.
2. Determine the public IPv4 address of the reviewer on the network/VPN they will use. Open `https://checkip.amazonaws.com` from that network and use the IPv4 result with `/32` for one address.
3. Use the full ARN of the model secret supplied by the administrator in step 1. The credential owner sets `api_key`, `base_url`, `model`, and `embedding_model`, using the provider URL and model IDs that worked for this account. The chat model must support structured Chat Completions and tool calls, and the embeddings endpoint must support 1,536 dimensions. [Create the model secret](https://docs.aws.amazon.com/secretsmanager/latest/userguide/create_secret.html)

Create the local staging settings. Replace the subnet, hostnames and reviewer IPv4. For Route 53, put the zone ID in `ZONE_ID`. Leave it empty for external DNS. The file is Git-ignored and has the same shape as the later GitHub environment secret.

```bash
export SUBNET_ID=subnet-0123456789abcdef0
export APP_HOST=review.staging.yourdomain.com
export API_HOST=api-review.staging.yourdomain.com
export REVIEWER_CIDR=203.0.113.10/32
export ZONE_ID=''
export MODEL_SECRET_ARN=arn:aws:secretsmanager:ap-south-1:123456789012:secret:lomi/staging/model-EXAMPL  # Use the supplied ARN.
export WORKLOAD_BOUNDARY_ARN="arn:aws:iam::$AWS_ACCOUNT_ID:policy/LomiStagingWorkloadBoundary"
jq -n --arg subnet "$SUBNET_ID" --arg app "$APP_HOST" --arg api "$API_HOST" \
  --arg cidr "$REVIEWER_CIDR" --arg secret "$MODEL_SECRET_ARN" --arg zone "$ZONE_ID" --arg boundary "$WORKLOAD_BOUNDARY_ARN" \
  '{subnet_id:$subnet, app_hostname:$app, api_hostname:$api, ingress_cidrs:[$cidr], model_secret_arn:$secret, workload_permissions_boundary_arn:$boundary}
   + (if $zone == "" then {} else {zone_id:$zone} end)' \
  > infra/environments/staging/staging.auto.tfvars.json
```

If the administrator supplied a customer-managed key for the secret, use the same key ARN in `model_secret_kms_key_arn` and authorize the runtime role in the key policy.

## 4. Bootstrap ECR and the remote Terraform state

Run this once for a **new** staging deployment. If bootstrap already exists, use its existing backend and state. Starting from empty local state against an already bootstrapped account can produce bucket or repository name conflicts.

```bash
terraform -chdir=infra/bootstrap init -lockfile=readonly
terraform -chdir=infra/bootstrap plan -var='environments=["staging"]' -out=bootstrap.tfplan
terraform -chdir=infra/bootstrap show bootstrap.tfplan
terraform -chdir=infra/bootstrap apply bootstrap.tfplan
terraform -chdir=infra/bootstrap output
```

Check the plan before apply. It should contain the staging state bucket and its controls, plus `lomi/staging/app` and `lomi/staging/web` in ECR. This step creates storage and registries. The EC2 instance comes in step 6.

```bash
export TF_STATE_BUCKET APP_REPO WEB_REPO
TF_STATE_BUCKET=$(terraform -chdir=infra/bootstrap output -json state_buckets | jq -er '.staging')
APP_REPO=$(terraform -chdir=infra/bootstrap output -json repositories | jq -er '.["lomi/staging/app"]')
WEB_REPO=$(terraform -chdir=infra/bootstrap output -json repositories | jq -er '.["lomi/staging/web"]')
cat > infra/environments/staging/backend.tfbackend <<BACKEND
bucket              = "$TF_STATE_BUCKET"
region              = "$AWS_REGION"
allowed_account_ids = ["$AWS_ACCOUNT_ID"]
kms_key_id          = "arn:aws:kms:$AWS_REGION:$AWS_ACCOUNT_ID:alias/aws/s3"
BACKEND
cp infra/bootstrap/backend.tf.example infra/bootstrap/backend.tf
terraform -chdir=infra/bootstrap init -migrate-state -backend-config=../environments/staging/backend.tfbackend
```

Answer **yes** to copying the existing bootstrap state when prompted. The bootstrap key is `bootstrap/terraform.tfstate`; the staging deployment uses `environments/staging/terraform.tfstate`. Keep your local backup protected. On another checkout, restore the ignored bootstrap backend configuration before running bootstrap again. [Terraform state migration](https://developer.hashicorp.com/terraform/cli/commands/init)

## 5. Publish the current working tree to ECR

The normal release publisher builds an archived Git commit and requires a clean checkout. For the first deployment, build both Docker targets from one snapshot of your **current files**, including new application files. Keep the AWS deployment, credentials, local dependencies, and Terraform state outside the image.

From the repository root, create and review the exact build context. These commands use GNU tar:

```bash
export RELEASE_DIR
RELEASE_DIR=$(mktemp -d)
git ls-files -coz --exclude-standard -- \
  .dockerignore docker/Dockerfile package.json pnpm-lock.yaml pnpm-workspace.yaml \
  turbo.json eslint.config.mjs apps packages fixtures tooling |
  sort -zu > "$RELEASE_DIR/files.nul"
tar --null --no-recursion --owner=0 --group=0 --numeric-owner --mtime=@0 \
  -cf "$RELEASE_DIR/context.tar" -T "$RELEASE_DIR/files.nul"
tar -tf "$RELEASE_DIR/context.tar" | less
export CONTEXT_SHA APP_TAG WEB_TAG
CONTEXT_SHA=$(sha256sum "$RELEASE_DIR/context.tar" | cut -d' ' -f1)
APP_TAG="manual-${CONTEXT_SHA:0:32}"
WEB_TAG="$APP_TAG-$(printf '%s' "https://$API_HOST" | sha256sum | cut -c1-12)"
```

The two heavy builds belong on a trusted cloud builder. **Choose one path.**

- **Starting with only this desktop and an AWS account:** follow the [one-off CodeBuild instructions](first-staging-codebuild.md). They build the snapshot you just made, push both tags, and return you here to collect the digests. This incurs build-minute charges.
- **Already have a remote Buildx builder:** run `docker buildx ls` and choose the named remote builder. Verify its endpoint and linux/amd64 support with `docker buildx inspect "$BUILDER"`. With a trusted Docker host reachable by SSH, a named builder can be created with `docker context create lomi-cloud --docker host=ssh://USER@BUILD_HOST` followed by `docker buildx create --name lomi-builder --driver docker-container lomi-cloud`. Run the block below with its actual name. [Docker remote host setup](https://docs.docker.com/engine/security/protect-access/) · [ECR authentication](https://docs.aws.amazon.com/AmazonECR/latest/userguide/docker-push-ecr-image.html)

```bash
export BUILDER=lomi-builder
docker buildx inspect "$BUILDER"
aws ecr get-login-password --region "$AWS_REGION" |
  docker login --username AWS --password-stdin "${APP_REPO%%/*}"
docker buildx build --builder "$BUILDER" --platform linux/amd64 -f docker/Dockerfile \
  --target app --label "lomi.context=$CONTEXT_SHA" --label lomi.origin=backend \
  -t "$APP_REPO:$APP_TAG" --push - < "$RELEASE_DIR/context.tar"
docker buildx build --builder "$BUILDER" --platform linux/amd64 -f docker/Dockerfile \
  --target web --label "lomi.context=$CONTEXT_SHA" --label "lomi.origin=https://$API_HOST" \
  --build-arg "NEXT_PUBLIC_API_ORIGIN=https://$API_HOST" \
  -t "$WEB_REPO:$WEB_TAG" --push - < "$RELEASE_DIR/context.tar"
```

ECR tags are immutable. If a previous attempt already published one of these exact tags, reuse its digest and build only the missing target. After either path, write the two verified digests into the staging root. A missing or malformed digest makes the check fail.

```bash
APP_DIGEST=$(aws ecr describe-images --repository-name lomi/staging/app --image-ids imageTag="$APP_TAG" --query 'imageDetails[0].imageDigest' --output text)
WEB_DIGEST=$(aws ecr describe-images --repository-name lomi/staging/web --image-ids imageTag="$WEB_TAG" --query 'imageDetails[0].imageDigest' --output text)
jq -en --arg app "$APP_REPO" --arg web "$WEB_REPO" --arg a "$APP_DIGEST" --arg w "$WEB_DIGEST" \
  'select(([$a,$w] | all(.[]; test("^sha256:[0-9a-f]{64}$")))) | {app_image:($app+"@"+$a), web_image:($web+"@"+$w)}' \
  > infra/environments/staging/release.auto.tfvars.json
```

## 6. Plan and deploy the one staging host

```bash
terraform -chdir=infra/environments/staging init -lockfile=readonly -backend-config=backend.tfbackend
terraform -chdir=infra/environments/staging validate
terraform -chdir=infra/environments/staging plan -out=first-staging.tfplan
terraform -chdir=infra/environments/staging show first-staging.tfplan
```

**Checkpoint before spending:** check the account, region and subnet, one `t3.medium`, the Elastic IP, a 24 GiB gp3 root disk, a separate 40 GiB data volume, private versioned document storage, and the snapshot policy. On a first deployment, investigate any proposed destruction. Once the plan matches:

```bash
umask 077
export HOST_ADMIN_PROFILE="$ADMIN_PROFILE"
terraform -chdir=infra/environments/staging apply -json first-staging.tfplan > "$RELEASE_DIR/apply.jsonl" &&
  bash .github/scripts/authorize-new-volume.sh staging \
    infra/environments/staging/first-staging.tfplan "$RELEASE_DIR/apply.jsonl"
terraform -chdir=infra/environments/staging output
```

The helper checks the saved plan, the exact volume ID recorded by apply, and the live AWS attachment before authorizing the host to initialize its data disk. Use a host administrator profile that can run SSM commands on this staging instance. Ordinary deployments reuse the existing filesystem.

For external DNS, create A records for **both** `APP_HOST` and `API_HOST` pointing at `public_ip`. Use direct DNS records, with any DNS-provider proxy disabled for this IP-based reviewer allowlist. Remove any stale AAAA records for these two names. With `zone_id` configured, Terraform creates the A records. Caddy issues certificates once DNS points at the instance.

## 7. Verify the actual application

Run the following from the allowlisted reviewer network after boot and DNS propagation:

```bash
terraform -chdir=infra/environments/staging output -raw public_ip
getent ahostsv4 "$APP_HOST"
getent ahostsv4 "$API_HOST"
curl --fail --show-error "https://$API_HOST/health"
terraform -chdir=infra/environments/staging output -raw dashboard_url
```

Open the dashboard. Check that a seeded document reaches **Extracted**, upload a fixture invoice, review a field, upload the invoice v2, and ask a question that returns a citation. These checks exercise S3 permissions, queue processing, database migrations, model access and HTTPS. [Browser walkthrough](../docs/browser-walkthrough.md)

If the host is still starting, have a host administrator with interactive Session Manager permission connect through **EC2 → Instances → Connect → Session Manager** or use the CLI below. The first three commands in the second block run **inside the SSM session**.

```bash
INSTANCE_ID=$(terraform -chdir=infra/environments/staging output -raw instance_id)
aws --profile "$HOST_ADMIN_PROFILE" --region "$AWS_REGION" ssm start-session --target "$INSTANCE_ID"
```

```bash
sudo cloud-init status --long
sudo systemctl status lomi-volume.service lomi.service --no-pager
sudo journalctl -u lomi --since today --no-pager | tail -80
exit
```

An HTTP 403 usually means the request came from outside the reviewer CIDR. A TLS failure calls for checking both DNS records, ports 80/443 and Caddy startup. For failed extraction, check the worker log and the configured provider's base URL and model access. [Runtime diagnostics](modules/aws/runtime/README.md)

## 8. Hand off after staging works

Record the staging account, region, state bucket, hostnames, and deployed image digests. GitHub will use the same state bucket, state key and Terraform root. Its first commit-tagged release can replace the single EC2 host and reattach the retained data disk and Elastic IP. Allow a maintenance window.

Configure the GitHub `staging` environment and its separate OIDC deployment role using the [GitHub Actions guide](github-actions.md). The contents of `staging.auto.tfvars.json` have the right shape for `DEPLOY_TFVARS_JSON`. Keep local `.env`, AWS credentials, real tfvars, state, saved plans and backend settings outside commits. This repository's pre-push hook also runs a session-transcript sync, so keep credentials out of the conversation. Leave `AUTO_DEPLOY_STAGING` unset until you want successful pushes on `main` to deploy automatically. Then commit and push the application, workflows, Terraform source and provider lockfiles, and use **Actions → Deploy staging → Run workflow** for the first handoff. Production stays a separate decision.
