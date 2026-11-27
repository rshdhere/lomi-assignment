# GitHub Actions releases

Pull requests run application and infrastructure checks on GitHub-hosted runners. Pushes to `main` run those checks again for the commit that can be deployed. A failed check blocks publication and deployment. CI uses a disposable database and the repository's model double. [CI workflow](../.github/workflows/ci.yml)

| Trigger                                                  | Result                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Pull request or merge queue                              | Runs CI with read-only repository access.                                                              |
| Push to `main`                                           | Runs CI. When the repository variable `AUTO_DEPLOY_STAGING` is `true`, deploys that commit to staging. |
| **Actions → Deploy staging → Run workflow** on `main`    | Runs CI and deploys to staging.                                                                        |
| **Actions → Deploy production → Run workflow** on `main` | Promotes the same commit after verifying that its staging deployment passed host checks.               |

Each release workflow selects a fixed GitHub environment. The environments have separate AWS roles, state buckets and locks, ECR repositories, secrets, hosts and deployment queues. The web image for each environment is built with its own API origin. A release can replace its EC2 host and briefly interrupt that environment. [Staging workflow](../.github/workflows/deploy-staging.yml) · [Production workflow](../.github/workflows/deploy-prod.yml) · [Shared deployment steps](../.github/workflows/deploy.yml)

## One-time setup

