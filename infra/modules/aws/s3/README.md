# PDF storage

The AWS S3 module owns the private, versioned PDF bucket and the roles used to sign uploads and read stored object versions. The API records the S3 version ID and SHA-256 digest after verifying an upload. Extraction reads that exact version. The local Compose stack runs the same application flow against MinIO.

## AWS environments

The parent AWS module supplies three inputs.

| Input              | Purpose                                                         |
| ------------------ | --------------------------------------------------------------- |
| `name`             | Prefix for environment-specific storage resources and roles     |
| `app_hostname`     | Dashboard hostname allowed to submit browser uploads over HTTPS |
| `runtime_role_arn` | EC2 host role trusted to assume the document access roles       |

The module returns `bucket_name` and `role_arns`. The `app` role can write and read documents under `documents/`. The `worker` role can read a pinned object version. The host assumes each role separately and makes its short-lived credentials available to the applicable container. Public access is blocked and the bucket policy enforces TLS. [AWS deployment guide](../../../README.md)

When upgrading an existing environment, run the usual environment `terraform init` and `terraform plan`. The parent module's `moved` blocks map the existing storage and role addresses into the child module automatically. The plan should show the address changes while preserving the bucket and its version history. Apply the reviewed plan through the normal environment workflow.

## Local Compose

Run `docker compose up` from the repository root. The browser uploads to MinIO on `localhost:9000` using signed POST fields that fix the key, PDF content type and permitted byte count. The API verifies the bytes and PDF structure through the internal `storage:9000` endpoint.

The storage initializer waits for MinIO, enables versioning on `review-pdfs`, disables anonymous access and provisions distinct application and worker accounts. The API uses the upload account. The worker uses the version-read account. The initialization credentials stay in the storage services. Database migration and fixture seeding wait for the initializer to complete successfully. To check that step, run `docker compose logs storage-init`. [Initializer](local/init.sh) · [API policy](local/app-policy.json) · [Worker policy](local/worker-policy.json)
