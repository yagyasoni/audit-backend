import pkg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool, types } = pkg;

// Return DATE columns (OID 1082) as raw "YYYY-MM-DD" strings instead of JS
// Date objects. The default parser builds a Date in the server's local
// timezone; JSON.stringify then converts it to a UTC ISO string, shifting the
// day by one on any server not in UTC. Keeping the raw string makes date
// columns timezone-proof end to end.
types.setTypeParser(1082, (val) => val);

export const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  ssl: {
    rejectUnauthorized: false,
  },
  // 🔥 CRITICAL FIXES
  max: 200, // limit total connections (VERY IMPORTANT)
  idleTimeoutMillis: 30000, // close idle connections after 30s
  connectionTimeoutMillis: 2000, // fail fast if DB unavailable
});
