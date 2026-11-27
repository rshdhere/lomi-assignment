"""Read-only verification against an isolated restored PostgreSQL database and S3 bucket."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time


def query(statement):
    result = subprocess.run(
        ["psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", statement],
        check=True, capture_output=True, text=True,
        env={**os.environ, "PGOPTIONS": "-c default_transaction_read_only=on"},
    )
    return [json.loads(line) for line in result.stdout.splitlines()]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--expected-database", required=True)
    args = parser.parse_args()
    started = time.monotonic()
    if query("select to_json(current_database())") != [args.expected_database]:
        raise SystemExit("Unexpected restore database")
    migrations = query("select to_json(name) from app_migrations order by name")
    root = Path(__file__).resolve().parents[2]
    expected = sorted(p.name for p in (root / "packages/drizzle/migrations").glob("*.sql"))
    if migrations != expected:
        raise SystemExit("Restored migration ledger differs from this checkout")
    versions = query("""
        select json_build_array(object_key, object_version, content_hash, size_bytes, status)
        from document_versions order by version_id
    """)
    if not versions:
        raise SystemExit("No restored document versions to verify")
    invalid = query("""
        select to_json(count(*)) from extracted_values e join document_versions v using(version_id)
        where e.quote is not null and coalesce(strpos(v.parsed_text,e.quote),0)=0
    """)
    if invalid != [0]:
        raise SystemExit("Restored evidence does not match version text")
    with tempfile.TemporaryDirectory() as directory:
        pdf = Path(directory) / "version.pdf"
        for key, version, digest, size, _ in versions:
            subprocess.run(["aws", "s3api", "get-object", "--bucket", args.bucket,
                            "--key", key, "--version-id", version, str(pdf)],
                           check=True, stdout=subprocess.DEVNULL)
            if pdf.stat().st_size != size or hashlib.sha256(pdf.read_bytes()).hexdigest() != digest:
                raise SystemExit("Restored object verification failed")
            pdf.unlink()
    print(json.dumps({"verifiedVersions": len(versions), "migrations": migrations,
                      "reviewCount": query("select to_json(count(*)) from reviews")[0],
                      "pendingVersions": sum(row[-1] in ("queued", "extracting") for row in versions),
                      "verificationSeconds": round(time.monotonic() - started, 2)}))


if __name__ == "__main__":
    main()
