// Usage: node load_master.mjs <rows.json>   — replaces master_sheet inside one transaction, after taking a backup table.
import { pool } from "/Users/yagyasoni/audit-backend/src/config/db.js";
import fs from "fs";
const rows = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const BACKUP = "master_sheet_backup_20261029";
const client = await pool.connect();
try {
  const fk = await client.query(`SELECT conname FROM pg_constraint WHERE confrelid = 'master_sheet'::regclass`);
  if (fk.rows.length) throw new Error("FKs reference master_sheet: " + fk.rows.map(r => r.conname).join(", "));
  await client.query("BEGIN");
  await client.query(`CREATE TABLE IF NOT EXISTS ${BACKUP} AS SELECT * FROM master_sheet`);
  const b = await client.query(`SELECT COUNT(*)::int n FROM ${BACKUP}`);
  await client.query("TRUNCATE master_sheet RESTART IDENTITY");
  const CH = 500;
  for (let i = 0; i < rows.length; i += CH) {
    const chunk = rows.slice(i, i + CH), vals = [], ph = [];
    chunk.forEach((r, j) => { ph.push(`($${j*5+1},$${j*5+2},$${j*5+3},$${j*5+4},$${j*5+5})`); vals.push(...r); });
    await client.query(`INSERT INTO master_sheet (bin,pcn,grp,pbm_name,payer_type) VALUES ${ph.join(",")}`, vals);
  }
  const n = await client.query("SELECT COUNT(*)::int n FROM master_sheet");
  if (n.rows[0].n !== rows.length) throw new Error(`count mismatch ${n.rows[0].n} vs ${rows.length}`);
  await client.query("COMMIT");
  console.log(`backup table ${BACKUP}: ${b.rows[0].n} rows; master_sheet now: ${n.rows[0].n} rows`);
} catch (e) { await client.query("ROLLBACK").catch(()=>{}); console.error("ROLLED BACK:", e.message); process.exitCode = 1; }
finally { client.release(); await pool.end(); }
