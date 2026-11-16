// One reader for every number that arrives as text in an uploaded file
// (paid amounts, costs, quantities).
//
//   "1,234.56"   → 1234.56      thousands commas
//   "$45.10"     → 45.1         currency sign
//   "-250.00"    → -250         minus in front
//   "250.00-"    → -250         minus behind (accounting exports)
//   "(250.00)"   → -250         brackets mean negative (credits, returns)
//   "30 TAB"     → 30           a unit after the number
//   "", "N/A"    → null         nothing usable
//
// Returns a finite number, or null. It never returns NaN: a NaN written to a
// numeric column makes every total that includes it "not a number".
export function parseAmount(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  let text = String(value).trim();
  if (!text) return null;

  let negative = false;

  // (250.00) → negative
  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true;
    text = text.slice(1, -1);
  }

  // Keep digits, the decimal point and minus signs; drop "$", commas,
  // spaces and letters.
  text = text.replace(/[^0-9.-]/g, "");

  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  } else if (text.endsWith("-")) {
    negative = true;
    text = text.slice(0, -1);
  }

  // What is left must be one plain number: "12", "12.5", ".5", "12."
  if (!/^(\d+\.?\d*|\.\d+)$/.test(text)) return null;

  const number = Number(text);
  if (!Number.isFinite(number)) return null;

  return negative && number !== 0 ? -number : number;
}
