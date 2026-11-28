#!/bin/bash
set -euo pipefail
umask 077
cd /opt/lomi
readcfg() { python3 -c 'import json,sys; print(json.load(open("config.json"))[sys.argv[1]])' "$1"; }
volume=$(readcfg data_volume_id)
[[ $volume =~ ^vol-[a-f0-9]+$ ]]
expected=${volume/-/}
mount_path=/srv/lomi
if [[ ${1:-} == --mount ]]; then
  refuse() { echo "Cannot mount $volume: $*" >&2; exit 1; }
  exec 8>/run/lomi-volume.lock
  flock 8
  # Nitro NVMe device order can change at every boot. Match the EBS volume serial.
  for ((attempt=0; attempt<180; attempt++)); do
    device=$(lsblk -dnpo NAME,SERIAL | awk -v id="$expected" '$2 == id {print $1}')
    [[ -b "$device" ]] && break
    sleep 3
  done
  [[ -b "$device" ]] || { echo "Expected data volume $volume did not attach" >&2; exit 1; }
  marker=/run/lomi-initialize-volume
  inspect_device() {
    [[ $(lsblk -dnro SERIAL "$device") == "$expected" ]] || refuse "device serial changed"
    [[ $(lsblk -nro TYPE "$device") == disk ]] || refuse "expected a whole disk without partitions or holders"
    holders=$(ls -A "/sys/class/block/${device##*/}/holders")
    [[ -z $holders ]] || refuse "device has active holders"
    device_id=$(lsblk -dnro MAJ:MIN "$device")
    [[ $device_id =~ ^[0-9]+:[0-9]+$ ]] || refuse "invalid device number"
    mounts=$(awk -v id="$device_id" '$3 == id {print $5}' /proc/self/mountinfo)
    # A probe error must stop initialization, even if its stdout is empty.
    signatures=$(wipefs --no-act --noheadings --output TYPE "$device" | awk '{$1=$1; print}')
  }
  inspect_device
  install -d -m 0700 "$mount_path"
  if [[ -z $signatures ]]; then
    [[ -z $mounts ]] && ! mountpoint -q "$mount_path" || refuse "mount already in use"
    # First-apply authorization can arrive over SSM after the disk attaches.
    for ((attempt=0; attempt<120; attempt++)); do
      [[ -e $marker ]] && break
      sleep 5
    done
    [[ -f $marker && ! -L $marker && $(stat -c '%u:%g:%a' "$marker") == 0:0:600 ]] ||
      refuse "fresh-volume initialization requires a root-owned mode-0600 $marker"
    cmp -s "$marker" <(printf '%s\n' "$volume") || refuse "initialization marker does not match $volume"
    unlink "$marker"
    inspect_device
    [[ -z $signatures && -z $mounts ]] && ! mountpoint -q "$mount_path" || refuse "device changed before initialization"
    if blkid --probe "$device" >/dev/null; then
      refuse "device already has a signature"
    else
      [[ $? == 2 ]] || refuse "device probe failed"
    fi
    mkfs.ext4 -L LOMI-DATA "$device"
    inspect_device
  fi
  [[ $signatures == ext4 && $(blkid --probe -s LABEL -o value "$device") == LOMI-DATA ]] ||
    refuse "expected ext4 labeled LOMI-DATA"
  if mountpoint -q "$mount_path"; then
    [[ $mounts == "$mount_path" ]] || refuse "mount does not match the expected disk"
    exit 0
  fi
  [[ -z $mounts ]] || refuse "device mounted elsewhere"
  mount -o nodev,nosuid "$device" "$mount_path"
  exit
fi
mountpoint -q "$mount_path"
mounted=$(findmnt -rn -o SOURCE --target "$mount_path")
[[ $(lsblk -dn -o SERIAL "$mounted" | xargs) == "$expected" ]]
install -d -m 0700 "$mount_path"/{secrets,proxy,caddy-data,caddy-config}
# Bind exactly these persistent locations before Postgres and Redis start.
mkdir -p "$mount_path"/{postgres,redis}
install -d -m 0700 /run/lomi
exec 9>/run/lomi/start.lock
flock 9
# Generate raw Compose env files in tmpfs. Never place credentials on a command line.
python3 - "${1:-}" <<'PY'
import base64
import hashlib
import hmac
import json
import os
import ipaddress
import secrets
import pathlib
import re
import subprocess
import sys
from datetime import datetime, timezone
from urllib.parse import quote

runtime = pathlib.Path("/run/lomi")
cfg = json.loads(pathlib.Path("config.json").read_text())
region = cfg["region"]
def secret(arn):
    spec = subprocess.check_output(["aws", "secretsmanager", "get-secret-value", "--secret-id", arn,
                                    "--region", region, "--output", "json"])
    response = json.loads(spec)
    return response["VersionId"], response["SecretString"]

def write(path, contents):
    temp = runtime / (path + ".tmp")
    temp.write_text(contents)
    temp.replace(runtime / path)

