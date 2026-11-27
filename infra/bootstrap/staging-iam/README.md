# IAM policies for Terraform and GitHub Actions

An AWS administrator runs these steps before the first Terraform apply. Use the admin's own CLI profile. The target is the human provisioning role `LomiStagingOperator` from the [first deployment guide](../../first-staging-deploy.md). Terraform will create the four workload roles after this setup.

The default render produces the original staging operator policies. Supply `--environment prod` and the production secret ARN to render policies for `LomiProdOperator`. For CI/CD, follow [GitHub release roles](#github-release-roles).

| JSON policy                                                               | What it authorizes                                                                                                                                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [LomiStagingLaunch](templates/LomiStagingLaunch.json)                     | Regional EC2 discovery and launching a `t3.medium` with the staging profile, IMDSv2, Amazon AMIs and encrypted gp3 storage in the chosen network.                                    |
| [LomiStagingCompute](templates/LomiStagingCompute.json)                   | Lifecycle of the staging-tagged host, disk, security group and Elastic IP, plus the DLM snapshot schedule.                                                                           |
| [LomiStagingStorage](templates/LomiStagingStorage.json)                   | Configuration of the staging state and document buckets, state and lock I/O, use of the S3 KMS key for state, and configuration and publishing for the two staging ECR repositories. |
| [LomiStagingIdentity](templates/LomiStagingIdentity.json)                 | Management of the four named workload roles and one instance profile, passing the runtime role to EC2 and the snapshot role to DLM, and reading the public AL2023 AMI parameter.     |
| [LomiStagingDNS](templates/LomiStagingDNS.json)                           | Optional read access to one hosted zone and changes to the two specified A records.                                                                                                  |
| [LomiStagingWorkloadBoundary](templates/LomiStagingWorkloadBoundary.json) | Maximum permissions for each workload role, selected by principal ARN. The admin owns this policy. Terraform sets it as the permissions boundary on workload roles.                  |

The split keeps each document below the IAM limit of 6,144 non-whitespace characters per managed policy. Each file produced below contains complete JSON for the IAM console's **Policies → Create policy → JSON** editor or the AWS CLI. [IAM policy quotas](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html)

## 1. Render for your account

Run from the repository root in Bash with Python 3, AWS CLI v2 and jq available. Pick an existing public subnet with an internet gateway route. Have the model credential owner create `lomi/staging/model` in Secrets Manager with the keys `api_key`, `base_url`, `model` and `embedding_model`. The renderer needs its ARN only. The AWS-managed Secrets Manager key is the default assumed below.

```bash
export ADMIN_PROFILE=my-admin-profile
export AWS_REGION=ap-south-1
export AWS_ACCOUNT_ID=123456789012   # Intended staging account
export SUBNET_ID=subnet-0123456789abcdef0
export POLICY_DIR
POLICY_DIR=$(mktemp -d)
(
  set -euo pipefail
  test "$(aws --profile "$ADMIN_PROFILE" sts get-caller-identity --query Account --output text)" = "$AWS_ACCOUNT_ID"
  vpc=$(aws --profile "$ADMIN_PROFILE" --region "$AWS_REGION" ec2 describe-subnets \
    --subnet-ids "$SUBNET_ID" --query 'Subnets[0].VpcId' --output text)
  secret=$(aws --profile "$ADMIN_PROFILE" --region "$AWS_REGION" secretsmanager describe-secret \
    --secret-id lomi/staging/model --query ARN --output text)
  options=()
  # For Terraform-managed Route 53, uncomment and fill in all three values.
  # options+=(--hosted-zone-id Z1234567890 --app-hostname review.staging.example.com --api-hostname api-review.staging.example.com)
  # For a customer-managed model secret key, uncomment and supply its exact ARN.
  # options+=(--model-kms-key-arn arn:aws:kms:ap-south-1:123456789012:key/11111111-2222-3333-4444-555555555555)
  python3 infra/bootstrap/staging-iam/render.py --account-id "$AWS_ACCOUNT_ID" --region "$AWS_REGION" \
    --subnet-id "$SUBNET_ID" --vpc-id "$vpc" --model-secret-arn "$secret" \
    --output-dir "$POLICY_DIR" "${options[@]}"
)
```

Give the operator the subnet ID, model secret ARN and any optional DNS/key settings used here. Use the same values in the staging tfvars. With external DNS, the output directory contains five files. Enabling Route 53 produces a sixth file.

## 2. Check the exact JSON

Inspect the rendered files before creating policies. The administrator can run IAM Access Analyzer with `access-analyzer:ValidatePolicy`. Review warnings and resolve errors before attaching anything. Account policies such as SCPs and KMS key policies also affect the eventual apply. [AWS policy validation](https://docs.aws.amazon.com/IAM/latest/UserGuide/access-analyzer-policy-validation.html)

```bash
(
  set -euo pipefail
  for file in "$POLICY_DIR"/*.json; do
    echo "$file"
    aws --profile "$ADMIN_PROFILE" --region "$AWS_REGION" accessanalyzer validate-policy \
      --policy-type IDENTITY_POLICY --policy-document "file://$file" --output json |
      jq -e '.findings | map({findingType,issueCode,findingDetails}) | ., (all(.[]; .findingType != "ERROR"))'
  done
)
```

## 3. Create and attach

Start with an existing `LomiStagingOperator` that trusts the exact `lomi-operator` IAM user as shown in the walkthrough. The following commands create the customer-managed policies on first setup. They attach four policies to the operator, or five with Route 53. The boundary is created separately for Terraform to put on the four workload roles. Keep the boundary and the operator's own permissions under administrator control. [AWS permissions boundaries](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html)

```bash
(
  set -euo pipefail
  test "$(aws --profile "$ADMIN_PROFILE" sts get-caller-identity --query Account --output text)" = "$AWS_ACCOUNT_ID"
  admin=(aws --profile "$ADMIN_PROFILE" --region "$AWS_REGION" iam)
  boundary=LomiStagingWorkloadBoundary
  test -s "$POLICY_DIR/$boundary.json"
  names=(LomiStagingLaunch LomiStagingCompute LomiStagingStorage LomiStagingIdentity)
  if [[ -f "$POLICY_DIR/LomiStagingDNS.json" ]]; then names+=(LomiStagingDNS); fi
  for name in "$boundary" "${names[@]}"; do
    "${admin[@]}" create-policy --policy-name "$name" \
      --policy-document "file://$POLICY_DIR/$name.json" --query Policy.Arn --output text
  done
  for name in "${names[@]}"; do
    "${admin[@]}" attach-role-policy --role-name LomiStagingOperator \
      --policy-arn "arn:aws:iam::$AWS_ACCOUNT_ID:policy/$name"
  done
  "${admin[@]}" list-attached-role-policies --role-name LomiStagingOperator --output table
)
```

If a policy already exists, compare its current default version with the rendered JSON. Reuse it if identical, or have the administrator review and publish a new default version before running the attachment loop. If a previous setup gave the role `PowerUserAccess` or an inline IAM supplement, remove those earlier grants when switching to these policies. IAM combines grants across policies. For IAM Identity Center, reference the same operator policies in the staging permission set and provision it to the account.

Set `workload_permissions_boundary_arn` to `arn:aws:iam::ACCOUNT_ID:policy/LomiStagingWorkloadBoundary` in staging tfvars and retain it in GitHub's `DEPLOY_TFVARS_JSON`. On an existing stack, have the administrator apply that boundary to **each existing workload role before delegating access**. The operator can create roles with this boundary and cannot change or remove it. The four names are `lomi-staging-runtime`, `lomi-staging-pdf-app`, `lomi-staging-pdf-worker` and `lomi-staging-data-snapshots`.

## Scope to verify in a shared account

- State object access covers `bootstrap/terraform.tfstate` and `environments/staging/terraform.tfstate` in the named staging bucket, plus their two `.tflock` files. Direct object deletion is granted only for the locks. The document bucket has a Terraform-generated name, so bucket management matches the owned `lomi-staging-documents-*` prefix. Reserve that prefix for this deployment. The operator controls code and bucket policies and must be trusted with staging application data. [Terraform S3 backend](https://developer.hashicorp.com/terraform/language/backend/s3)
- Regional EC2 inventory and ECR token retrieval require `Resource: "*"`. Writes use the network, resource ARNs or ownership tags. EC2's primary network interface is untagged, so its Elastic IP association permission covers interfaces in the selected subnet. Reserve the staging tags and use a subnet appropriate for that authority. The storage settings assume the regional EBS default uses the AWS-managed EBS key. Accounts using a customer-managed EBS key need a key-specific grant and key policy. [EC2 authorization](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ec2.html)
- DLM requires tagging permission at creation. The same permission can place staging tags on an existing regional DLM policy with no conflicting ownership tags. Give unrelated DLM policies distinct ownership tags before delegating in a shared account. [DLM authorization](https://docs.aws.amazon.com/service-authorization/latest/reference/list_dlm.html)
- The usual Terraform apply and ECR publish use the operator policies above. A model credential owner handles secret values, a host administrator handles interactive Session Manager diagnostics, and the optional CodeBuild path uses its own build administrator. The GitHub deployer uses its own OIDC trust, state access and SSM verification permissions. [CodeBuild setup](../../first-staging-codebuild.md) · [GitHub Actions permissions](../../github-actions.md)

## GitHub release roles

Create a distinct OIDC role for each GitHub environment. The deployment administrator owns the state buckets, ECR repositories, permissions boundaries and the account's GitHub OIDC provider. Releases can publish to their two repositories, read and write their environment state and lock, manage environment resources and run SSM commands on their tagged host. The host executes these commands as root. [SSM command scopes](https://docs.aws.amazon.com/systems-manager/latest/userguide/run-command-setting-up.html)

1. Create or reuse the account OIDC provider for `https://token.actions.githubusercontent.com` with audience `sts.amazonaws.com`. Protect each GitHub environment by restricting deployments to the `main` branch. Configure production approval where your GitHub plan supports it. [GitHub setup](../../github-actions.md)
2. Select the repository's exact OIDC subject format. Use `gh api repos/OWNER/REPO/actions/oidc/customization/sub` to inspect its configuration and `gh api repos/OWNER/REPO --jq '{owner_id:.owner.id,repo_id:.id}'` for its immutable IDs. With immutable subjects enabled, use `repo:OWNER@OWNER_ID/REPO@REPO_ID:environment:prod`. For the legacy default, use `repo:OWNER/REPO:environment:prod`. Substitute `staging` when generating staging trust. The workflow uses the GitHub environment in the token's subject. [GitHub OIDC claims](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims)
3. Render the release policies into an empty directory using the deployment inputs for that environment. For external DNS, omit the optional Route 53 arguments.

```bash
stage=prod
prefix="Lomi${stage^}"
repo_subject='repo:OWNER@OWNER_ID/REPO@REPO_ID:environment:prod'
release_dir=$(mktemp -d)
admin=(aws --profile "$ADMIN_PROFILE" --region "$AWS_REGION")
vpc=$("${admin[@]}" ec2 describe-subnets --subnet-ids "$SUBNET_ID" --query 'Subnets[0].VpcId' --output text)
secret=$("${admin[@]}" secretsmanager describe-secret --secret-id "lomi/$stage/model" --query ARN --output text)
python3 infra/bootstrap/staging-iam/render.py --environment "$stage" --github-subject "$repo_subject" \
  --account-id "$AWS_ACCOUNT_ID" --region "$AWS_REGION" --vpc-id "$vpc" --subnet-id "$SUBNET_ID" \
  --model-secret-arn "$secret" --output-dir "$release_dir"
```

4. Create the environment's workload boundary under `${prefix}WorkloadBoundary` if the human bootstrap has not already created it. Set the corresponding ARN in Terraform's `workload_permissions_boundary_arn`. The boundary limits the four workload roles.
5. Use the generated `trust.json` as the role trust policy. Reuse existing managed policies after verifying their current default JSON equals the generated files. On first setup, create missing policies with `aws iam create-policy --policy-name "$name" --policy-document "file://$release_dir/$name.json"`. The release role uses the following attachment list.

```bash
role="${prefix}GitHubDeploy"
"${admin[@]}" iam create-role --role-name "$role" --max-session-duration 7200 \
  --assume-role-policy-document "file://$release_dir/trust.json"
names=("${prefix}Compute" "${prefix}Identity" "${prefix}Launch" "${prefix}ReleaseStorage" "${prefix}ReleaseSsm")
if [[ -f "$release_dir/${prefix}DNS.json" ]]; then names+=("${prefix}DNS"); fi
for name in "${names[@]}"; do
  "${admin[@]}" iam attach-role-policy --role-name "$role" --policy-arn "arn:aws:iam::$AWS_ACCOUNT_ID:policy/$name"
done
"${admin[@]}" iam get-role --role-name "$role" --query Role.Arn --output text
```

Set that ARN as `AWS_DEPLOY_ROLE_ARN` in the matching GitHub environment. Repeat for the other environment with its own subject, secret and role. [GitHub environment variables and secrets](../../github-actions.md)
