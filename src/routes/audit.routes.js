import express from "express";
import {
  createAudit,
  updateAuditDates,
  uploadInventoryFile,
} from "../controllers/audit.controller.js";
import { uploadInventory } from "../utils/multer.js";
import { uploadWholesalers } from "../utils/multer.js";
import { uploadWholesalerFiles } from "../controllers/audit.controller.js";
import { createInventoryRows } from "../controllers/audit.controller.js";
import {
  getAudits,
  getAuditById,
  getInventoryRows,
  deleteAudit,
} from "../controllers/audit.controller.js";

const router = express.Router();

router.post("/", createAudit); // Step 1
router.patch("/:id/dates", updateAuditDates); // Step 2
router.post(
  "/:id/inventory",
  uploadInventory.single("file"),
  uploadInventoryFile,
);
router.post("/:id/inventory/rows", createInventoryRows);
router.post("/:id/wholesalers", uploadWholesalers.any(), uploadWholesalerFiles);
// router.get("/audits", getAllAudits);


// --- NEW ---
router.get("/", getAudits);
router.get("/:id", getAuditById);
router.get("/:id/inventory/rows", getInventoryRows);
router.delete("/:id", deleteAudit);

export default router;

