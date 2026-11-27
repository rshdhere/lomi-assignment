#!/usr/bin/env bash
# Build and push an immutable release from the current committed checkout.
set -euo pipefail
shopt -s inherit_errexit
if [[ $# != 4 ]]; then
  echo 'Usage: publish.sh STAGING_OR_PROD AWS_ACCOUNT_ID AWS_REGION HTTPS_API_ORIGIN' >&2
  exit 2
fi
stage=$1
account=$2
region=$3
api_origin=$4
[[ $stage == staging || $stage == prod ]]
[[ $account =~ ^[0-9]{12}$ && $region =~ ^[a-z0-9-]+$ ]]
[[ $api_origin =~ ^https://[a-zA-Z0-9.-]+$ ]]
cd "$(git rev-parse --show-toplevel)"
# COPY . . makes the checkout the build context. Restrict a release to one
# reproducible committed tree, including newly added source and config files.
if [[ -n $(git status --porcelain=v1 --untracked-files=normal) ]]; then
  echo "Release images require a clean checkout. Inspect git status and publish the intended commit from a clean worktree." >&2
  exit 2
fi
commit=$(git rev-parse HEAD)
registry="$account.dkr.ecr.$region.amazonaws.com"
[[ $(aws sts get-caller-identity --query Account --output text) == "$account" ]]
aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "$registry" >&2
origin_hash=$(printf '%s' "$api_origin" | sha256sum | cut -c1-12)
build_release() {
  local target=$1 repository=$2 tag=$3 digest
  shift 3
  # Resume a partially published pair using ECR's immutable commit tags.
  digest=$(aws ecr batch-get-image --region "$region" --repository-name "$repository" \
    --image-ids imageTag="$tag" --query 'images[0].imageId.imageDigest' --output text)
  if [[ $digest == None ]]; then
    # A Git archive excludes working-tree secrets, caches and uncommitted changes.
    git archive "$commit" | docker buildx build --platform linux/amd64 --target "$target" \
      --file docker/Dockerfile --label "org.opencontainers.image.revision=$commit" \
      --tag "$registry/$repository:$tag" --push "$@" - >&2
    digest=$(aws ecr describe-images --region "$region" --repository-name "$repository" \
      --image-ids imageTag="$tag" --query 'imageDetails[0].imageDigest' --output text)
  fi
  [[ $digest =~ ^sha256:[0-9a-f]{64}$ ]]
  printf '%s@%s' "$registry/$repository" "$digest"
}
app=$(build_release app "lomi/$stage/app" "$commit")
web=$(build_release web "lomi/$stage/web" "$commit-$origin_hash" --build-arg "NEXT_PUBLIC_API_ORIGIN=$api_origin")
printf '{"app_image":"%s","web_image":"%s"}\n' "$app" "$web"
