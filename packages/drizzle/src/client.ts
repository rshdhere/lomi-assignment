import { config } from "@repo/config";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

export const pool = new pg.Pool({ connectionString: config.databaseUrl });
export const db = drizzle(pool);
