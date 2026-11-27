import { pool } from "./client.ts";
import { migrate } from "./migrations.ts";
try {
  await migrate();
} finally {
  await pool.end();
}
