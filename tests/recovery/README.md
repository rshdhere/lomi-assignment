# V3 compatibility and restore verification

The baseline captures the public contract and migration bytes at commit 73c072e. From the repository root, run `sha256sum -c tests/recovery/v3-baseline.sha256` on the baseline checkout. For later releases, review differences against that checkout. Historical fixture expectations and CI revision identifiers are in the [acceptance evidence](../../docs/testing/2026-11-28/ci-acceptance.md).

Follow the [EBS restore procedure](../../infra/README.md) on a disposable host. Start only PostgreSQL from the restored volume during this check and keep application writers stopped. Use the release checkout corresponding to the restored database. Set libpq connection parameters to the isolated database and use a read-only role and version-read-only AWS credentials scoped to its source bucket. The verifier downloads one pinned version at a time to temporary storage and prints aggregate results.

```sh
python3 tests/recovery/verify-restored-volume.py --expected-database lomi --bucket "$RESTORE_SOURCE_BUCKET"
```

Record snapshot timestamp, last known application write, restore start, verifier completion and time until the dashboard can review a document. Compare review counts and known corrected fields with a pre-snapshot reference. Use an isolated model double and separate Redis for the subsequent pending-work recovery scenario. A passing verifier establishes object identity and evidence membership for restored rows. Detecting missing rows requires the independent pre-snapshot reference.
