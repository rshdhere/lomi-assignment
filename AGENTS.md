<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": true` in the root `turbo.json` or `turbo.jsonc` to opt in; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

Use the repository's `.agents/skills/commit-message/SKILL.md` when writing or proposing commit messages.

Follow the [package ownership and API contract rules](.agents/rules/architecture.md) for application changes.

## Document review assignment

Treat `assignment.md` as the acceptance contract and `SPEC.md` as the extension request. Preserve both. Use Node 24 and pnpm 10.28 workspaces. Keep build, lint and test in the Turbo task graph. Run heavy builds, browser checks and load tests in Codex Cloud against the exact changes, and monitor available RAM and swap during local focused checks.

- Seed only v1 of the three fixture documents. Reserve the revised invoice for exercising review carry-over. Keep `market_report` as the wire type.
- The dashboard uploads PDFs directly to versioned private storage. The multipart API accepts an explicit type. Verify size and PDF structure, pin the object version, and verify the whole batch before atomically publishing work. Keep the defaults of 10 files and 10 MiB configurable.
- Postgres is authoritative for versions, outcomes, evidence, chunks, prompts, raw extraction responses and review annotations. Redis and BullMQ coordinate delivery. Retain fencing and the reconciler so duplicate deliveries, worker restarts and empty Redis cannot lose reviews or leave an extraction stuck.
- Preserve immutable per-version parsed text. Require verbatim evidence for each value and a reason for each gap. A reviewer should see both the original extraction and any correction. Compare evidence within the same field across adjacent versions. A moved quote can carry its prior review. Changed evidence returns to pending with its prior review visible.
- Reject revisions during queued or active extraction with HTTP 409. Surface failures and retry controls. Return 429 with Retry-After on sensitive routes.
- Require retrieval before answering a document question. Every cited passage identifies its document version. Surface the review state and prefer reviewed corrections. Use the fixture scenarios and the isolated recovery test when changing this contract.

See [review vocabulary](GLOSSARY.md), [system design](docs/adr/0001-versioned-extraction.md), [API specification](packages/api/openapi.yaml) and [verification commands](README.md).
