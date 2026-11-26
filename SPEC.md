we have to build an end-to-end document-retrival-augmented-generation-pipeline

So user's will come on to the dashboard and upload some documents

- only pdf as a file-format/documents are allowed so do a proper validation at the time of ingestion
- user shall not be able to bombard the dashboard so make sure they receive proper 429s on sensative endpoints
- hold up document validation and user's may not upload with file size more than a certain thrishold

Now comes the Ingestion-Pipeline

- upload the documents to S3 using pre-signed urls directly from the dashboard
- enable S3 versioning and make sure S3 bucket aint exposed to the internet, double-check bucket-policy and iam rules for it
- even if the user uploads multiple pdf's at the same time queue the process and move forward only when all is stored in S3
- perform a good study on various in-famous ingestion piplines out there like **Lambda & Kappa Architecture** and make our's robust
- cover any missed edge-cases on your own but do ask a few questions before implementing any

Now the documents are stored securely in our S3 bucket

- now use GPT-6.2 Luna API to figure out what type is the document provided, for the fall-back use regex-parsing (try both at the same time while development figure out which takes more time local(with CPU specs mentioned) or API pick and choose whichever is fast on diffrent benchmarks)
- model doc-type (source-qoute) -> invoices, leases & reports only
- use Drizzle ORM to communicate with postgresql
- model docs -> doc_id, title, source_type, document_type, created_at, updated_at, version, content_hash, metadata
- so after figuring-out what's the document type it'll be feeded to 03 diffrent system-prompts named invoice-parser, lease-parser and report-parser, now based on the doc-type we'll figure-out which parser do we need to submit the pdf
- now one of the parser (with a well-suited system-prompt) has successfully received the pdf

Now here enters **Chunking & Indexing**

- now after receiving a pdf, llm chunks the pdf
- model chunks -> chunk_id, doc_id, parent_id, doc_type, metadata, text
- now perform **Semantic-Chunking** (vectors) and **Metadata Enrichment** (with proper Indexing and Lexical-Search), here we can use pg_vector as our vector db as we are already using postgresql as our primary database
- both of the functions can be performed paralley using a promise.all()

Now even if the user queries

- LLM shall make a tool-call prior analyzing the question to weather it is a Lexical or Sematic/Vector Question

Now I wanted you to stick to the provided [assignment](./assignment.md) which is superior to SPEC.md and if there's any edge-case we missed from it, I want you to update our [AGENTS.md](./AGENTS.md) with the entire context of what we are trying to build in peace

Before everything I also want you to use the /grill-w-docs skill by matt-pocock to ask as many question(s) you wd like to ask to have a proper context of what we trying to build another skill /codebase-design by matt-pocock for structuring the codebase well and with the final image ready then create a architecure.excalidraw/ and architecure.png/ inside root docs/ and then finally update the [AGENTS.md](./AGENTS.md)

when the application is ready then we'll perform some high-level load-tests to see what breaks on various diffrent time-lines and scenarios then we can come up with a confident strategy to fix it at scale so that we dont just assume that we might have to do this just like that 10K pdf's scale and then we can figure out where to use REDIS, QUEUE (BullMQ). So let's build first then break it, to see where we can actually improve and then, finally build a production-ready pipeline for the given assignment and attach all the proof's as screenshots in the individual README.md of the folders do not deviate nor hallucinate from provided [assignment](./assignment.md) as [SPEC.md](./SPEC.md) will be un-changed and written by raashed with bare hands so that we can start to build V0->V1->V2->V3 to complete the over-all assignment
