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
  max: 20, // small pool: a micro RDS allows ~80 connections in total
  idleTimeoutMillis: 30000, // close idle connections after 30s
  // Wait up to 10 seconds for a free connection. 2 seconds was short enough
  // for ordinary requests to fail while a large upload was being saved.
  connectionTimeoutMillis: 10000,
});

// A connection that drops while it waits in the pool raises an "error" event
// on the pool. With nobody listening, Node treats it as an uncaught error and
// the whole backend stops. Log it; the pool opens a new connection by itself.
pool.on("error", (err) => {
  console.error(
    "Database connection lost (the pool will reconnect):",
    err?.message || err,
  );
});
