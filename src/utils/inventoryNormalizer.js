import fs from "fs";
import csv from "csv-parser";
import { format } from "@fast-csv/format";
import path from "path";

const HEADER_MAP = {
  ndc: ["ndc", "ndc_code", "ndc11", "ndc_11"],
  rx_number: ["rx", "rx_number", "rxnumber", "rx_no"],
  status: ["status", "rx_status"],
  date_filled: ["date_filled", "fill_date", "datefilled", "filldate"],
  drug_name: ["drug_name", "drug", "medication", "drugdescription"],
  quantity: ["qty", "quantity", "dispensed_qty"],
  package_size: ["package_size", "strength", "pkg_size"],
  primary_bin: ["primary_bin", "bin", "bin1"],
  primary_paid: ["primary_paid", "primary_paid_amount", "paid_primary"],
  secondary_bin: ["secondary_bin", "bin2"],
  secondary_paid: ["secondary_paid", "paid_secondary"],
  brand: ["brand", "generic_brand", "brand_generic"],
};

export async function normalizeInventoryCSV(inputPath) {
  return new Promise((resolve, reject) => {
    const outputPath = inputPath.replace(".csv", ".normalized.csv");
    const rows = [];
    let headerMapResolved = null;

    fs.createReadStream(inputPath)
      .pipe(csv())
      .on("headers", (headers) => {
        headerMapResolved = {};

        for (const [target, candidates] of Object.entries(HEADER_MAP)) {
          const match = headers.find((h) =>
            candidates.includes(h.toLowerCase().trim())
          );
          if (!match) {
            return reject(
              new Error(`Missing required column mapping for: ${target}`)
            );
          }
          headerMapResolved[target] = match;
        }
      })
      .on("data", (row) => {
        const normalized = {};
        for (const [target, source] of Object.entries(headerMapResolved)) {
          normalized[target] = row[source] || null;
        }
        rows.push(normalized);
      })
      .on("end", () => {
        const ws = fs.createWriteStream(outputPath);
        const csvStream = format({ headers: true });

        csvStream.pipe(ws);
        rows.forEach((r) => csvStream.write(r));
        csvStream.end();

        resolve(outputPath);
      })
      .on("error", reject);
  });
}