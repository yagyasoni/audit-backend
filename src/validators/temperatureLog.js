// A plain function, no library. It returns a list of messages; an empty
// list means the body is valid. Out-of-range readings are accepted, never
// rejected — the sheet exists to record them.

const TIME = /^([01]\d|2[0-3]):(00|30)$/;
const TEMP = /^-?\d{1,3}(\.\d)?$/;
const INITIALS = /^[A-Z]{0,4}$/;

// The page's seven sign-off inputs. Dates are free text there, so only
// type and length are checked.
const CALIBRATION_KEYS = [
  "thermometerSn",
  "performedBy",
  "calibrationDate",
  "nextDue",
  "certificateNumber",
  "picName",
  "picDate",
];

const daysInMonth = (year, month1to12) =>
  new Date(year, month1to12, 0).getDate();

export function validateLog(body) {
  const { setup, rows, calibration } = body || {};
  if (!setup || typeof setup !== "object") return ["setup is required"];
  if (!Array.isArray(rows)) return ["rows must be an array"];
  if (!calibration || typeof calibration !== "object")
    return ["calibration is required"];

  const errors = [];
  const year = Number(setup.year);
  const month = Number(setup.month); // 0-11 from the page
  if (!Number.isInteger(year) || year < 2000 || year > 2100)
    errors.push("setup.year is invalid");
  if (!Number.isInteger(month) || month < 0 || month > 11)
    errors.push("setup.month must be 0-11");
  if (![1, 2].includes(setup.fridges))
    errors.push("setup.fridges must be 1 or 2");
  if (typeof setup.location !== "string" || setup.location.length > 120)
    errors.push("setup.location is invalid");
  if (!TIME.test(setup.amTime || "") || setup.amTime >= "12:00")
    errors.push("setup.amTime must be HH:00 or HH:30 before 12:00");
  if (!TIME.test(setup.pmTime || "") || setup.pmTime < "12:00")
    errors.push("setup.pmTime must be HH:00 or HH:30 from 12:00");
  for (const k of ["amInitials", "pmInitials"])
    if (!INITIALS.test(setup[k] || ""))
      errors.push(`setup.${k} must be up to 4 letters`);
  for (const k of Object.keys(calibration))
    if (!CALIBRATION_KEYS.includes(k))
      errors.push(`calibration.${k} is not a known field`);
  for (const k of CALIBRATION_KEYS)
    if (typeof calibration[k] !== "string" || calibration[k].length > 200)
      errors.push(`calibration.${k} must be text of at most 200 characters`);
  if (errors.length) return errors;

  const expected = daysInMonth(year, month + 1);
  if (rows.length !== expected)
    return [`rows must have ${expected} entries for this month`];

  const keys =
    setup.fridges === 2
      ? ["ambient", "fridge1", "fridge2"]
      : ["ambient", "fridge1"];
  const pad = (n) => String(n).padStart(2, "0");

  rows.forEach((row, i) => {
    const date = `${year}-${pad(month + 1)}-${pad(i + 1)}`;
    if (row?.date !== date) errors.push(`rows[${i}].date must be ${date}`);
    for (const p of ["am", "pm"]) {
      const e = row?.[p];
      if (!e) {
        errors.push(`rows[${i}].${p} is required`);
        continue;
      }
      const wrongHalf = p === "am" ? e.time >= "12:00" : e.time < "12:00";
      if (!TIME.test(e.time || "") || wrongHalf)
        errors.push(`rows[${i}].${p}.time is invalid`);
      for (const k of keys)
        if (e[k] !== "" && !TEMP.test(String(e[k])))
          errors.push(
            `rows[${i}].${p}.${k} must be a number with at most one decimal`,
          );
      if (!INITIALS.test(e.initials || ""))
        errors.push(`rows[${i}].${p}.initials is invalid`);
      if (typeof e.comment !== "string" || e.comment.length > 500)
        errors.push(`rows[${i}].${p}.comment is invalid`);
    }
  });
  return errors;
}
