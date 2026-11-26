# Take-Home Assignment — Senior Full Stack Engineer, Lomi Labs

Thanks for making it to this stage. This assignment is a miniature of the kind of system you'd build with us: PDF documents go in, an LLM extracts structured values, and a human reviews every value before it's trusted — including when a document comes back revised.

**Deadline: Saturday 28 November 2026 at 23:59 UTC.**

We'd rather see a smaller thing done well than everything half-done. If you run out of time, cut scope deliberately and say so in your README — knowing what to cut is part of what we're evaluating.

A note before you start: some decisions in this brief are deliberately left open, and some of the options we mention are deliberately tempting. There is no single correct architecture — but every choice you make is part of the evaluation.

---

## The problem

Our clients send us documents as PDFs (invoices, leases, reports). We extract key values from them with an LLM, but extraction is never trusted blindly: a reviewer checks each extracted value against the exact passage it came from and approves or corrects it. And documents change — a client sends a revised version, and the work already reviewed must not be thrown away.

Build a small app that does this end to end:

1. **Ingest** a PDF document.
2. **Extract** values from it with an LLM.
3. **Review** each value in a web UI — see it beside its source quote, approve it or correct it.
4. **Re-extract** when a new version of the document arrives — carrying over reviews whose evidence didn't change.

## What we provide

The `fixtures/` folder in this repo:

- `fixtures/documents/` — four sample PDFs: an invoice, a **revised version of the same invoice**, a lease excerpt, and a market report excerpt.
- `fixtures/documents.json` — the manifest: each document's id, type, title, and versions. Seed only version 1 of each document; the invoice's version 2 exists so you (and we) can exercise re-extraction by uploading it.
- `fixtures/expected-fields.json` — the fields to extract per document type.

## What you build

### 0. A monorepo

Structure the project as a **single monorepo managed with Turborepo** (on top of pnpm or yarn workspaces), with a task pipeline that actually does something — build, test, and lint wired through `turbo.json`, not a decorative config. How you split it into packages and where you draw the boundaries is entirely up to you, and it's part of what we evaluate. One `docker compose up` at the repo root must still start everything.

### 1. API (Node.js + TypeScript)

- `POST /documents` — upload a PDF (type + file).
- `POST /documents/:id/versions` — upload a new PDF for an existing document.
- `GET /documents/:id` — current version, status (`queued`, `extracting`, `extracted`, `failed`), and the extracted values once ready.
- `POST /values/:id/review` — approve a value as-is, or correct it. Whether a correction replaces the value or lives beside it as an annotation is your call — pick one model and keep the API and UI consistent with it.
- `GET /documents/:id/progress` — counts of pending / approved / corrected / carried-over values.

Express, Nest, Fastify — your choice. **Postgres is the system of record** for documents, values, and reviews. **Extraction work runs through a Redis-backed job queue** (BullMQ or similar). Draw the Redis/Postgres line carefully: Redis coordinates work; anything that must survive — extracted values, reviews, job outcomes a user can see — lives in Postgres. Where exactly you put that line, and how the two stay consistent when one of them fails, is part of what we evaluate.

### 2. Extraction: PDF → LLM

The extraction itself is **LLM-based — this is not optional**. Parse the PDF's text (any library you like), send it to an LLM (Anthropic, OpenAI, or any provider with structured output — your choice), and ask for the document type's expected fields.

How extraction runs is yours to design, but these behaviors are required and we test them:

- **Uploading must feel instant.** `POST /documents` responds right away; extraction takes as long as the LLM takes, and the UI shows the document's status while it's underway. An upload must never wait for the LLM.
- **A restart must not lose work.** If we `docker compose restart` (or kill a container) mid-extraction, the system comes back and the document either completes or is visibly retryable — never stuck in `extracting` forever, never silently lost.
- **Extracting the same document version twice must not duplicate values** — however the second run happens (a retry, a crash recovery, an impatient user).
- **A failure is a state, not an exception.** An LLM or parsing error leaves the document visibly `failed` and retryable.
- **A Redis flush is not a disaster.** If we run `FLUSHALL` on Redis and restart the stack, no extracted value, review, or visible job outcome is lost, and any document that was mid-extraction ends up completed or visibly retryable — never stuck. We will do this.

And for the extraction's output:

