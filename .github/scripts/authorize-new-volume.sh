#!/usr/bin/env bash
# Run immediately after applying the supplied plan. A retained or imported volume is never initialized.
set -euo pipefail
fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $# == 3 && ($1 == staging || $1 == prod) ]] || fail 'Usage: authorize-new-volume.sh staging|prod SAVED_PLAN JSON_APPLY_LOG'
stage=$1
plan=$(realpath "$2")
apply_log=$(realpath "$3")
: "${AWS_REGION:?}" "${AWS_ACCOUNT_ID:?}"
cd "$(git rev-parse --show-toplevel)"
tf() { terraform "-chdir=infra/environments/$stage" "$@"; }
address=module.deployment.aws_ebs_volume.data
action=$(tf show -json "$plan" | jq -er --arg addr "$address" '
  [.resource_changes[] | select(.address==$addr)] |
  if length != 1 then error("missing or ambiguous data volume")
  elif .[0].change | (.actions==["create"] and .before==null and .importing==null and .after.snapshot_id==null)
  then "initialize" else "retain" end')
[[ $action == initialize ]] || exit 0

# Bind this first-use authorization to the volume created by this apply, even if state changed later.
volume=$(jq -ser --arg addr "$address" '
  [.[] | select(.type=="apply_complete" and .hook.resource.addr==$addr and .hook.action=="create" and .hook.id_key=="id") |
    .hook.id_value] | select(length==1) | .[0] | select(test("^vol-[0-9a-f]{8,17}$"))' "$apply_log")
[[ $(tf output -raw data_volume_id) == "$volume" ]] || fail 'New volume differs from the current deployment.'
instance=$(tf output -raw instance_id)
[[ $instance =~ ^i-[0-9a-f]{8,17}$ ]] || fail 'Invalid deployment instance.'
host_aws() { aws ${HOST_ADMIN_PROFILE:+--profile "$HOST_ADMIN_PROFILE"} --region "$AWS_REGION" "$@"; }
[[ $(host_aws sts get-caller-identity --query Account --output text) == "$AWS_ACCOUNT_ID" ]] || fail 'Unexpected host operator account.'
host_aws ec2 describe-instances --instance-ids "$instance" --output json |
  jq -e --arg account "$AWS_ACCOUNT_ID" --arg stage "$stage" --arg id "$instance" '
    [.Reservations[] | select(.OwnerId==$account) | .Instances[] | select(.InstanceId==$id and .State.Name=="running") |
     (.Tags | map({key:.Key,value:.Value}) | from_entries) |
     select(.Application=="lomi" and .Environment==$stage and .Name==("lomi-"+$stage+"-app"))] | length==1' >/dev/null ||
  fail 'New volume host identity could not be verified.'
host_aws ec2 describe-volumes --volume-ids "$volume" --output json |
  jq -e --arg volume "$volume" --arg instance "$instance" --arg stage "$stage" '
    .Volumes | length==1 and (.[0] |
      .VolumeId==$volume and .State=="in-use" and .Encrypted==true and
      (.SnapshotId // "")=="" and (.SourceVolumeId // "")=="" and
      (.Attachments|length)==1 and (.Attachments[0] | .InstanceId==$instance and .State=="attached" and .Device=="/dev/sdf") and
      (.Tags | map({key:.Key,value:.Value}) | from_entries | .Application=="lomi" and .Environment==$stage and .Name==("lomi-"+$stage+"-data")))' >/dev/null ||
  fail 'New data volume provenance or attachment could not be verified.'

deadline=$((SECONDS + 600))
until [[ $(host_aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$instance" --query 'InstanceInformationList[0].PingStatus' --output text) == Online ]]; do
  ((SECONDS < deadline)) || fail "SSM did not register $instance within ten minutes."
  sleep 5
done
# The mount service independently repeats disk, filesystem and marker checks immediately before formatting.
script=$(cat <<'HOST'
set -euo pipefail
volume=$1
for ((attempt=0; attempt<30; attempt++)); do
  dev=$(lsblk -dnpo NAME,SERIAL | awk -v id="${volume/-/}" '$2==id {print $1}')
  [[ -b "$dev" ]] && break
  sleep 2
done
[[ -b "$dev" ]]
sig=$(wipefs --no-act --noheadings --output TYPE "$dev")
if [[ -n $sig ]]; then
  [[ $(blkid -p -s TYPE -o value "$dev") == ext4 && $(blkid -p -s LABEL -o value "$dev") == LOMI-DATA ]]
  exit
fi
[[ $(lsblk -nr -o NAME "$dev" | wc -l) == 1 ]]
majmin=$(lsblk -dn -o MAJ:MIN "$dev" | xargs)
[[ -n $majmin && -d /sys/dev/block/$majmin/holders ]]
holders=$(ls -A "/sys/dev/block/$majmin/holders")
[[ -z $holders ]]
mounts=$(findmnt -rn -o MAJ:MIN)
! grep -Fxq "$majmin" <<<"$mounts" || exit 1
umask 077
marker=$(mktemp /run/lomi-initialize-volume.XXXXXX)
trap 'rm -f -- "$marker"' EXIT
printf '%s\n' "$volume" >"$marker"
mv -T -- "$marker" /run/lomi-initialize-volume
HOST
)
parameters=$(jq -n --arg body "$(printf "bash -s -- %q <<'LOMI_NEW_VOLUME'\n%s\nLOMI_NEW_VOLUME" "$volume" "$script")" '{commands:[$body],executionTimeout:["180"]}')
command_id=$(host_aws ssm send-command --instance-ids "$instance" --document-name AWS-RunShellScript \
  --parameters "$parameters" --comment "Authorize new Lomi $stage data volume" --query Command.CommandId --output text)
host_aws ssm wait command-executed --command-id "$command_id" --instance-id "$instance" || fail "First-use authorization failed. Inspect SSM command $command_id on $instance."
printf 'Verified the new %s volume %s for initialization on %s.\n' "$stage" "$volume" "$instance"
