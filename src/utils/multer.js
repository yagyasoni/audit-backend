import multer from "multer";
import path from "path";
import fs from "fs";

// A refused upload is the user's mistake, not a server failure: the error
// carries status 400 and may be shown to the user (see the handler in app.js).
const refuse = (message) =>
  Object.assign(new Error(message), { status: 400, expose: true });

// Size limits. Uploads are read into memory to be parsed, so they need a
// ceiling, but it has to leave room for real files: a year of claims from a
// busy pharmacy is tens of megabytes.
const MB = 1024 * 1024;
const MAX_CLAIMS_FILE = 100 * MB;
const MAX_WHOLESALER_FILE = 50 * MB;

// ensure folder exists
const inventoryPath = "uploads/inventory";
if (!fs.existsSync(inventoryPath)) {
  fs.mkdirSync(inventoryPath, { recursive: true });
}

// storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, inventoryPath);
  },

  filename: (req, file, cb) => {
    const uniqueName =
      Date.now() + "-" + file.originalname.replace(/\s+/g, "_");
    cb(null, uniqueName);
  },
});

// only csv allowed
const fileFilter = (req, file, cb) => {
  const allowed = [".csv"];
  if (!allowed.includes(path.extname(file.originalname).toLowerCase())) {
    return cb(refuse("Only CSV files allowed"));
  }
  cb(null, true);
};

export const uploadInventory = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_CLAIMS_FILE, files: 5 },
});

// ===== WHOLESALER UPLOAD =====
const wholesalerPath = "uploads/wholesalers";
if (!fs.existsSync(wholesalerPath)) {
  fs.mkdirSync(wholesalerPath, { recursive: true });
}

const wholesalerStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, wholesalerPath);
  },
  filename: (req, file, cb) => {
    const uniqueName =
      Date.now() + "-" + file.originalname.replace(/\s+/g, "_");
    cb(null, uniqueName);
  },
});

const wholesalerFileFilter = (req, file, cb) => {
  if (path.extname(file.originalname).toLowerCase() !== ".csv") {
    return cb(refuse("Only CSV files allowed"));
  }
  cb(null, true);
};

export const uploadWholesalers = multer({
  storage: wholesalerStorage,
  fileFilter: wholesalerFileFilter,
  limits: { fileSize: MAX_WHOLESALER_FILE, files: 30 },
});
