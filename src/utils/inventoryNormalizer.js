import fs from "fs";
import csv from "csv-parser";
import { format } from "@fast-csv/format";
import path from "path";

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
  secondaryInsurancePaid: "secondary_paid",
  brand: "brand",
};

export async function normalizeInventoryCSV(inputPath, headerMapping) {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(
      path.dirname(inputPath),
      path.basename(inputPath, path.extname(inputPath)) + ".normalized.csv"
    );

    const rows = [];
    let actualHeaders = [];

    console.log("=== NORMALIZER START ===");
    console.log("Input file:", inputPath);
    console.log("headerMapping received:", JSON.stringify(headerMapping));

    fs.createReadStream(inputPath)
      .pipe(csv())
      .on("headers", (headers) => {
        actualHeaders = headers;
        console.log("Actual CSV headers:", headers);
      })
      .on("data", (row) => {
        const dbRow = {};

        // headerMapping = { rxNumber: "rx_number", dateFilled: "date_filled", ... }
        // We need to find which actual CSV column corresponds to each DB field

        for (const [frontKey, standardValue] of Object.entries(headerMapping)) {
          const dbKey = FRONT_TO_DB[frontKey];
          if (!dbKey) {
            console.warn(`No DB mapping for frontend key: ${frontKey}`);
            continue;
          }

          // Find the actual CSV column that matches the standardValue
          // standardValue is something like "rx_number", "date_filled", etc.
          // We need to find the actual CSV header that the user selected
          
          // The user selected a column from their file headers in the dropdown
          // standardValue IS the actual column name from their CSV
          // because in UploadInventoryStep, the select options are the actual file headers
          
          const actualColValue = row[standardValue];
          
          if (actualColValue !== undefined) {
            dbRow[dbKey] = actualColValue || null;
          } else {
            // Try case-insensitive match
            const matchingKey = Object.keys(row).find(
              (k) => k.toLowerCase().trim() === standardValue.toLowerCase().trim()
            );
            dbRow[dbKey] = matchingKey ? row[matchingKey] || null : null;
          }
        }

        console.log("Sample dbRow:", JSON.stringify(dbRow));
        rows.push(dbRow);
      })
      .on("end", () => {
        console.log(`Total rows parsed: ${rows.length}`);
        if (rows.length > 0) {
          console.log("First row sample:", JSON.stringify(rows[0]));
        }

        const ws = fs.createWriteStream(outputPath);
        const csvStream = format({ headers: true });

        csvStream.pipe(ws);
        rows.forEach((r) => csvStream.write(r));
        csvStream.end();

        ws.on("finish", () => resolve(outputPath));
        ws.on("error", reject);
      })
      .on("error", reject);
  });
}