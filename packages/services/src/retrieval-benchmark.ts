import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { pool, searchChunks, type SearchHit } from "@repo/drizzle";
import { embed } from "./model.ts";

type QueryCase = {
  query: string;
  document: string;
  version: number;
  passages: string[];
};
const cases: QueryCase[] = JSON.parse(
  await readFile(
    new URL("../../../fixtures/retrieval-cases.json", import.meta.url),
    "utf8",
  ),
);

function fuse(lists: SearchHit[][]) {
  const scores = new Map<string, { hit: SearchHit; score: number }>();
  for (const list of lists) {
    for (const [index, hit] of list.entries()) {
      const row = scores.get(hit.id) ?? { hit, score: 0 };
      row.score += 1 / (60 + index + 1);
      scores.set(hit.id, row);
    }
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score || a.hit.id.localeCompare(b.hit.id))
    .slice(0, 6)
    .map((row) => row.hit);
}

try {
  for (const entry of cases) {
    const start = performance.now();
    const lexical = await searchChunks("lexical", entry.query, undefined);
    const lexicalMs = performance.now() - start;
    const vector = (await embed([entry.query]))[0];
    const semantic = await searchChunks("semantic", entry.query, vector);
    const hybrid = fuse([lexical, semantic]);
    for (const [mode, hits] of Object.entries({ lexical, semantic, hybrid })) {
      const eligible = hits.filter(
        (h) => h.documentId === entry.document && h.version === entry.version,
      );
      const count = entry.passages.filter((p) =>
        eligible.some((h) => h.text.includes(p)),
      ).length;
      console.log(
        JSON.stringify({
          query: entry.query,
          mode,
          recallAt6: count / entry.passages.length,
          allPassages: count === entry.passages.length,
          lexicalMs,
          combinedMs: performance.now() - start,
        }),
      );
    }
  }
} finally {
  await pool.end();
}
