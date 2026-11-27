# Build the first staging images with AWS CodeBuild

Use this optional path when you have the verified working-tree snapshot at `$RELEASE_DIR/context.tar` and need a remote Docker engine. One on-demand Linux amd64 build produces both staging images. CodeBuild bills for build time. The build reads one private S3 object and runs for up to 35 minutes. [AWS managed image list](https://docs.aws.amazon.com/codebuild/latest/userguide/ec2-compute-images.html) · [CodeBuild Docker builds](https://docs.aws.amazon.com/codebuild/latest/userguide/sample-docker.html)

Use Bash, AWS CLI v2, jq, openssl and sha256sum. The build administrator needs CodeBuild project/build administration, access to the scratch bucket and log group, ECR reads on the two staging repositories, and IAM role and inline-policy management. Its `iam:PassRole` grant must name the generated role ARN and require `iam:PassedToService = codebuild.amazonaws.com`. The service role itself receives only the policy below. [CodeBuild service-role trust](https://docs.aws.amazon.com/codebuild/latest/userguide/setting-up-service-role.html)

## Prepare the input

Start in the repository root with the exported release variables from [first staging deployment](first-staging-deploy.md). Run the blocks in the same shell, or enter a child Bash session that inherits those variables. Set `BUILD_ADMIN_PROFILE` to the profile of your designated build administrator. In a lab that delegates the temporary build permissions to your operator, set `BUILD_ADMIN_PROFILE=lomi-terraform`.

```bash
set -euo pipefail
umask 077
repo_root=$(git rev-parse --show-toplevel)
export AWS_PROFILE="${BUILD_ADMIN_PROFILE:?Set to your designated build-admin profile or delegated lab profile}"
: "${RELEASE_DIR:?}" "${APP_TAG:?}" "${WEB_TAG:?}" "${API_HOST:?}" "${AWS_ACCOUNT_ID:?}" "${AWS_REGION:?}" "${APP_REPO:?}" "${WEB_REPO:?}"
export AWS_REGION APP_REPO WEB_REPO APP_TAG WEB_TAG API_HOST
export AWS_PAGER=""
[[ $(aws sts get-caller-identity --query Account --output text) == "$AWS_ACCOUNT_ID" ]]
registry="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
[[ $APP_REPO == "$registry/lomi/staging/app" && $WEB_REPO == "$registry/lomi/staging/web" ]]
[[ $API_HOST =~ ^[A-Za-z0-9.-]+$ ]]
for repo in lomi/staging/app lomi/staging/web; do
  [[ $(aws ecr describe-repositories --repository-names "$repo" --query 'repositories[0].imageTagMutability' --output text) == IMMUTABLE ]]
done

release_files=$(cd "$RELEASE_DIR" && pwd)
cd "$(mktemp -d "$release_files/codebuild.XXXXXXXX")"
CONTEXT_SHA=$(sha256sum "$release_files/context.tar" | cut -d' ' -f1)
export CONTEXT_SHA
project="lomi-stg-build-$(openssl rand -hex 6)"
export SOURCE_BUCKET="$project-$AWS_ACCOUNT_ID"
export SOURCE_KEY="inputs/$CONTEXT_SHA.tar"
group="/aws/codebuild/$project"
role_arn="arn:aws:iam::$AWS_ACCOUNT_ID:role/$project"
printf '%s\n' "$project" > project-name
printf 'Temporary build role: %s\nScratch bucket: %s\nLog group: %s\n' "$role_arn" "$SOURCE_BUCKET" "$group"
```

For a delegated lab operator, give the printed ARN to your administrator now. They can grant temporary `iam:CreateRole`, `iam:PutRolePolicy`, `iam:DeleteRolePolicy`, and `iam:DeleteRole` restricted to that ARN, plus the scoped `iam:PassRole` described above. If delegated policy editing requires a permissions boundary, have the administrator supply its ARN in `BUILD_ROLE_BOUNDARY_ARN` and enforce it in the caller's grant. They can also create and remove the role themselves using the JSON below. Keep the role-management and pass-role permissions out of the permanent Terraform policy.

```bash
aws s3 mb "s3://$SOURCE_BUCKET" --region "$AWS_REGION"
aws s3api put-public-access-block --bucket "$SOURCE_BUCKET" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-object --bucket "$SOURCE_BUCKET" --expected-bucket-owner "$AWS_ACCOUNT_ID" --key "$SOURCE_KEY" --body "$release_files/context.tar" --server-side-encryption AES256 >/dev/null
aws logs create-log-group --log-group-name "$group"
aws logs put-retention-policy --log-group-name "$group" --retention-in-days 1
```

## Grant access to this build

The role can read the selected archive, write this project's build logs, and inspect and push the two staging image repositories. The project uses an inline buildspec with `NO_SOURCE`, so it needs no Git integration or ZIP conversion. [CodeBuild projects without a source](https://docs.aws.amazon.com/codebuild/latest/userguide/no-source.html)

```bash
cat > trust.json <<JSON
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"codebuild.amazonaws.com"},"Action":"sts:AssumeRole","Condition":{"StringEquals":{"aws:SourceAccount":"$AWS_ACCOUNT_ID","aws:SourceArn":"arn:aws:codebuild:$AWS_REGION:$AWS_ACCOUNT_ID:project/$project"}}}]}
JSON
cat > access.json <<JSON
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":"s3:GetObject","Resource":"arn:aws:s3:::$SOURCE_BUCKET/$SOURCE_KEY"},
 {"Effect":"Allow","Action":"logs:CreateLogGroup","Resource":"arn:aws:logs:$AWS_REGION:$AWS_ACCOUNT_ID:log-group:$group"},
 {"Effect":"Allow","Action":["logs:CreateLogStream","logs:PutLogEvents"],"Resource":"arn:aws:logs:$AWS_REGION:$AWS_ACCOUNT_ID:log-group:$group:log-stream:*"},
 {"Effect":"Allow","Action":"ecr:GetAuthorizationToken","Resource":"*","Condition":{"StringEquals":{"aws:RequestedRegion":"$AWS_REGION"}}},
 {"Effect":"Allow","Action":["ecr:BatchGetImage","ecr:GetDownloadUrlForLayer","ecr:BatchCheckLayerAvailability","ecr:InitiateLayerUpload","ecr:UploadLayerPart","ecr:CompleteLayerUpload","ecr:PutImage"],"Resource":["arn:aws:ecr:$AWS_REGION:$AWS_ACCOUNT_ID:repository/lomi/staging/app","arn:aws:ecr:$AWS_REGION:$AWS_ACCOUNT_ID:repository/lomi/staging/web"]}
]}
JSON
boundary=()
if [[ -n ${BUILD_ROLE_BOUNDARY_ARN:-} ]]; then boundary=(--permissions-boundary "$BUILD_ROLE_BOUNDARY_ARN"); fi
aws iam create-role --role-name "$project" --assume-role-policy-document file://trust.json "${boundary[@]}" >/dev/null
aws iam put-role-policy --role-name "$project" --policy-name staging-images --policy-document file://access.json
```

## Build and verify

```bash
cat > buildspec.yml <<'YAML'
version: 0.2
env:
  shell: bash
phases:
  build:
    commands:
      - |
        set -euo pipefail
        aws s3api get-object --bucket "$SOURCE_BUCKET" --key "$SOURCE_KEY" context.tar >/dev/null
        printf '%s  context.tar\n' "$CONTEXT_SHA" | sha256sum -c -
        aws ecr get-login-password --region "$AWS_DEFAULT_REGION" | docker login --username AWS --password-stdin "${APP_REPO%%/*}"
        build_target() {
          local target=$1 repo=$2 tag=$3 origin=$4 digest ref
          shift 4
          ref="$repo:$tag"
          digest=$(aws ecr batch-get-image --repository-name "${repo#*/}" --image-ids "imageTag=$tag" --query 'images[0].imageId.imageDigest' --output text)
          if [[ $digest != None ]]; then
            docker pull "$repo@$digest"
            [[ $(docker inspect -f '{{ index .Config.Labels "lomi.context" }}' "$repo@$digest") == "$CONTEXT_SHA" ]]
            [[ $(docker inspect -f '{{ index .Config.Labels "lomi.origin" }}' "$repo@$digest") == "$origin" ]]
            return
          fi
          docker build --platform linux/amd64 --target "$target" --file docker/Dockerfile \
            --label "lomi.context=$CONTEXT_SHA" --label "lomi.origin=$origin" -t "$ref" "$@" - <context.tar
          docker push "$ref"
        }
        build_target app "$APP_REPO" "$APP_TAG" backend
        build_target web "$WEB_REPO" "$WEB_TAG" "https://$API_HOST" --build-arg "NEXT_PUBLIC_API_ORIGIN=https://$API_HOST"
YAML
jq -n --arg project "$project" --arg role "$role_arn" --arg group "$group" --rawfile spec buildspec.yml '
  {name:$project,serviceRole:$role,source:{type:"NO_SOURCE",buildspec:$spec},artifacts:{type:"NO_ARTIFACTS"},
   timeoutInMinutes:35,queuedTimeoutInMinutes:10,concurrentBuildLimit:1,
   environment:{type:"LINUX_CONTAINER",computeType:"BUILD_GENERAL1_SMALL",image:"aws/codebuild/standard:7.0",privilegedMode:true,
     environmentVariables:(["APP_REPO","WEB_REPO","APP_TAG","WEB_TAG","API_HOST","SOURCE_BUCKET","SOURCE_KEY","CONTEXT_SHA"] | map({name:.,value:env[.]}))},
   logsConfig:{cloudWatchLogs:{status:"ENABLED",groupName:$group},s3Logs:{status:"DISABLED"}}}' >project.json
# IAM trust and inline-policy updates can take a few seconds to propagate.
for attempt in {1..6}; do
  if aws codebuild create-project --cli-input-json file://project.json > /dev/null 2>project-error.log; then break; fi
  cat project-error.log >&2
  [[ $attempt -lt 6 ]] && grep -Eiq 'assume.?role|service role' project-error.log || { echo "Project creation failed." >&2; exit 1; }
  sleep 10
done
build_id=$(aws codebuild start-build --project-name "$project" --query build.id --output text)
printf '%s\n' "$build_id" | tee build-id
deadline=$((SECONDS + 3000))
while true; do
  status=$(aws codebuild batch-get-builds --ids "$build_id" --query 'builds[0].buildStatus' --output text)
  case "$status" in
    SUCCEEDED) break ;;
    IN_PROGRESS|None)
      if (( SECONDS >= deadline )); then echo "Check build $build_id in CodeBuild before cleanup." >&2; break; fi
      sleep 15 ;;
    *) echo "Build ended with $status. Inspect $group in CloudWatch Logs." >&2; break ;;
  esac
done
```

After `SUCCEEDED`, resolve both tags to registry digests and use the JSON in the staging Terraform plan. The build can resume after a partial push when an existing tag's image labels match this snapshot and frontend origin.

```bash
[[ $status == SUCCEEDED ]]
digest_ref() {
  local digest
  digest=$(aws ecr describe-images --repository-name "${1#*/}" --image-ids "imageTag=$2" --query 'imageDetails[0].imageDigest' --output text)
  [[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  printf '%s@%s' "$1" "$digest"
}
app_ref=$(digest_ref "$APP_REPO" "$APP_TAG")
web_ref=$(digest_ref "$WEB_REPO" "$WEB_TAG")
jq -n --arg app "$app_ref" --arg web "$web_ref" '{app_image:$app,web_image:$web}' | tee "$release_files/release.auto.tfvars.json"
```

## Remove the temporary build resources

After the build reaches a terminal state and you have collected any required logs, run these commands from the same session. The ECR digest references stay available for deployment.

```bash
aws codebuild delete-project --name "$project"
aws s3api delete-object --bucket "$SOURCE_BUCKET" --expected-bucket-owner "$AWS_ACCOUNT_ID" --key "$SOURCE_KEY" >/dev/null
aws s3api delete-bucket --bucket "$SOURCE_BUCKET" --expected-bucket-owner "$AWS_ACCOUNT_ID"
aws logs delete-log-group --log-group-name "$group"
aws iam delete-role-policy --role-name "$project" --policy-name staging-images
aws iam delete-role --role-name "$project"
cd "$repo_root"
export AWS_PROFILE=lomi-terraform
```

Have the administrator remove any temporary grants. Return to the digest-collection block in [the staging instructions](first-staging-deploy.md#5-publish-the-current-working-tree-to-ecr). If you used a child shell, exit it to resume the original repository shell and profile.
