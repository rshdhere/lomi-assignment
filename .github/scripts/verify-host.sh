#!/usr/bin/env bash
# Runs via SSM on the exact EC2 instance returned by the saved Terraform plan.
set -euo pipefail
stage=$1 app_image=$2 web_image=$3 app_host=$4 api_host=$5 address=$6 volume=$7
fail() { echo "$*" >&2; exit 1; }
timeout 1800 cloud-init status --wait >/dev/null || fail 'Cloud initialization failed or exceeded 30 minutes.'
systemctl is-active --quiet lomi-volume.service || fail 'Persistent volume service is inactive.'
systemctl is-active --quiet lomi.service || fail 'Application startup is incomplete.'
systemctl is-active --quiet lomi-refresh.timer || fail 'Credential refresh timer is inactive.'
mountpoint -q /srv/lomi || fail 'Application data mount is missing.'
disk=$(findmnt -rn -o SOURCE --target /srv/lomi)
[[ $(lsblk -dn -o SERIAL "$disk" | xargs) == "${volume/-/}" ]] || fail 'Mounted volume differs from Terraform output.'

cd /opt/lomi
compose() { docker compose --env-file /run/lomi/compose.env "$@"; }
for service in backend frontend worker postgres redis proxy; do
  id=$(compose ps -q "$service")
  [[ -n $id ]] || fail "$service is absent."
  [[ $(docker inspect -f '{{.State.Status}}' "$id") == running ]] || fail "$service is stopped."
  case "$service" in
    postgres|redis|frontend|backend)
      [[ $(docker inspect -f '{{.State.Health.Status}}' "$id") == healthy ]] || fail "$service is unhealthy." ;;
  esac
  case "$service" in
    worker|backend) expected=$app_image ;;
    frontend) expected=$web_image ;;
    *) continue ;;
  esac
  [[ $(docker inspect -f '{{.Config.Image}}' "$id") == "$expected" ]] || fail "$service runs an unexpected image digest."
done

# Reach the real backends behind Caddy without editing its reviewer allowlist.
compose exec -T frontend node --input-type=module - <<'JS'
const response = await fetch("http://127.0.0.1:3000/", {signal:AbortSignal.timeout(8000)});
if (!response.ok || !(await response.text()).includes("Lomi | Document review")) throw Error("Dashboard did not render.");
JS
compose exec -T backend node --input-type=module - "$stage" <<'JS'
const response = await fetch("http://127.0.0.1:4000/documents", {signal:AbortSignal.timeout(8000)});
if (!response.ok) throw Error("Document library unavailable.");
const {documents}=await response.json();
if (!Array.isArray(documents)) throw Error("Unexpected library response.");
if (process.argv[2] === "staging" && !["doc-invoice-001","doc-report-001","doc-lease-001"].every(id => documents.some(d=>d.id===id))) throw Error("Missing staged fixtures.");
JS
compose exec -T -w /app/apps/worker worker node --input-type=module - <<'JS'
import { Queue } from "bullmq";
const redis = new URL(process.env.REDIS_URL);
const queue = new Queue("extraction",{connection:{host:redis.hostname,port:Number(redis.port),password:decodeURIComponent(redis.password),retryStrategy:()=>null}});
try {
  if (!(await queue.getWorkers()).length) throw Error("No extraction worker registered with Redis.");
} finally { await queue.close(); }
JS

# Also exercise the actual proxy-to-service network paths. Probe code never changes the ACL.
compose exec -T proxy wget -q -T 8 -O /dev/null http://frontend:3000/ </dev/null
compose exec -T proxy wget -q -T 8 -O /dev/null http://backend:4000/health </dev/null

# Caddy can legitimately deny the host's Docker gateway IP. Validate both named
# certificates with the system trust store and verify the upstreams independently.
https_ready() {
  local host=$1 path=$2 ips status
  ips=$(getent ahostsv4 "$host" | awk '{print $1}' | sort -u) || return 1
  [[ $ips == "$address" ]] || return 1
  status=$(curl --noproxy '*' --silent --max-time 8 --resolve "$host:443:127.0.0.1" \
    -o /dev/null -w '%{http_code}' "https://$host$path") || return 1
  [[ $status == 200 || $status == 403 ]]
}
deadline=$((SECONDS + 600))
until https_ready "$app_host" / && https_ready "$api_host" /health; do
  ((SECONDS < deadline)) || fail 'Public DNS and trusted HTTPS did not become ready for both hostnames.'
  sleep 10
done
echo 'Verified immutable images, database library, dashboard, queue worker, data volume and HTTPS.'
printf 'LOMI_HOST_VERIFIED %s %s\n' "$stage" "$volume"