def env_file(path, pairs):
    for name, val in pairs.items():
        if not isinstance(val,str) or not val or any(c in val for c in "\x00\n\r"):
            raise ValueError("Invalid runtime value for " + name)
    write(path, "".join(name+"="+val+"\n" for name,val in pairs.items()))

if cfg["environment"] not in ("staging", "prod", "production"):
    raise ValueError("Unknown environment")
for name in ["app_image","web_image"]:
    if not re.fullmatch(r"\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/[a-z0-9./_-]+@sha256:[0-9a-f]{64}", cfg[name]):
        raise ValueError(name + " must be a private ECR image pinned by digest")
def renew_role(role):
    directory = runtime / (role + "-aws")
    directory.mkdir(exist_ok=True)
    os.chown(directory, 1000, 1000)
    directory.chmod(0o500)
    path = directory / "credentials.json"
    profile = directory / "config"
    arn = cfg[role + "_s3_role_arn"]
    def save(target, data):
        temp = target.with_suffix(".tmp")
        temp.write_text(data)
        os.chown(temp, 1000, 1000)
        temp.chmod(0o400)
        temp.replace(target)
    if not profile.exists():
        save(profile, "[default]\ncredential_process = /bin/cat /run/lomi-aws/credentials.json\n")
    if path.exists():
        previous = json.loads(path.read_text())
        expires = datetime.fromisoformat(previous["Expiration"].replace("Z","+00:00"))
        if previous["RoleArn"] == arn and (expires - datetime.now(timezone.utc)).total_seconds() > 15 * 60:
            return
    response = subprocess.check_output([
        "aws","sts","assume-role","--region",region,"--role-arn",arn,
        "--role-session-name","lomi-"+cfg["environment"]+"-"+role,
        "--duration-seconds","3600","--output","json",
    ])
    credentials = json.loads(response)["Credentials"]
    output = {key:credentials[key] for key in ("AccessKeyId","SecretAccessKey","SessionToken","Expiration")}
    save(path, json.dumps({**output, "Version":1,"RoleArn":arn}))

# Keep the last usable credential file on an STS failure. The next timer retries.
for role in ("app","worker"):
    renew_role(role)
persistent = pathlib.Path("/srv/lomi")
passwords = persistent/"secrets"/"database.json"
if not passwords.exists():
    if any((persistent/"postgres").iterdir()):
        raise RuntimeError("Existing PostgreSQL data requires its retained credential file")
    temp = passwords.with_suffix(".tmp")
    with temp.open("w") as f:
        json.dump({key:secrets.token_hex(32) for key in ("admin","runtime","redis")}, f)
        f.flush()
        os.fsync(f.fileno())
    temp.replace(passwords)
    parent = os.open(passwords.parent, os.O_RDONLY)
    try: os.fsync(parent)
    finally: os.close(parent)
local = json.loads(passwords.read_text())
runtime_password = local["runtime"]
redis = local["redis"]
mv, model = secret(cfg["model_secret_arn"])
fingerprint = hashlib.sha256(json.dumps([cfg, mv, local],sort_keys=True).encode()).hexdigest()
write("requested", fingerprint)
if sys.argv[1] == "--if-rotated" and (runtime/"applied").exists() and (runtime/"applied").read_text() == fingerprint:
    sys.exit(0)
model = json.loads(model) if model.startswith("{") else {"api_key":model}
u = lambda value: quote(value, safe="")
def database(user,password):
    return "postgres://" + u(user) + ":" + u(password) + "@postgres:5432/lomi"

# PostgreSQL accepts a SCRAM verifier. The admin connection receives a verifier,
# keeping the runtime's cleartext password out of DDL and database query logs.
salt = os.urandom(16)
salted = hashlib.pbkdf2_hmac("sha256",runtime_password.encode("ascii"),salt,4096)
encode = lambda key: base64.b64encode(key).decode("ascii")
stored = hashlib.sha256(hmac.digest(salted,b"Client Key","sha256")).digest()
server = hmac.digest(salted,b"Server Key","sha256")
verifier = f"SCRAM-SHA-256$4096:{encode(salt)}${encode(stored)}:{encode(server)}"
common = {"S3_REGION":region, "AWS_REGION":region, "S3_BUCKET":cfg["s3_bucket"],
          "FIXTURES_DIR":"/app/fixtures", "NODE_ENV":"production",
          "AWS_CONFIG_FILE":"/run/lomi-aws/config", "AWS_EC2_METADATA_DISABLED":"true"}
env_file("admin.env", {**common, "DATABASE_URL":database("lomi_admin",local["admin"]), "DB_VERIFIER":verifier})
env = {
    **common, "DATABASE_URL":database("lomi_runtime",runtime_password),
    "OPENAI_API_KEY":model["api_key"],
}
for key, name in [("base_url","OPENAI_BASE_URL"),("model","OPENAI_MODEL"),("embedding_model","EMBEDDING_MODEL")]:
    if key in model:
        env[name] = model[key]
