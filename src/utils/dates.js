// Dates that arrive as text in an uploaded file (claims "date filled",
// wholesaler "invoice date").
//
//   cleanDate(value)  → "YYYY-MM-DD", or null when there is no usable date
//   isBadDate(value)  → true when the cell clearly holds a date that does not
//                       exist (month 13, 31 June). That almost always means a
//                       day/month/year file is being read as month/day/year,
//                       so the upload is refused with a clear message instead
//                       of saving wrong or empty dates.
//
// Formats understood (a time after the date is ignored):
//   2025-03-15      20250315
//   3/15/2025       03/15/25       3-15-2025      03-15-25
//   45731           (Excel serial number)

const pad = (n) => String(n).padStart(2, "0");

// "YYYY-MM-DD" when the three numbers are a real calendar date, else null.
function ymd(year, month, day) {
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31)
    return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  )
    return null; // e.g. 30 February
  return `${year}-${pad(month)}-${pad(day)}`;
}

const fullYear = (twoDigits) =>
  twoDigits >= 70 ? 1900 + twoDigits : 2000 + twoDigits;

// Drops a trailing time: "3/15/2025 10:30 AM", "2025-03-15T10:30:00.000Z"
const stripTime = (value) =>
  String(value)
    .trim()
    .replace(/[T\s]+\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(Z|[AP]M)?$/i, "")
    .trim();

export function cleanDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const s = stripTime(value);
  if (!s) return null;

  let m;

  // YYYY-MM-DD
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)))
    return ymd(+m[1], +m[2], +m[3]);

  // YYYYMMDD
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/)))
    return ymd(+m[1], +m[2], +m[3]);

  // M/D/YYYY or M-D-YYYY
  if ((m = s.match(/^(\d{1,2})([/-])(\d{1,2})\2(\d{4})$/)))
    return ymd(+m[4], +m[1], +m[3]);

  // M/D/YY or M-D-YY
  if ((m = s.match(/^(\d{1,2})([/-])(\d{1,2})\2(\d{2})$/)))
    return ymd(fullYear(+m[4]), +m[1], +m[3]);

  // Excel serial number
  if (/^\d+(\.\d+)?$/.test(s)) {
    const serial = parseFloat(s);
    if (serial >= 10000 && serial <= 80000) {
      const d = new Date((serial - 25569) * 86400 * 1000);
      if (!isNaN(d.getTime()))
        return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    return null;
  }

  // Last resort: let JS try (for example "Mar 15, 2025")
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime()))
    return ymd(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());

  return null;
}

// Looks like a date (numbers with / or - between them, or 8 digits) ...
const DATE_LIKE = /^(\d{1,4}[/-]\d{1,2}[/-]\d{1,4}|\d{8})$/;

// ... but is not one that exists. Text that is not a date at all ("N/A",
// "pending") is not "bad": it is simply treated as empty, as before.
export function isBadDate(value) {
  if (value === null || value === undefined || value === "") return false;
  const s = stripTime(value);
  return DATE_LIKE.test(s) && cleanDate(value) === null;
}

// The message shown to the user when a file is refused for its dates.
//   what     : "This file" or the wholesaler name
//   examples : [{ line, value }]
export function badDateMessage(what, examples) {
  const total = examples.length;
  const shown = examples
    .slice(0, 3)
    .map((e) => `line ${e.line}: "${e.value}"`)
    .join(", ");
  return (
    `${what} has ${total} date${total === 1 ? "" : "s"} that ` +
    `${total === 1 ? "does" : "do"} not exist (${shown}). ` +
    "Dates are read as month/day/year, for example 01/13/2025. " +
    "Nothing was changed. Please correct the file and upload it again."
  );
}
