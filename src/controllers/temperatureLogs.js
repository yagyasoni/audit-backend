import { pool as db } from "../config/db.js";
import { validateLog } from "../validators/temperatureLog.js";

// The client token carries userId; each pharmacy is one user account.
const pharmacyIdOf = (req) => req.user.userId;

const slug = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "pharmacy";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// createdAt is included because the page's SavedLog type expects it.
const COLUMNS = `id, setup, rows, calibration,
  created_at as "createdAt", updated_at as "updatedAt"`;

export async function list(req, res, next) {
  try {
    const { rows } = await db.query(
      `select ${COLUMNS} from temperature_logs
       where pharmacy_id = $1
       order by year desc, month desc, location_key`,
      [pharmacyIdOf(req)],
    );
    res.json({ logs: rows });
  } catch (err) {
    next(err);
  }
}

export async function save(req, res, next) {
  try {
    const errors = validateLog(req.body);
    if (errors.length) return res.status(400).json({ errors });

    const { setup, rows, calibration } = req.body;
    // node-postgres turns JS arrays into Postgres arrays, so stringify the JSON.
    const {
      rows: [log],
    } = await db.query(
      `insert into temperature_logs
         (pharmacy_id, location_key, year, month, setup, rows, calibration)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (pharmacy_id, location_key, year, month)
       do update set setup = excluded.setup, rows = excluded.rows,
                     calibration = excluded.calibration, updated_at = now()
       returning ${COLUMNS}`,
      [
        pharmacyIdOf(req),
        slug(setup.location),
        setup.year,
        setup.month + 1,
        JSON.stringify(setup),
        JSON.stringify(rows),
        JSON.stringify(calibration),
      ],
    );
    res.json({ log });
  } catch (err) {
    next(err);
  }
}

export async function remove(req, res, next) {
  try {
    // A malformed id would make Postgres throw; treat it as not found.
    if (!UUID.test(req.params.id))
      return res.status(404).json({ error: "Log not found" });

    const { rowCount } = await db.query(
      `delete from temperature_logs where id = $1 and pharmacy_id = $2`,
      [req.params.id, pharmacyIdOf(req)],
    );
    if (!rowCount) return res.status(404).json({ error: "Log not found" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
