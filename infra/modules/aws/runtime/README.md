# Single-host application runtime

The AWS environment runs PostgreSQL with pgvector, Redis, one extraction worker, Express, Next.js and Caddy on the same host. Caddy alone publishes ports 80 and 443. It obtains certificates for both DNS names, checks the connecting IP against the reviewer CIDRs, and replaces forwarded client IPs before proxying. The frontend cannot reach the database network. HTTP and TLS certificate challenges need public access to the proxy. [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https) · [IP matchers](https://caddyserver.com/docs/caddyfile/matchers)

## Images

From a cloud builder with Docker Buildx, AWS CLI and push access to the bootstrap ECR repositories, run the publisher for the intended AWS account and environment. Use a clean checkout of the release commit. It builds the Git tree for the amd64 host. The API's HTTPS origin is compiled into the frontend. The script prints the two digest-qualified references as JSON and reuses ECR's immutable commit tags if a push is retried.

```sh
# Set STAGING_ACCOUNT_ID and PROD_ACCOUNT_ID to the expected 12-digit IDs.
AWS_PROFILE=lomi-staging infra/modules/aws/runtime/publish.sh staging "$STAGING_ACCOUNT_ID" us-east-1 https://api.staging.example.com
AWS_PROFILE=lomi-prod infra/modules/aws/runtime/publish.sh prod "$PROD_ACCOUNT_ID" us-east-1 https://api.example.com
```

## Storage and recovery

A systemd dependency mounts the separate encrypted gp3 volume at `/srv/lomi` before Docker starts. It matches the NVMe serial to Terraform’s volume ID and requires an ext4 filesystem labeled `LOMI-DATA`. A replacement instance in the same AZ can reuse that volume. The retained disk contains PostgreSQL data, Redis AOF files, local database credentials and Caddy configuration and certificates. Restore the complete volume from a consistent backup to keep credentials paired with data. Original PDFs stay in versioned S3.

On first deployment, a new EBS volume can read as pseudorandom bytes. Before authorizing formatting, verify that the applied plan created that exact volume from scratch, that AWS reports no source volume or snapshot, and that the volume is attached to the expected instance. The host waits up to ten minutes for a root-owned mode-0600 file at `/run/lomi-initialize-volume` containing the verified volume ID followed by a newline. It consumes the file once and probes the device again immediately before creating the filesystem. Existing partitions, device holders, mounts or filesystem signatures prevent formatting. [AWS EBS data protection](https://docs.aws.amazon.com/ebs/latest/userguide/data-protection.html)

The database administrator and runtime passwords and Redis token are generated once, with mode 0600 on the encrypted data volume. Staging migrates and seeds missing v1 fixtures. Production runs migrations. A short-lived administrator container grants application table privileges to the runtime login. A worker with concurrency one limits simultaneous PDF parsing on the 4 GiB host. The database and Redis share a private container network. Sample and validate these memory limits under your own workload.

Use a Secrets Manager model secret with a raw API key or a JSON object containing `api_key`. Optional keys are `model`, `base_url`, and `embedding_model`. Every three minutes `lomi-refresh.timer` checks its version and renews the separate one-hour S3 sessions as they approach expiration. The API/seed role can upload and read PDFs. The worker role can read individual object versions. The SDK reads temporary credentials through a process inside its own read-only mount. Host-only metadata access keeps the instance role out of containers.

## Operating the host

- Open an SSM session and inspect `systemctl status lomi-volume lomi lomi-refresh.timer`.
- Read startup failures with `journalctl -u lomi-volume -u lomi`. From `/opt/lomi`, use `sudo docker compose --env-file /run/lomi/compose.env logs --tail 100 worker` to inspect extraction. Docker rotates local service logs at 8 MiB and retains three files per container.
- Trigger a model secret refresh with `sudo systemctl start lomi-refresh`.
- A host replacement takes the service offline while the volume and EIP move. Verify both DNS names over HTTPS from an allowed IP after replacement. Verify another source receives HTTP 403. Use an EBS snapshot before planned maintenance and test restoring it in a separate environment.

AL2023 installs Docker and verifies the pinned Compose plugin before starting the stack. [Compose release digests](https://github.com/docker/compose/releases/expanded_assets/v5.7.1)

## Reading queue health on staging and production

Each environment runs its own private Redis, BullMQ extraction worker, PostgreSQL and S3 bucket. The AWS runtime configures one extraction slot per host. A healthy HTTP response confirms the API is reachable. The release verification also checks for a registered BullMQ worker and reports the durable queued, extracting, overdue-claim and failed-version counts, plus the age of the oldest queued version. [Release verification](../../../../.github/scripts/verify-host.sh)

Compare successive observations. An increasing oldest queued age means intake is outpacing completion. A briefly expired claim can occur during recovery. Check whether the reconciler reclaims it and whether the version completes or exposes a retryable failure. Separate the API's upload throttles from provider rate limits when examining worker errors. Historical failed versions can remain until a reviewer retries them.

For capacity decisions, repeat the same fixture mix with one and two extraction slots on a disposable production-sized host. Compare throughput, queue age, provider errors, available memory and CPU credits. Keep destructive Redis flushes in the isolated recovery project. Promote a tested commit through staging after its real-provider fixture walkthrough.
