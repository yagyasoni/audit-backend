import express from "express";
import cors from "cors";
<<<<<<< HEAD
=======
import rateLimit from "express-rate-limit";
>>>>>>> 4fc9c18 (Fix all medium and low priority bugs from audit PDFs)
import auditRoutes from "./routes/audit.routes.js";
import authRoutes from "./routes/auth.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import supplierRoutes from "./routes/supplier.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
import webhookRoutes from "./config/webhook.js";
import inventoryViewRoutes from "./routes/inventoryView.routes.js";
import publishingRoutes from "./routes/publishing.routes.js";
import ndcSheetRoutes from "./routes/ndcSheet.routes.js";
import landingRoutes from "./routes/landing.routes.js";
import auditGroupRoutes from "./routes/auditGroup.routes.js";
import temperatureLogsRoutes from "./routes/temperatureLogs.js";

const app = express();

<<<<<<< HEAD
app.use(cors());
app.use("/webhook", webhookRoutes);

// app.use(express.json());
// ✅ FIX: Increase payload limit
app.use(express.json({ limit: "25mb" })); // file uploads go through multer, not here
app.use(express.urlencoded({ limit: "25mb", extended: true }));
=======
// M33: restrict CORS to known frontend origins
const allowedOrigins = (
  process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || "http://localhost:3000"
).split(",").map((o) => o.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));
app.use("/webhook", webhookRoutes);

// M34: keep the default body limit small (100 KB) to prevent unauthenticated
// payload flooding. Routes that actually receive large JSON (admin imports etc.)
// override this inline with express.json({ limit: "25mb" }) as middleware.
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ limit: "100kb", extended: true }));
>>>>>>> 4fc9c18 (Fix all medium and low priority bugs from audit PDFs)

app.get("/", (req, res) => {
  res.send("AuditProRx API Running");
});

<<<<<<< HEAD
=======
// M15: rate limiter for temperature log endpoint (drug lookup is in audit.routes.js)
const tempLogLimiter = rateLimit({ windowMs: 60_000, max: 100, standardHeaders: true, legacyHeaders: false });

>>>>>>> 4fc9c18 (Fix all medium and low priority bugs from audit PDFs)
// register routes
app.use("/auth", authRoutes);
app.use("/api/audits", auditRoutes);

// add this line alongside your other app.use() calls
app.use("/admin", adminRoutes);
app.use("/api", supplierRoutes);
app.use("/pay", paymentRoutes);
app.use("/api/inventory-view", inventoryViewRoutes);
app.use("/post", publishingRoutes);
app.use("/api", ndcSheetRoutes);
app.use("/landing", landingRoutes);
app.use("/audit-groups", auditGroupRoutes);
<<<<<<< HEAD
app.use("/api/temperature-logs", temperatureLogsRoutes);
=======
app.use("/api/temperature-logs", tempLogLimiter, temperatureLogsRoutes);

// M32: global error handler — catches any unhandled error thrown from a route
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Internal server error" });
});
>>>>>>> 4fc9c18 (Fix all medium and low priority bugs from audit PDFs)

export default app;
