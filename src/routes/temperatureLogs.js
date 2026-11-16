import express from "express";
import { list, save, remove } from "../controllers/temperatureLogs.js";
import { requireAuth, requirePlan } from "../middleware/auth.js";
import { perUser } from "../middleware/rateLimit.js";

const router = express.Router();

// 100 requests a minute for one pharmacy (counted per login, after the
// login check).
router.use(
  requireAuth,
  requirePlan("inventory_reports_access"),
  perUser({ minutes: 1, limit: 100 }),
);
router.get("/", list);
router.put("/", save);
router.delete("/:id", remove);

// The app has no global error handler, so answer 500 here.
router.use((err, req, res, next) => {
  console.error("Temperature logs error:", err);
  res.status(500).json({ error: "Temperature logs request failed" });
});

export default router;
