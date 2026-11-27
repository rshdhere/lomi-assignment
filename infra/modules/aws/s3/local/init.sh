#!/bin/sh
set -eu
until mc alias set local http://storage:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"; do sleep 1; done
mc mb --ignore-existing local/review-pdfs
mc version enable local/review-pdfs
mc anonymous set none local/review-pdfs
configure_account() {
  policy=$1
  user=$2
  password=$3
  mc admin policy create local "$policy" "/config/$4"
  mc admin user add local "$user" "$password"
  if ! mc admin user info local "$user" | grep -Eq "^PolicyName:.*$policy"; then
    mc admin policy attach local "$policy" --user "$user"
  fi
}
configure_account review-app "$APP_USER" "$APP_PASSWORD" app-policy.json
configure_account review-worker "$WORKER_USER" "$WORKER_PASSWORD" worker-policy.json
