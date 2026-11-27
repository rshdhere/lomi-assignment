"""Render environment-specific Terraform operator or GitHub release IAM policies."""

import argparse
import json
import re
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment", choices=("staging", "prod"), default="staging")
    parser.add_argument("--github-subject", help="Exact GitHub OIDC environment subject for the release role")
    for arg in ("account-id", "region", "vpc-id", "subnet-id", "model-secret-arn"):
        parser.add_argument(f"--{arg}", required=True)
    parser.add_argument("--model-kms-key-arn", help="Customer-managed key for the model secret")
    parser.add_argument("--hosted-zone-id", help="Existing Route 53 hosted zone")
    parser.add_argument("--app-hostname")
    parser.add_argument("--api-hostname")
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()

    def check(value, pattern, label):
        if not re.fullmatch(pattern, value, re.ASCII):
            parser.error(f"invalid {label}")
        return value

    account = check(args.account_id, r"[0-9]{12}", "AWS account ID")
    region = check(args.region, r"[a-z]{2}-[a-z]+-[1-9][0-9]*", "commercial AWS region")
    resource_id = r"(?:[0-9a-f]{8}|[0-9a-f]{17})"
    values = {
        "ENVIRONMENT": args.environment,
        "ENVIRONMENT_TITLE": args.environment.capitalize(),
        "ACCOUNT_ID": account,
        "REGION": region,
        "VPC_ID": check(args.vpc_id, "vpc-" + resource_id, "VPC ID"),
        "SUBNET_ID": check(args.subnet_id, "subnet-" + resource_id, "subnet ID"),
        "MODEL_SECRET_ARN": check(
            args.model_secret_arn,
            f"arn:aws:secretsmanager:{region}:{account}:secret:" + r"[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}",
            "model secret ARN for the supplied account and region",
        ),
    }
    if args.github_subject:
        owner, repo = r"[A-Za-z0-9-]+", r"[A-Za-z0-9_.-]+"
        repository = rf"(?:{owner}/{repo}|{owner}@[1-9][0-9]*/{repo}@[1-9][0-9]*)"
        values["GITHUB_SUBJECT"] = check(
            args.github_subject, rf"repo:{repository}:environment:{args.environment}",
            "GitHub subject for the selected environment",
        )
    if args.github_subject or args.environment == "prod":
        check(
            args.model_secret_arn,
            rf"arn:aws:secretsmanager:{region}:{account}:secret:lomi/{args.environment}/model-[A-Za-z0-9]{{6}}",
            "lomi environment model secret ARN",
        )
    if args.model_kms_key_arn:
        values["MODEL_KMS_KEY_ARN"] = check(
            args.model_kms_key_arn,
            f"arn:aws:kms:{region}:{account}:key/"
            + r"(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|mrk-[a-f0-9]{32})",
            "model key ARN for the supplied account and region",
        )
    dns = (args.hosted_zone_id, args.app_hostname, args.api_hostname)
    if any(dns):
        if not all(dns) or args.app_hostname == args.api_hostname:
            parser.error("Route 53 requires a hosted zone and two distinct lowercase hostnames")
        values["HOSTED_ZONE_ID"] = check(args.hosted_zone_id, r"Z[A-Z0-9]+", "zone ID")
        label = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
        for key, name in (("APP_HOSTNAME", args.app_hostname), ("API_HOSTNAME", args.api_hostname)):
            values[key] = check(name, rf"(?=.{{1,253}}$)(?:{label}\.)+[a-z]{{2,63}}", key)

    directory = Path(__file__).parent
    prefix = f"Lomi{args.environment.capitalize()}"
    paths = {f"{prefix}{p.stem.removeprefix('LomiStaging')}.json": p
             for p in (directory / "templates").glob("*.json")}
    if not args.hosted_zone_id:
        del paths[f"{prefix}DNS.json"]
    if args.github_subject:
        del paths[f"{prefix}Storage.json"]
        paths[f"{prefix}ReleaseStorage.json"] = directory / "github" / "ReleaseStorage.json"
        paths[f"{prefix}ReleaseSsm.json"] = directory / "github" / "ReleaseSsm.json"
        paths["trust.json"] = directory / "github" / "trust.json"

    policies = {}
    for filename, path in sorted(paths.items()):
        policy = json.loads(path.read_text())
        if path.stem == "LomiStagingWorkloadBoundary" and not args.model_kms_key_arn:
            policy["Statement"] = [s for s in policy["Statement"] if s["Sid"] != "RuntimeModelKey"]
        document = re.sub(r"\{\{(\w+)\}\}", lambda m: values[m[1]], json.dumps(policy))
        rendered = json.loads(document)
        if len(json.dumps(rendered, separators=(",", ":"))) > 6144:
            parser.error(f"{filename} exceeds the IAM managed policy size limit")
        policies[filename] = json.dumps(rendered, indent=2) + "\n"

    args.output_dir.mkdir(parents=True, exist_ok=True)
    if any(args.output_dir.iterdir()):
        parser.error("--output-dir must be empty to avoid reusing policies from a previous render")
    for name, contents in policies.items():
        (args.output_dir / name).write_text(contents)
        print(args.output_dir / name)


if __name__ == "__main__":
    main()
