import { pool as db } from "../config/db.js";
import { validateLog } from "../validators/temperatureLog.js";

// The client token carries userId; each pharmacy is one user account.
const pharmacyIdOf = (req) => req.user.userId;

// The key of a log's location. All non-space characters are kept (also "#"
// and punctuation), so "Fridge #1" and "Fridge 1" get different keys and do
// not overwrite each other.
const slug = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    || "pharmacy";

// The same key, computed by the database from a stored log's own location
// name (alias = the table alias). Must give the same result as slug().
const SLUG_SQL = (alias) =>
  `coalesce(nullif(regexp_replace(lower(btrim(${alias}.setup->>'location', E' \\t\\n\\r')), '\\s+', '-', 'g'), ''), 'pharmacy')`;

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
    const pharmacyId = pharmacyIdOf(req);
    const year = setup.year;
    const month = Number(setup.month) + 1;

    // Logs saved before the key format changed are stored under the OLD key
    // ("Fridge #1" was saved as "fridge-1"). Before saving, move this
    // month's older logs to the key their own location name gives today.
    // Without this, saving an existing "Fridge #1" log would create a second
    // log for the same month, and saving "Fridge 1" would overwrite the
    // older "Fridge #1" log. A row is left alone when its new key is taken.
    await db.query(
      `update temperature_logs t
          set location_key = ${SLUG_SQL("t")}
        where t.pharmacy_id = $1 and t.year = $2 and t.month = $3
          and t.location_key <> ${SLUG_SQL("t")}
          and not exists (
            select 1 from temperature_logs o
             where o.pharmacy_id = t.pharmacy_id
               and o.year = t.year and o.month = t.month
               and o.id <> t.id
               and o.location_key = ${SLUG_SQL("t")}
          )`,
      [pharmacyId, year, month],
    );

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
        pharmacyId,
        slug(setup.location),
        year,
        month,
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