1. Complete the account bootstrap in the infrastructure guide. Each selected environment needs its own state bucket, ECR repositories, existing public subnet, two DNS names, reviewer CIDRs and model credential in AWS Secrets Manager.
2. In **Settings → Environments**, create `staging` and `prod`. Restrict each environment to the `main` **branch**. Configure required reviewers for `prod` where supported by the repository's GitHub plan. Use the same branch protection and code review you require for production access on changes to workflows and Terraform. [GitHub environment protection](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
3. In each target AWS account, configure the IAM OIDC provider for `https://token.actions.githubusercontent.com` with audience `sts.amazonaws.com`. Create a separate deployment role for each environment with a maximum session duration of at least 90 minutes. Bind its trust to that repository and environment. The workflow exchanges a GitHub identity token for temporary AWS credentials. [GitHub's AWS OIDC setup](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)

Example trust policy for staging. Replace the account ID and subject with the values for your repository. GitHub's immutable subject format includes the numeric owner and repository IDs, for example `repo:OWNER@OWNER_ID/REPO@REPO_ID:environment:staging`. Repositories using the legacy default subject use `repo:OWNER/REPO:environment:staging`. Set the production role's subject to the corresponding `prod` environment. [GitHub OIDC subject formats](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:OWNER@OWNER_ID/REPO@REPO_ID:environment:staging"
        }
      }
    }
  ]
}
```

Render the environment's OIDC trust and scoped release policies with the [GitHub release role instructions](bootstrap/staging-iam/README.md#github-release-roles). Use `staging` or `prod` in place of `ENV`.

| Purpose                         | Access needed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publish release images          | `ecr:GetAuthorizationToken` plus `BatchGetImage`, `DescribeImages`, `BatchCheckLayerAvailability`, `InitiateLayerUpload`, `UploadLayerPart`, `CompleteLayerUpload` and `PutImage` on the two `lomi/ENV/app` and `lomi/ENV/web` repositories.                                                                                                                                                                                                                                                                                              |
| Lock and update Terraform state | List the environment state bucket. Read and write `environments/ENV/terraform.tfstate`. Read, create and delete the adjacent `.tflock` object. Allow the backend's required KMS encrypt, decrypt and data-key operations. [S3 backend permissions](https://developer.hashicorp.com/terraform/language/backend/s3)                                                                                                                                                                                                                         |
| Apply the environment           | Grant the operator-equivalent permissions for this AWS module's EC2, EBS, security group, DLM, document S3 bucket and workload IAM resources. Include reading the public AMI SSM parameter and existing network, passing the workload roles to EC2 and DLM, and Route 53 record updates in the selected zone when enabled. Scope writable IAM roles and instance profiles to this environment. Keep control of the deployment role and OIDC provider with the bootstrap administrator. [Resources managed by the AWS module](modules/aws) |
| Verify the running release      | Allow `ec2:DescribeInstances`, `ssm:DescribeInstanceInformation` and `ssm:GetCommandInvocation`. The job runs `AWS-RunShellScript` on the application instance through SSM. Grant `ssm:SendCommand` on the AWS-managed document and, in a separate statement, on EC2 instances tagged `Application=lomi`, `Environment=ENV` and `Name=lomi-ENV-app`. This permission executes commands as root.                                                                                                                                           |

### GitHub environment settings

Set the following in each selected **GitHub environment**.

| Kind     | Name                  | Value                                                  |
| -------- | --------------------- | ------------------------------------------------------ |
| Variable | `AWS_DEPLOY_ROLE_ARN` | OIDC role ARN for this environment                     |
| Variable | `AWS_ACCOUNT_ID`      | Expected 12-digit AWS account ID                       |
| Variable | `AWS_REGION`          | Deployment and state region, for example `ap-south-1`  |
| Variable | `TF_STATE_BUCKET`     | Environment bucket from the Terraform bootstrap output |
| Secret   | `DEPLOY_TFVARS_JSON`  | Environment inputs as a JSON object, as shown below    |

The staging and production callers each pass `DEPLOY_TFVARS_JSON` by name. The deploy job selects the matching GitHub environment, which supplies that environment’s secret value. [GitHub reusable workflow secret rules](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows#using-inputs-and-secrets-in-a-reusable-workflow)

Copy the deployment inputs supplied to the manual apply for that environment. If the file includes `account_id` or `region`, each must match its GitHub environment variable. Include `workload_permissions_boundary_arn` when a boundary is in use. The release checks the environment-specific state bucket and the secret name `lomi/ENV/model` before applying Terraform. [Scoped operator policies](bootstrap/staging-iam/README.md)

```json
{
  "subnet_id": "subnet-0123456789abcdef0",
  "app_hostname": "review.staging.example.com",
  "api_hostname": "api-review.staging.example.com",
  "zone_id": "Z0123456789EXAMPLE",
  "model_secret_arn": "arn:aws:secretsmanager:ap-south-1:123456789012:secret:lomi/staging/model-EXAMPL",
  "ingress_cidrs": ["203.0.113.10/32"]
}
```

Replace the example identifiers and reviewer IP. Omit `zone_id` for external DNS. Supply `model_secret_kms_key_arn` if the model secret uses a customer-managed KMS key. The model API key stays in Secrets Manager. The workflow supplies the account, region and image digests separately.

## Running a release

Run **Deploy staging** on `main`. After CI passes, the deployment checks that the commit is still current, publishes images to staging ECR, applies its saved Terraform plan and verifies the host. The release log shows planned operation counts. Check the staging dashboard before promotion.

To release that commit, run **Deploy production** on `main`. Its read-only promotion job looks up the staging workflow for the exact commit and requires a successful publish, apply and verification step. A CI-only push with staging deployment disabled cannot satisfy that check. Production then uses its own GitHub environment and AWS role. Any required environment reviewer authorizes that deployment. If `main` has advanced while a deployment is waiting, run staging for the newer commit before promoting it. [Workflow run records](https://docs.github.com/en/rest/actions/workflow-runs) · [Workflow job records](https://docs.github.com/en/rest/actions/workflow-jobs)

When a release creates the data volume, the job checks the exact EBS ID recorded by Terraform against AWS volume metadata and authorizes the instance through SSM to initialize it once. Later releases mount the retained filesystem. The deployment role uses `ec2:DescribeVolumes` for this check.

With external DNS, point both A records at the IP printed in the release log immediately after the first apply. Allow time for DNS and certificate issuance. The job checks the host through SSM so GitHub runners do not need access to the reviewer network. If verification fails after apply, the resources are already deployed. Inspect the reported SSM command and the host's `lomi` service log, correct the issue and rerun the release. Open the dashboard from a reviewer IP for the upload, extraction and citation walkthrough. [Browser walkthrough](../docs/browser-walkthrough.md)

To roll back compatible application code, revert the change on `main` and release the resulting tested commit. Database migrations and recovery follow the infrastructure runbook. [Recovery instructions](README.md#operations-and-recovery)
