import multer from "multer";
import path from "path";
import fs from "fs";

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
  if (path.extname(file.originalname) !== ".csv") {
    return cb(new Error("Only CSV files allowed"));
  }
  cb(null, true);
};

export const uploadInventory = multer({
  storage,
  fileFilter,
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

export const uploadWholesalers = multer({
  storage: wholesalerStorage,
});
