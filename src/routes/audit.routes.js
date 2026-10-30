import express from "express";
import { uploadInventory, uploadWholesalers } from "../utils/multer.js";
import { requireFeature } from "../middleware/auth.js";
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
  getCommunityData,
  getDrugLookup,
  searchDrugNames,
  getDrugLookupGlobal,
  getDrugLookupLanding,
  searchNdcSuggestions,
  getAberrantRiskSummary,
  deleteWholesalerFile,
   serveInventoryFile,
  serveWholesalerFile,
} from "../controllers/audit.controller.js";

const router = express.Router();

// ── Plan gates ───────────────────────────────────────────────
// Every route needs a logged-in user whose plan covers the feature
// (admins pass through). Mapped to the flag the frontend already gates
// each feature with: reports/uploads/community → inventory_reports_access,
// drug lookup → drug_lookup_access, NDC autocomplete → inventory_view_access.
const reports = requireFeature("inventory_reports_access");
const drugLookup = requireFeature("drug_lookup_access");
const inventoryView = requireFeature("inventory_view_access");

// ============================
// CREATE & UPDATE
// ============================

router.get("/drug-search", drugLookup, searchDrugNames);
router.get("/drug-lookup-global", drugLookup, getDrugLookupGlobal); // ← ADD THIS LINE
router.get("/drug-lookup-landing", drugLookup, getDrugLookupLanding);
// In audit.routes.js, add this line with the other audit routes:
router.get("/ndc-suggestions", inventoryView, searchNdcSuggestions);

router.post("/", reports, createAudit);
router.patch("/:id/dates", reports, updateAuditDates);

// ============================
// INVENTORY
// ============================

router.post(
  "/:id/inventory",
  reports,
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

router.post("/:id/inventory/rows", reports, createInventoryRows);

// ============================
// WHOLESALERS
// ============================

router.post("/:id/wholesalers", reports, uploadWholesalers.any(), uploadWholesalerFiles);

// ============================
// GET REPORTS
// ============================

router.get("/", reports, getAudits);
router.get("/:id", reports, getAuditById);
router.get("/:id/inventory/rows", reports, getInventoryRows);
router.get("/:id/report", reports, getFullReport);
router.get("/:id/aberrant-summary", reports, getAberrantRiskSummary);

router.get("/:id/inventory-files", reports, getInventoryFiles);
router.get("/:id/wholesaler-files", reports, getWholesalerFiles);

// Serve a stored upload back: ?mode=preview → JSON rows, otherwise a CSV download.
// Keyed by audit id / wholesaler name rather than a file row id, because a
// re-upload replaces the row and would invalidate any id the client held.
router.get("/:id/inventory-file/content", reports, serveInventoryFile);
router.get("/:id/wholesaler-file/content", reports, serveWholesalerFile);
// ============================
// DELETE
// ============================

router.delete("/:id", reports, deleteAudit);
router.put("/:id/dates", reports, updateAuditDates);

router.get("/:id/drug-detail/:ndc", reports, getDrugWholesalerDetail);
router.delete("/:id/wholesalers", reports, deleteWholesalerFile);
router.get("/:id/inventory-detail/:ndc", reports, getInventoryDetail);
router.get("/:id/wholesaler-detail/:ndc", reports, getWholesalerDetail);
router.get("/community/:ndc", reports, getCommunityData);
router.get("/:id/drug-lookup", drugLookup, getDrugLookup);

export default router;
