# Revision and recovery check

## Measured recovery on November 27, 2026

The recovery harness passed on a disposable EC2 `r7i.2xlarge` in `us-east-1`. It killed the worker while invoice v2 was extracting at 04:00:26.904 UTC. A synchronous Redis flush reduced the key count from seven to zero. The six test services restarted with their original volumes. The API reported v2 extracted at 04:02:00.064 UTC, **93.160 seconds** after interruption. [Terminal capture](./recovery.png)

The full stored v1 result matched the snapshot taken before interruption. Its four approvals and one correction survived. The recovered v2 had five distinct fields. Three reviews carried over, and the changed due date and total amount returned to pending. The harness also passed the subsequent query, evidence and batch replay assertions. [Recorded recovery events](./recovery.jsonl)

## Reproduce the check

Run on a disposable Cloud machine with Docker Compose 2.24.4 or newer and Node 24. From the repository root, start the dedicated integration stack. The recovery and load stacks both use loopback ports 14000 and 19000, so finish and stop one before starting the other.

```sh
docker compose -p lomi-check -f compose.yaml -f tests/integration/compose.yaml up -d --build
curl --retry 60 --retry-connrefused --retry-delay 2 --fail http://localhost:14000/health
node tests/integration/revision.mjs --recovery
```

The test checks the `lomi-check` container labels, network, volumes, loopback API binding and test model settings before the first upload. It extracts invoice v1, verifies five source quotes, approves four values and corrects the vendor. It then uploads v2 and waits for the worker to claim it.

While v2 is extracting, the test kills the worker, confirms the revision is still in flight and counts the Redis keys. It runs `FLUSHALL SYNC`, verifies that Redis contains zero keys, and stops and starts all the running test services with their existing volumes. This includes PostgreSQL, Redis, the object store, the model double, the API, the worker and the frontend if enabled. The one-time seed job stays stopped.

Allow time for the 90-second database lease to expire. The test records interruption and recovery timestamps, then verifies the complete v1 response, including its evidence, value IDs, review decisions, note and outcome. Recovered v2 must have five distinct fields, three carried reviews and two pending values. Structured output lines named `stack-restarted` and `recovery-verified` report the observed key counts, restart scope, recovery duration and review counts.

The remaining checks cover HTTP 409 for an in-flight revision, lexical and semantic answers citing the corrected vendor, rejection of fabricated evidence, missing-file retry and duplicate completion of a presigned batch. Omit `--recovery` to exercise the revision and batch scenarios without interruption. Each run creates new documents within the integration project.

The internal model double supplies deterministic invoice values and embeddings. Its fixed three-second extraction delay gives the test a window to interrupt an active claim. It deliberately supplies one fabricated report field so the evidence check can reject it. [Test provider](../../../tests/integration/provider.mjs)
