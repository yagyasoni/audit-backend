import fs from "fs";
import { parse } from "csv-parse/sync";
import { UploadRefused } from "./uploadRefused.js";

// Maps frontend key -> DB column name
const FRONT_TO_DB = {
  ndcNumber: "ndc",
  rxNumber: "rx_number",
  status: "status",
  dateFilled: "date_filled",
  drugName: "drug_name",
  quantity: "quantity",
  packageSize: "package_size",
  primaryInsuranceBinNumber: "primary_bin",
  primaryInsurancePcn: "primary_pcn",
  primaryInsuranceGroup: "primary_group",
  primaryInsurancePaid: "primary_paid",
  secondaryInsuranceBinNumber: "secondary_bin",
  secondaryInsurancePcn: "secondary_pcn",
  secondaryInsuranceGroup: "secondary_group",
  secondaryInsurancePaid: "secondary_paid",
  brand: "brand",
  patientCopay: "patient_copay",
};

// Finds the column the user picked for a field. Exact name first, then the
// same name ignoring upper/lower case and spaces around it. -1 = not found.
function findColumn(headers, selectedHeader) {
  const exact = headers.lastIndexOf(selectedHeader);
  if (exact !== -1) return exact;
  const wanted = selectedHeader.toLowerCase().trim();
  return headers.findIndex((h) => h.toLowerCase().trim() === wanted);
}

// Reads an uploaded claims (inventory) CSV.
//
// headerMapping comes from the upload screen: { rxNumber: "<column name in
// the file>", dateFilled: "...", ... }.
//
// Returns:
//   rows        one object per usable row, keyed by database column name
//   totalRows   data rows found in the file (the header is not counted)
//   skippedRows rows left out because they do not have the same number of
//               columns as the header (their values would land in the wrong
//               fields)
//
// Why this reader: these exports often carry an inch mark inside a drug name
// (GAUZE 4"X4). A strict CSV reader takes that mark as the start of a quoted
// field and swallows the rows after it without any error. relax_quotes reads
// such a mark as plain text, the same way the file preview already does.
export function readInventoryCSV(inputPath, headerMapping = {}) {
  const text = fs.readFileSync(inputPath, "utf8");

  let records;
  try {
    records = parse(text, {
      bom: true,
      relax_quotes: true,
      relax_column_count: true,
      skip_empty_lines: true,
      info: true,
    });
  } catch (err) {
    // For example a field that starts with a quote that is never closed.
    throw new UploadRefused(
      `The file could not be read as a CSV (${err.message}). Nothing was changed. Please fix the file and upload it again.`,
    );
  }

  if (records.length === 0) {
    throw new UploadRefused("The file is empty. Please upload a CSV with a header row.");
  }

  const headers = records[0].record.map((h) => String(h ?? "").trim());
  const width = headers.length;

  // Which column of the file feeds which database field.
  const columns = [];
  for (const [frontKey, selectedHeader] of Object.entries(headerMapping || {})) {
    const dbKey = FRONT_TO_DB[frontKey];
    if (!dbKey) continue;

    // Field left unmapped on the upload screen.
    if (
      selectedHeader === null ||
      selectedHeader === undefined ||
      selectedHeader === ""
    ) {
      columns.push({ dbKey, index: -1 });
      continue;
    }

    if (typeof selectedHeader !== "string") {
      throw new UploadRefused(
        `The column chosen for "${frontKey}" is not valid. Please map the columns again.`,
      );
    }

    columns.push({ dbKey, index: findColumn(headers, selectedHeader) });
  }

  const rows = [];
  let totalRows = 0;
  let skippedRows = 0;
  let previousLine = records[0].info.lines;

  for (let i = 1; i < records.length; i++) {
    const { record, info } = records[i];

    // How many lines of the file this record used. Normally 1. More than 1
    // means a quote swallowed line breaks, so several rows became one.
    const linesUsed = Math.max(1, info.lines - previousLine);
    previousLine = info.lines;

    const extraColumnsAreEmpty =
      record.length > width &&
      record.slice(width).every((v) => String(v ?? "").trim() === "");

    if (record.length !== width && !extraColumnsAreEmpty) {
      // Wrong number of columns: every value after the break would land in
      // the wrong field, so the row is refused and counted.
      totalRows += linesUsed;
      skippedRows += linesUsed;
      continue;
    }

    totalRows += 1;

    // _line: where the row ends in the file (used in messages to the user)
    const dbRow = { _line: info.lines };
    for (const { dbKey, index } of columns) {
      const value = index === -1 ? "" : String(record[index] ?? "").trim();
      dbRow[dbKey] = value === "" ? null : value;
    }
    rows.push(dbRow);
  }

  return { rows, totalRows, skippedRows };
}
