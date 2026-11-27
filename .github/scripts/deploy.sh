#!/usr/bin/env bash
# Run after successful CI with a clean checkout of the triggering default-branch SHA.
set -euo pipefail
umask 077
fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $# == 1 && ($1 == staging || $1 == prod) ]] || fail 'Usage: deploy.sh staging|prod'
stage=$1
: "${RUNNER_TEMP:?}" "${DEPLOY_SHA:?}" "${DEFAULT_BRANCH:?}" "${DEPLOY_BRANCH:?}"
: "${AWS_ACCOUNT_ID:?}" "${AWS_REGION:?}" "${TF_STATE_BUCKET:?}" "${DEPLOY_TFVARS_JSON:?}"
: "${GITHUB_REF:?}" "${GITHUB_SHA:?}" "${GITHUB_OUTPUT:?}"
cd "$(git rev-parse --show-toplevel)"
[[ $DEPLOY_BRANCH == "$DEFAULT_BRANCH" && $GITHUB_REF == "refs/heads/$DEFAULT_BRANCH" ]] ||
  fail 'Deployment requires a default-branch run.'
[[ $DEPLOY_SHA =~ ^[0-9a-f]{40}$ && $DEPLOY_SHA == "$GITHUB_SHA" && $(git rev-parse HEAD) == "$DEPLOY_SHA" ]] ||
  fail 'Checkout does not match the CI release commit.'
[[ -z $(git status --porcelain --untracked-files=normal) ]] || fail 'Release checkout is dirty.'
[[ $AWS_ACCOUNT_ID =~ ^[0-9]{12}$ && $AWS_REGION =~ ^[a-z]{2}-[a-z]+-[0-9]+$ ]] || fail 'Invalid AWS account or region.'
[[ $TF_STATE_BUCKET == "lomi-${stage}-tfstate-${AWS_ACCOUNT_ID}-${AWS_REGION}" ]] ||
  fail 'State bucket differs from the bootstrap bucket for this environment.'
