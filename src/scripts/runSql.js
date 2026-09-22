// One-off helper: run a .sql file against the configured database, one
// statement at a time (so CREATE INDEX CONCURRENTLY works), then list indexes.
//
//   node src/scripts/runSql.js src/migrations/002_performance_indexes.sql
import fs from "fs";
import path from "path";
import { pool } from "../config/db.js";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node src/scripts/runSql.js <path-to-sql-file>");
  process.exit(1);
}

const sql = fs.readFileSync(path.resolve(process.cwd(), file), "utf-8");
const statements = sql
  .split(/;\s*(?:\r?\n|$)/)
  .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
  .filter(Boolean);

try {
  for (const stmt of statements) {
    const label = stmt.replace(/\s+/g, " ").slice(0, 90);
    const started = Date.now();
    await pool.query(stmt);
    console.log(`ok (${Date.now() - started} ms): ${label}`);
  }
  const { rows } = await pool.query(`
    SELECT tablename, indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename IN ('inventory_rows','wholesaler_rows','master_sheet')
    ORDER BY tablename, indexname
  `);
  console.table(rows);
} catch (err) {
  console.error("FAILED:", err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
