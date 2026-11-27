#!/usr/bin/env bash
set -euo pipefail
: "${GITHUB_REPOSITORY:?}" "${GITHUB_SHA:?}"
api="repos/$GITHUB_REPOSITORY/actions"
# A green CI-only push can skip the staging job. Require successful host verification.
runs=$(gh api --paginate --method GET "$api/workflows/deploy-staging.yml/runs" \
  -f branch=main -f head_sha="$GITHUB_SHA" -f status=success -F per_page=100 \
  --jq '.workflow_runs[] | select(.event=="push" or .event=="workflow_dispatch") | .id')
while IFS= read -r id; do
  [[ -n $id ]] || continue
  jobs=$(gh api --paginate --slurp "$api/runs/$id/jobs?filter=latest&per_page=100")
  if jq -e 'any(.[].jobs[]; .conclusion=="success" and any(.steps[]?; .name=="Publish, apply and verify the release" and .conclusion=="success"))' <<<"$jobs" >/dev/null; then
    printf 'Verified staging deployment for %s in run %s.\n' "$GITHUB_SHA" "$id"
    exit 0
  fi
done <<<"$runs"
printf 'Deploy %s with the Deploy staging workflow before promoting it to production.\n' "$GITHUB_SHA" >&2
exit 1
