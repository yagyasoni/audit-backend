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
  getInventoryFiles,
  getWholesalerFiles,
  getDrugWholesalerDetail,
  getInventoryDetail,
  getWholesalerDetail,
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
    // uploadInventory.single("file")
    uploadInventory.fields([
      { name: "file", maxCount: 1 },
      { name: "headerMapping", maxCount: 1 },
    ])(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  },
  uploadInventoryFile,
);

router.post("/:id/inventory/rows", createInventoryRows);

// ============================
// WHOLESALERS
// ============================

router.post("/:id/wholesalers", uploadWholesalers.any(), uploadWholesalerFiles);

// ============================
// GET REPORTS
// ============================

router.get("/", getAudits);
router.get("/:id", getAuditById);
router.get("/:id/inventory/rows", getInventoryRows);
router.get("/:id/report", getFullReport);

router.get("/:id/inventory-files", getInventoryFiles);
router.get("/:id/wholesaler-files", getWholesalerFiles);

// ============================
// DELETE
// ============================

router.delete("/:id", deleteAudit);
router.put("/:id/dates", updateAuditDates);

router.get("/:id/drug-detail/:ndc", getDrugWholesalerDetail);
router.get("/:id/inventory-detail/:ndc", getInventoryDetail);
router.get("/:id/wholesaler-detail/:ndc", getWholesalerDetail);

export default router;
