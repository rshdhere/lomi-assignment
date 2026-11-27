import { cpus } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "@repo/config";
import { classifyModel, classifyRegex } from "./classify.ts";
import { parsePdf } from "./pdf.ts";

type Fixture = { type: string; versions: { version: number; file: string }[] };
const fixtures: Fixture[] = JSON.parse(
  await readFile(join(config.fixturesDir, "documents.json"), "utf8"),
);
console.log(
  JSON.stringify({
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    model: config.openaiModel,
  }),
);
async function measure(run: () => unknown) {
  const start = performance.now();
  try {
    return { type: await run(), ms: performance.now() - start };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      ms: performance.now() - start,
    };
  }
}
for (const doc of fixtures) {
  for (const version of doc.versions) {
    const text = await parsePdf(
      await readFile(join(config.fixturesDir, version.file)),
    );
    const [regex, model] = await Promise.all([
      measure(() => classifyRegex(text)),
      config.openaiApiKey
        ? measure(() => classifyModel(text))
        : Promise.resolve({ skipped: "Missing OPENAI_API_KEY" }),
    ]);
    console.log(
      JSON.stringify({ file: version.file, expected: doc.type, regex, model }),
    );
  }
}
