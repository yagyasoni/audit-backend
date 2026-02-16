import fs from "fs";
import path from "path";
import { pool } from "./db.js";

const migrationsDir = path.join(process.cwd(), "src/migrations");

async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      run_at TIMESTAMP DEFAULT NOW()
    );
  `);

  const files = fs.readdirSync(migrationsDir).sort();

  for (const file of files) {
    const result = await pool.query(
      "SELECT * FROM migrations WHERE filename = $1",
      [file]
    );

    if (result.rows.length === 0) {
      console.log("Running:", file);

      const sql = fs.readFileSync(
        path.join(migrationsDir, file),
        "utf-8"
      );

      await pool.query(sql);

      await pool.query(
        "INSERT INTO migrations(filename) VALUES($1)",
        [file]
      );
    }
  }

  console.log("Migrations complete");
  process.exit();
}

runMigrations();
