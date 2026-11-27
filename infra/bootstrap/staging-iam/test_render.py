import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class DeploymentPolicies(unittest.TestCase):
    region = "ap-south-1"
    account = "123456789012"

    def render(self, target, environment, subject=None):
        arguments = [
            sys.executable, str(Path(__file__).with_name("render.py")),
            "--environment", environment,
            "--account-id", self.account, "--region", self.region,
            "--vpc-id", "vpc-0123456789abcdef0", "--subnet-id", "subnet-0123456789abcdef0",
            "--model-secret-arn", f"arn:aws:secretsmanager:{self.region}:{self.account}:secret:lomi/{environment}/model-AbCd12",
            "--output-dir", str(target),
        ]
        if subject:
            arguments.extend(["--github-subject", subject])
        return subprocess.run(arguments, capture_output=True, text=True)

    def test_release_scope(self):
        with tempfile.TemporaryDirectory() as work:
            for environment, other in [("staging", "prod"), ("prod", "staging")]:
                with self.subTest(environment=environment):
                    target = Path(work) / environment
                    subject = f"repo:example@123/lomi@456:environment:{environment}"
                    result = self.render(target, environment, subject)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    policies = {file.stem: json.loads(file.read_text()) for file in target.glob("*.json")}
                    prefix = f"Lomi{environment.capitalize()}"
                    self.assertNotIn(prefix + "Storage", policies)
                    self.assertNotIn(f"lomi-{other}-", json.dumps(policies))
                    self.assertNotIn(f"lomi/{other}/", json.dumps(policies))
                    self.assertNotIn("/bootstrap/", json.dumps(policies))
                    self.assertIn(f"/environments/{environment}/terraform.tfstate.tflock", json.dumps(policies))
                    storage = policies[prefix + "ReleaseStorage"]["Statement"]
                    self.assertNotIn("ecr:CreateRepository", json.dumps(storage))
                    state_bucket = f"arn:aws:s3:::lomi-{environment}-tfstate-{self.account}-{self.region}"
                    for statement in storage:
                        resources = statement["Resource"]
                        if state_bucket in (resources if isinstance(resources, list) else [resources]):
                            self.assertEqual(statement["Action"], "s3:ListBucket")

                    host_grant = next(s for s in policies[prefix + "ReleaseSsm"]["Statement"]
                                      if ":instance/" in s["Resource"])
                    self.assertEqual(host_grant["Condition"]["StringEquals"]["ssm:resourceTag/Environment"], environment)
                    trust = policies["trust"]["Statement"][0]
                    provider = "token.actions.githubusercontent.com"
                    self.assertEqual(trust["Condition"]["StringEquals"], {
                        f"{provider}:aud": "sts.amazonaws.com", f"{provider}:sub": subject,
                    })

    def test_reject_mismatched_or_wildcard_subject_before_writing(self):
        with tempfile.TemporaryDirectory() as work:
            for subject in ["repo:example/lomi:environment:staging", "repo:example/*:environment:prod"]:
                with self.subTest(subject=subject):
                    dest = Path(work) / "policies"
                    self.assertNotEqual(self.render(dest, "prod", subject).returncode, 0)
                    self.assertFalse(dest.exists())

    def test_human_bootstrap_retains_its_own_permissions(self):
        with tempfile.TemporaryDirectory() as work:
            target = Path(work) / "staging"
            result = self.render(target, "staging")
            self.assertEqual(result.returncode, 0, result.stderr)
            storage = (target / "LomiStagingStorage.json").read_text()
            self.assertIn("/bootstrap/terraform.tfstate", storage)
            self.assertIn("ecr:CreateRepository", storage)
            self.assertFalse((target / "trust.json").exists())
