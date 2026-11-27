import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "@repo/config";
import { createBatch, listDocuments, migrate, pool } from "@repo/drizzle";
import { putPdf } from "@repo/services";
import { fixtureManifest } from "@repo/validators";

try {
  await migrate();
  const manifest = fixtureManifest.parse(
    JSON.parse(
      await readFile(join(config.fixturesDir, "documents.json"), "utf8"),
    ),
  );
  const existing = new Set((await listDocuments()).map((d) => d.id));
  for (const doc of manifest) {
    if (existing.has(doc.id)) continue;
    const first = doc.versions.find((v) => v.version === 1);
    if (!first) throw new Error(`Missing version 1 for ${doc.id}`);
    const key = `documents/fixtures/${doc.id}/1.pdf`;
    const bytes = await readFile(join(config.fixturesDir, first.file));
    const stored = await putPdf(key, bytes);
    await createBatch([
      { ...stored, key, title: doc.title, type: doc.type, seedId: doc.id },
    ]);
    console.log(`Queued fixture ${doc.id} version 1`);
  }
} finally {
  await pool.end();
}