root="infra/environments/$stage"
scratch=$(mktemp -d "$RUNNER_TEMP/lomi-deploy.XXXXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
export TF_IN_AUTOMATION=1 TF_INPUT=0 TF_DATA_DIR="$scratch/terraform-data" AWS_PAGER=""
export TF_WORKSPACE=default

# Whitelist settings, including optional nullable keys. Identity, backend and images come from the release.
if ! jq -se --arg account "$AWS_ACCOUNT_ID" --arg region "$AWS_REGION" --arg stage "$stage" \
  --arg boundary "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/Lomi${stage^}WorkloadBoundary" '
  def host: type=="string" and length<254 and test("^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\\.)+[A-Za-z0-9-]+$");
  if length==1 and (.[0]|type=="object") then .[0] else error("expected one object") end |
  select((keys - ["subnet_id","app_hostname","api_hostname","model_secret_arn","model_secret_kms_key_arn","ingress_cidrs","zone_id","workload_permissions_boundary_arn"]) == [])
  | select((.app_hostname|host) and (.api_hostname|host) and ((.app_hostname|ascii_downcase)!=(.api_hostname|ascii_downcase)))
  | select(.subnet_id|type=="string" and test("^subnet-([0-9a-f]{8}|[0-9a-f]{17})$"))
  | select(.model_secret_arn|type=="string" and test("^arn:aws:secretsmanager:"+$region+":"+$account+":secret:lomi/"+$stage+"/model-[A-Za-z0-9]{6}$"))
  | select(.model_secret_kms_key_arn==null or (.model_secret_kms_key_arn|type=="string" and startswith("arn:aws:kms:"+$region+":"+$account+":key/")))
  | select(.workload_permissions_boundary_arn==null or .workload_permissions_boundary_arn==$boundary)
  | select(.zone_id==null or (.zone_id|type=="string" and test("^Z[A-Z0-9]+$")))
  | select(.ingress_cidrs|type=="array" and length>0 and all(.[]; type=="string" and test("^([0-9]{1,3}\\.){3}[0-9]{1,3}/([1-9]|[12][0-9]|3[0-2])$")))
  | select(all(.. | strings; test("[[:cntrl:]]") | not))
  | . + {account_id:$account, region:$region}
' <<<"$DEPLOY_TFVARS_JSON" >"$scratch/environment.tfvars.json" 2>"$scratch/validation.log"; then
  fail 'Invalid deployment settings. Check the environment JSON schema, account, region, reviewer ranges and hostnames.'
fi
unset DEPLOY_TFVARS_JSON
app_host=$(jq -r .app_hostname "$scratch/environment.tfvars.json")
api_host=$(jq -r .api_hostname "$scratch/environment.tfvars.json")
[[ $(aws sts get-caller-identity --query Account --output text) == "$AWS_ACCOUNT_ID" ]] || fail 'OIDC identity is in a different AWS account.'
aws s3api head-bucket --bucket "$TF_STATE_BUCKET" --expected-bucket-owner "$AWS_ACCOUNT_ID" >/dev/null
cat >"$scratch/backend.hcl" <<BACKEND
bucket = "$TF_STATE_BUCKET"
region = "$AWS_REGION"
allowed_account_ids = ["$AWS_ACCOUNT_ID"]
kms_key_id = "arn:aws:kms:$AWS_REGION:$AWS_ACCOUNT_ID:alias/aws/s3"
BACKEND

# Terraform diagnostics may include private inputs. Keep detailed plan and apply output in this job's scratch directory.
tf() { terraform "-chdir=$root" "$@"; }
tf init -lockfile=readonly -input=false -no-color "-backend-config=$scratch/backend.hcl"
tf validate -no-color
infra/modules/aws/runtime/publish.sh "$stage" "$AWS_ACCOUNT_ID" "$AWS_REGION" "https://$api_host" >"$scratch/release.tfvars.json"
# Terraform's machine-readable diagnostics carry contextual values in detail and snippet.
# Show only the diagnostic category and address on failure.
report_diagnostics() {
  jq -Rr 'fromjson? | select(.type=="diagnostic") | .diagnostic |
    ([.severity, .address, .summary] | map(select(type=="string") | gsub("[[:cntrl:]]";" ")) | join(" · "))' "$1" >&2
}
if ! tf plan -json -input=false -lock-timeout=5m "-out=$scratch/release.tfplan" \
    "-var-file=$scratch/environment.tfvars.json" "-var-file=$scratch/release.tfvars.json" >"$scratch/plan.log" 2>&1; then
  report_diagnostics "$scratch/plan.log"
  fail "Terraform plan failed for $stage before apply."
fi
tf show -json "$scratch/release.tfplan" |
  jq -r '[.resource_changes[]?.change.actions | join("/")] | group_by(.) | map("\(.[0])=\(length)") | "Plan: "+join(", ")'
if ! tf apply -json -input=false -lock-timeout=5m "$scratch/release.tfplan" >"$scratch/apply.log" 2>&1; then
  report_diagnostics "$scratch/apply.log"
  fail "Terraform apply failed for $stage. Inspect the environment state and rerun the plan."
fi
bash .github/scripts/authorize-new-volume.sh "$stage" "$scratch/release.tfplan" "$scratch/apply.log"
tf output -json | jq -e --arg web "https://$app_host" --arg api "https://$api_host" '
  with_entries(.value = .value.value) |
  select(.dashboard_url==$web and .api_url==$api) |
  select(.instance_id|test("^i-[0-9a-f]{8,17}$")) |
  select(.public_ip|test("^([0-9]{1,3}\\.){3}[0-9]{1,3}$")) |
  select(.data_volume_id|test("^vol-[0-9a-f]{8,17}$")) |
  select(.documents_bucket|test("^[a-z0-9][a-z0-9.-]+[a-z0-9]$")) |
  {dashboard_url,api_url,instance_id,public_ip,data_volume_id,documents_bucket} |
  select(all(.[]; type=="string" and (test("[[:cntrl:]]") | not)))
' > "$scratch/outputs.json" || fail 'Deployment outputs differ from the requested environment.'
instance=$(jq -r .instance_id "$scratch/outputs.json")
address=$(jq -r .public_ip "$scratch/outputs.json")
volume=$(jq -r .data_volume_id "$scratch/outputs.json")
app_image=$(jq -er .app_image "$scratch/release.tfvars.json")
web_image=$(jq -er .web_image "$scratch/release.tfvars.json")
printf 'Applied %s to %s. Both %s and %s must resolve to %s for HTTPS verification.\n' "$DEPLOY_SHA" "$instance" "$app_host" "$api_host" "$address"

# Confirm the exact Terraform output is a Lomi host for this environment before sending any SSM command.
instance_ready() {
  aws ec2 describe-instances --instance-ids "$instance" --region "$AWS_REGION" --output json |
    jq -e --arg account "$AWS_ACCOUNT_ID" --arg stage "$stage" --arg ip "$address" '
      [.Reservations[] | select(.OwnerId==$account) | .Instances[] | select(.State.Name=="running" and .PublicIpAddress==$ip)
       | (.Tags | map({key:.Key,value:.Value})|from_entries) | select(.Application=="lomi" and .Environment==$stage and .Name==("lomi-"+$stage+"-app"))] | length==1
    ' >/dev/null
}
deadline=$((SECONDS + 120))
until instance_ready; do
  ((SECONDS < deadline)) || fail 'Instance identity, IP, state or deployment tags failed verification.'
  sleep 5
done
deadline=$((SECONDS + 600))
while true; do
  ping=$(aws ssm describe-instance-information --region "$AWS_REGION" --filters "Key=InstanceIds,Values=$instance" --query 'InstanceInformationList[0].PingStatus' --output text)
  [[ $ping == Online ]] && break
  ((SECONDS < deadline)) || fail "SSM did not register $instance within ten minutes."
  sleep 10
done

# Send the committed static check with shell-quoted arguments and no credentials or reviewer addresses.
{
  cat <<'VERIFY_HEADER'
set -eu
umask 077
verify_file=$(mktemp /tmp/lomi-verify.XXXXXXXX)
trap 'rm -f -- "$verify_file"' EXIT
cat >"$verify_file" <<'LOMI_VERIFY'
VERIFY_HEADER
  cat .github/scripts/verify-host.sh
  printf '\nLOMI_VERIFY\n'
  # shellcheck disable=SC2016 # The SSM host expands its temporary path.
  printf 'bash "$verify_file"'
  printf ' %q' "$stage" "$app_image" "$web_image" "$app_host" "$api_host" "$address" "$volume"
  printf ' </dev/null\n'
} > "$scratch/command"
jq -n --rawfile script "$scratch/command" '{commands:[$script],executionTimeout:["2700"]}' >"$scratch/parameters.json"
cmd_id=$(aws ssm send-command --region "$AWS_REGION" --instance-ids "$instance" --document-name AWS-RunShellScript \
  --parameters "file://$scratch/parameters.json" --timeout-seconds 120 --comment "Verify Lomi $stage $DEPLOY_SHA" --query Command.CommandId --output text)
[[ $cmd_id =~ ^[0-9a-f-]{36}$ ]] || fail 'SSM did not return a command ID.'
echo "Verifying host readiness with SSM command $cmd_id"
deadline=$((SECONDS + 2850))
while ((SECONDS < deadline)); do
  if aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$cmd_id" --instance-id "$instance" \
    --query '{status:Status,code:ResponseCode,output:StandardOutputContent}' --output json >"$scratch/status" 2>"$scratch/ssm.log"; then
    status=$(jq -r .status "$scratch/status")
    case "$status" in
      Success)
        jq -e --arg marker "LOMI_HOST_VERIFIED $stage $volume" \
          '.code==0 and (.output | rtrimstr("\n") | split("\n") | last == $marker)' "$scratch/status" >/dev/null ||
          fail "Host verification did not report completion. Inspect SSM command $cmd_id."
        break ;;
      Pending|InProgress|Delayed) ;;
      *) fail "Host verification ended with $status. Inspect SSM command $cmd_id on $instance." ;;
    esac
  elif ! grep -q InvocationDoesNotExist "$scratch/ssm.log"; then
    fail "Unable to read SSM invocation $cmd_id."
  fi
  sleep 10
done
[[ ${status:-} == Success ]] || fail "Host verification timed out. Inspect SSM command $cmd_id."
jq -r 'to_entries[] | "\(.key)=\(.value)"' "$scratch/outputs.json" >>"$GITHUB_OUTPUT"
printf 'release_sha=%s\n' "$DEPLOY_SHA" >>"$GITHUB_OUTPUT"
printf 'Verified %s at https://%s and https://%s\n' "$DEPLOY_SHA" "$app_host" "$api_host"
