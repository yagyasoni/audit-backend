import express from "express";
import { uploadInventory, uploadWholesalers } from "../utils/multer.js";
import { requireFeature } from "../middleware/auth.js";
import { pool } from "../config/db.js";
import { perUser } from "../middleware/rateLimit.js";
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

// ── Ownership ────────────────────────────────────────────────
// A pharmacy may only read, change or delete its OWN reports. This runs
// right after the plan gate on every /:id route, before any upload is
// saved. Someone else's report answers "not found", the same as a report
// that does not exist. The admin login passes, as it did before.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ownAudit(req, res, next) {
  if (req.role === "admin") return next();

  const { id } = req.params;
  if (!UUID_RE.test(String(id)))
    return res.status(404).json({ error: "Audit not found" });

  try {
    const result = await pool.query(
      `SELECT user_id FROM audits WHERE id = $1`,
      [id],
    );
    const ownerId = result.rows[0]?.user_id;
    if (!ownerId || ownerId !== req.user?.userId)
      return res.status(404).json({ error: "Audit not found" });
    return next();
  } catch (err) {
    console.error("Audit ownership check error:", err);
    return res.status(500).json({ error: "Failed to check report access" });
  }
}

const ownReports = [reports, ownAudit];
const ownDrugLookup = [drugLookup, ownAudit];

// ============================
// CREATE & UPDATE
// ============================

// Drug lookup limits, counted per login AFTER the login check (not per
// address: pharmacies behind one office address must not share a limit).
// The search box asks while the user types, so it gets a higher limit.
const searchLimit = perUser({ minutes: 1, limit: 120 });
const lookupLimit = perUser({ minutes: 1, limit: 60 });

router.get("/drug-search", drugLookup, searchLimit, searchDrugNames);
router.get("/drug-lookup-global", drugLookup, lookupLimit, getDrugLookupGlobal);
router.get("/drug-lookup-landing", drugLookup, lookupLimit, getDrugLookupLanding);
// In audit.routes.js, add this line with the other audit routes:
router.get("/ndc-suggestions", inventoryView, searchNdcSuggestions);

router.post("/", reports, createAudit);
router.patch("/:id/dates", ownReports, updateAuditDates);

// ============================
// INVENTORY
// ============================

router.post(
  "/:id/inventory",
  ownReports,
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

// (the raw claim-rows routes were removed: the website never called them)

// ============================
// WHOLESALERS
// ============================

router.post("/:id/wholesalers", ownReports, uploadWholesalers.any(), uploadWholesalerFiles);

// ============================
// GET REPORTS
// ============================

router.get("/", reports, getAudits);
router.get("/:id", ownReports, getAuditById);
router.get("/:id/report", ownReports, getFullReport);
router.get("/:id/aberrant-summary", ownReports, getAberrantRiskSummary);

router.get("/:id/inventory-files", ownReports, getInventoryFiles);
router.get("/:id/wholesaler-files", ownReports, getWholesalerFiles);

// Serve a stored upload back: ?mode=preview → JSON rows, otherwise a CSV download.
// Keyed by audit id / wholesaler name rather than a file row id, because a
// re-upload replaces the row and would invalidate any id the client held.
router.get("/:id/inventory-file/content", ownReports, serveInventoryFile);
router.get("/:id/wholesaler-file/content", ownReports, serveWholesalerFile);
// ============================
// DELETE
// ============================

router.delete("/:id", ownReports, deleteAudit);
router.put("/:id/dates", ownReports, updateAuditDates);

// (the drug-detail route was removed: the website never called it)
router.delete("/:id/wholesalers", ownReports, deleteWholesalerFile);
router.get("/:id/inventory-detail/:ndc", ownReports, getInventoryDetail);
router.get("/:id/wholesaler-detail/:ndc", ownReports, getWholesalerDetail);
router.get("/community/:ndc", reports, getCommunityData);
router.get("/:id/drug-lookup", ownDrugLookup, getDrugLookup);

export default router;
