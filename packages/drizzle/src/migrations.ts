import { readFile, readdir } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { db } from "./client.ts";

export async function migrate() {
  const directory = new URL("../migrations/", import.meta.url);
  const files = (await readdir(directory))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(15012026)`);
    await tx.execute(
      sql`create table if not exists app_migrations (name text primary key)`,
    );
    for (const file of files) {
      const applied = await tx.execute(
        sql`select 1 from app_migrations where name=${file}`,
      );
      if (applied.rowCount) continue;
      await tx.execute(
        sql.raw(await readFile(new URL(file, directory), "utf8")),
      );
      await tx.execute(sql`insert into app_migrations values (${file})`);
    }
  });
}