- **Each extracted value must carry its evidence**: the exact passage of the document it came from. You must **validate that the quoted evidence actually appears verbatim in the parsed text of the version being extracted** — a value whose evidence doesn't appear there is stored as a **gap** (`value: null`, with a reason), never kept. This is your hallucination defense, and we test it.
- A field the LLM can't find is a **gap with a reason**, never a guess.
- Whether you store each version's parsed text or re-parse on demand is your call — but evidence validation and the review UI for version N must always work against version N's text, including after version N+1 exists.
- The sample documents are a page each — a full test cycle costs well under a dollar on any mainstream model. Keep the prompt and the raw LLM response stored or logged per extraction so it's debuggable.

### 3. Re-extraction and review carry-over

When a new version of a document is uploaded and extracted:

- A value whose **evidence is unchanged** between versions keeps its review (approval or correction) and is marked **carried over**.
- A value whose evidence **changed** goes back to **pending**, with the previous version's value and review shown beside it so the reviewer sees what changed.
- Nothing from the old version is deleted: earlier versions and their reviews remain queryable.
- A new version can arrive **while the previous one is still extracting**. Decide what happens — reject, queue, supersede — and document it. We will try it.

Deciding what "unchanged" means — and making it hold up when the whole document's text shifts around — is yours to design. Explain your approach in the README. The revised invoice in `fixtures/` changes two fields and leaves the rest alone; after uploading it, a reviewer should have exactly the changed values to re-review.

### 4. Review UI (React — Next.js or Vite, your choice)

- A document list with extraction status, current version, and review progress. Whether the UI polls, streams, or refreshes on demand is your call — pick what this problem actually needs and say why.
- A document detail view: each extracted value shown **beside its source quote** (highlighting the quote within the document text is a nice touch, not a requirement).
- Approve / correct actions per value. Corrections need a value and optionally a note.
- Gaps visible with their reasons, never hidden.
- After a re-extraction: carried-over values distinguishable from newly pending ones, and changed values showing their previous value and review.

Polish matters less than clarity: a reviewer should understand what needs their attention within five seconds of opening the page.

### 5. Running locally

```sh
docker compose up
```

at the repo root must start everything your system needs, run migrations, and seed version 1 of the sample documents from `fixtures/` so we can click around immediately.
If you are able to deploy, share us the live link.

### 6. Tests

Test what's most likely to break.

### 7. README

Short, written for an engineer joining the project:

- How to run it and what to click first.
- How the monorepo is laid out and why.
- Your schema and why — especially how versions, values, and reviews relate.
- How extraction is coordinated: what lives in Redis, what lives in Postgres, and how they stay consistent when one fails.
- The open decisions this brief left you, what you chose, and why.
- What you cut for time, and what you'd do next.
- Anything you'd change at 10,000 documents.

## Rules

- **AI coding tools are allowed and expected** — we use them daily. You own every line you submit: the interview digs into your design decisions, and "the AI wrote that part" is not an answer we can hire on. You should submit your coding agent session logs along with the code.
  - _Getting your logs from Claude Code:_ every session is saved as a JSONL file under `~/.claude/projects/<your-project-folder>/` — copy the `.jsonl` files for the sessions you used. Alternatively, run `/export` inside a session to save that conversation as a readable file. Other tools (Cursor, Codex, etc.): export or copy whatever session history the tool provides.
  - _Where to put them:_ upload the exported log(s) to a **public GitHub Gist** ([gist.github.com](https://gist.github.com)) — one gist, one file per session — and submit the gist link. Don't attach raw `.jsonl` files and don't commit them into the repo.
- **Any libraries you like.** Prisma, Drizzle, raw SQL; any PDF parser; any LLM SDK. Choose what you'd defend.

## Submitting

Submit everything at **[submit.lomilabs.ai](https://submit.lomilabs.ai)** — that portal is the only submission channel, so don't email it to us.

What to include:

1. **Code** — your git repo link, public or with access granted to us. If you deployed it, the live link too.
2. **Coding agent session log** — the gist link from the Rules section above. Make sure the gist is public, not secret.
3. **Explanation video — bonus, and it counts for a lot.** Not required, but a few minutes of you walking us through the app and talking through the decisions you made — what you chose, what you cut, what you'd do differently — tells us more than the code alone, and it's the best way to show the thinking behind it. Upload it to **[Loom](https://loom.com)**, **[Cap.so](https://cap.so)**, or **Google Drive**, and set sharing so **anyone with the link can view** it (on Drive: _Anyone with the link_ → _Viewer_). Open the link in an incognito window before you submit — a link only you can see is the same as no link.

Double-check every link you submit resolves for someone who isn't you.
