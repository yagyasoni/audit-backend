// import express from "express";
// import { uploadInventory } from "../utils/multer.js";
// import { uploadWholesalers } from "../utils/multer.js";
// import { uploadWholesalerFiles } from "../controllers/audit.controller.js";
// import { createInventoryRows } from "../controllers/audit.controller.js";
// import {
//   createAudit,
//   updateAuditDates,
//   uploadInventoryFile,
//   uploadWholesalerFiles,
//   createInventoryRows,
//   getAudits,
//   getAuditById,
//   getInventoryRows,
//   deleteAudit,
//   getFullReport,
// } from "../controllers/audit.controller.js";

// const router = express.Router();

// router.post("/", createAudit); // Step 1
// router.patch("/:id/dates", updateAuditDates); // Step 2
// router.post("/:id/inventory", (req, res, next) => {
//   uploadInventory.single("file")(req, res, (err) => {
//     if (err) {
//       // Multer error or fileFilter error
//       return res.status(400).json({ error: err.message });
//     }
//     next();
//   });
// }, uploadInventoryFile);
// router.post("/:id/inventory/rows", createInventoryRows);
// router.post("/:id/wholesalers", uploadWholesalers.any(), uploadWholesalerFiles);
// // router.get("/audits", getAllAudits);


// // --- NEW ---
// router.get("/", getAudits);
// router.get("/:id", getAuditById);
// router.get("/:id/inventory/rows", getInventoryRows);
// router.delete("/:id", deleteAudit);
// router.get("/:id/report", getFullReport);

// export default router;

import express from "express";
import { uploadInventory, uploadWholesalers } from "../utils/multer.js";
import {
  createAudit,
  updateAuditDates,
  uploadInventoryFile,
  uploadWholesalerFiles,
  createInventoryRows,
  getAudits,
  getAuditById,
  getInventoryRows,
  deleteAudit,
  getFullReport,
} from "../controllers/audit.controller.js";

const router = express.Router();

// ============================
// CREATE & UPDATE
// ============================

router.post("/", createAudit);
router.patch("/:id/dates", updateAuditDates);

// ============================
// INVENTORY
// ============================

router.post(
  "/:id/inventory",
  (req, res, next) => {
    uploadInventory.single("file")(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  },
  uploadInventoryFile
);

router.post("/:id/inventory/rows", createInventoryRows);

// ============================
// WHOLESALERS
// ============================

router.post(
  "/:id/wholesalers",
  uploadWholesalers.any(),
  uploadWholesalerFiles
);

// ============================
// GET REPORTS
// ============================

router.get("/", getAudits);
router.get("/:id", getAuditById);
router.get("/:id/inventory/rows", getInventoryRows);
router.get("/:id/report", getFullReport);

// ============================
// DELETE
// ============================

router.delete("/:id", deleteAudit);
router.put('/:id/dates', updateAuditDates)

export default router;