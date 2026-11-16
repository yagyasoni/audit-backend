import { pool } from "../config/db.js";
import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";

const seedMasterSheet = async () => {
  const filePath = path.join(process.cwd(), "src/scripts/final.csv");
  const content = fs.readFileSync(filePath, "utf-8");

  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  // Debug: print exact column names from CSV
  console.log("CSV columns:", Object.keys(records[0]));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Inside the transaction: if anything below fails, the ROLLBACK brings
    // the old master sheet back. (It used to be emptied before the
    // transaction started, so a failure left it empty.)
    await client.query(`DELETE FROM master_sheet`);
    let count = 0;
    for (const row of records) {
      // Find pbm and payer columns dynamically - dont rely on exact name
      const keys = Object.keys(row);
      const pbmKey = keys.find(k => k.toLowerCase().includes("pbm"));
      const payerKey = keys.find(k => k.toLowerCase().includes("payer"));

      const pbm = pbmKey ? row[pbmKey]?.trim().toUpperCase() : null;
      const payer = payerKey ? row[payerKey]?.trim().toUpperCase() : null;

      await client.query(
        `INSERT INTO master_sheet (bin, pcn, grp, pbm_name, payer_type)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          row['BIN']?.trim() || null,
          row['PCN']?.trim() || null,
          row['GROUP']?.trim() || null,
          pbm || null,
          payer || null,
        ]
      );
      count++;
    }
    await client.query("COMMIT");
    console.log(`✅ Seeded ${count} rows into master_sheet`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Failed:", err);
  } finally {
    client.release();
    await pool.end();
  }
};

seedMasterSheet();