env_file("postgres.env", {"POSTGRES_USER":"lomi_admin","POSTGRES_DB":"lomi","POSTGRES_PASSWORD":local["admin"],"POSTGRES_INITDB_ARGS":"--auth-host=scram-sha-256"})
env_file("redis.env", {"REDISCLI_AUTH":redis})
# Redis drops root; the file is reachable only through a read-only bind mount.
redis_config = persistent/"secrets"/"redis.conf"
redis_temp = redis_config.with_suffix(".tmp")
redis_temp.write_text("requirepass " + redis + "\nmaxmemory 96mb\nmaxmemory-policy noeviction\nappendonly yes\nappendfsync everysec\n")
redis_temp.chmod(0o444)
redis_temp.replace(redis_config)
env_file("backend.env", {**env,"UI_ORIGIN":"https://"+cfg["app_hostname"],"TRUST_SINGLE_PROXY":"true","NODE_OPTIONS":"--max-old-space-size=320"})
env_file("worker.env", {**env,"REDIS_URL":"redis://:" + u(redis) + "@redis:6379/0","WORKER_CONCURRENCY":"1","NODE_OPTIONS":"--max-old-space-size=384"})
networks = [ipaddress.ip_network(entry) for entry in cfg["reviewer_cidrs"]]
if not networks or any(net.prefixlen == 0 for net in networks):
    raise ValueError("Provide explicit reviewer CIDRs")
for host in [cfg["app_hostname"],cfg["api_hostname"]]:
    if not re.fullmatch(r"[a-zA-Z0-9.-]+",host):
        raise ValueError("Invalid site hostname")
env_file("proxy.env", {"APP_HOST":cfg["app_hostname"],"API_HOST":cfg["api_hostname"],"REVIEWER_CIDRS":" ".join(map(str,networks))})
PY
if [[ ${1:-} == --if-rotated ]] && cmp -s /run/lomi/requested /run/lomi/applied; then exit 0; fi
region=$(readcfg region)
app_image=$(readcfg app_image)
web_image=$(readcfg web_image)
{
  echo "APP_IMAGE=$app_image"
  echo "WEB_IMAGE=$web_image"
} > /run/lomi/compose.env
cat >"$mount_path/proxy/Caddyfile" <<'CADDY'
(reviewers) {
  @allowed remote_ip {$REVIEWER_CIDRS}
  handle @allowed {
    request_body {
      max_size {args[1]}
    }
    reverse_proxy {args[0]} {
      header_up X-Forwarded-For {remote_host}
    }
  }
  handle {
    respond 403
  }
}

{$APP_HOST} {
  import reviewers frontend:3000 1MiB
}
{$API_HOST} {
  import reviewers backend:4000 11MiB
}
CADDY
compose() { docker compose --env-file /run/lomi/compose.env "$@"; }
# Host-only IMDS supplements the instance's response hop limit of one.
iptables -w -C DOCKER-USER -d 169.254.169.254/32 -j DROP 2>/dev/null ||
  iptables -w -I DOCKER-USER 1 -d 169.254.169.254/32 -j DROP
export DOCKER_CONFIG=/run/lomi/docker
install -d -m 0700 "$DOCKER_CONFIG"
for registry in $(printf '%s\n' "${app_image%%/*}" "${web_image%%/*}" | sort -u); do
  aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "$registry"
done
if [[ ${1:-} != --if-rotated ]]; then
  compose pull
  compose up -d --wait --wait-timeout 180 postgres redis pdf-parser
  if [[ $(readcfg environment) == staging ]]; then
    compose run --rm --no-deps admin pnpm --filter @repo/backend seed
  else
    compose run --rm --no-deps admin pnpm --filter @repo/drizzle migrate
  fi
fi
# The fixed role name and SCRAM alphabet produce no user-supplied SQL identifiers.
compose run --rm -T --no-deps admin pnpm --filter @repo/drizzle exec node --input-type=module - <<'NODE'
import pg from "pg";
const client = new pg.Client({connectionString:process.env.DATABASE_URL});
await client.connect();
try {
  await client.query("begin");
  await client.query("select pg_advisory_xact_lock(15012027)");
  await client.query("select set_config('lomi.verifier',$1,true)",[process.env.DB_VERIFIER]);
  await client.query(`
    do $role$ begin
      if not exists(select 1 from pg_roles where rolname='lomi_runtime') then
        create role lomi_runtime login;
      end if;
      execute format('alter role lomi_runtime password %L', current_setting('lomi.verifier'));
    end $role$;
    revoke create on schema public from public;
    grant usage on schema public to lomi_runtime;
    do $tables$ declare tbl record; begin
      for tbl in select tablename from pg_tables where schemaname='public' and tablename <> 'app_migrations' loop
        execute format('grant select, insert, update, delete on table public.%I to lomi_runtime', tbl.tablename);
      end loop;
    end $tables$;
    grant usage, select on all sequences in schema public to lomi_runtime;
  `);
  await client.query("commit");
} finally { await client.end(); }
NODE
compose up -d --wait --wait-timeout 180
cp /run/lomi/requested /run/lomi/applied
