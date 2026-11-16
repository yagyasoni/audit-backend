import express from "express";
import cors from "cors";
import auditRoutes from "./routes/audit.routes.js";
import authRoutes from "./routes/auth.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import supplierRoutes from "./routes/supplier.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
import webhookRoutes from "./config/webhook.js";
import inventoryViewRoutes from "./routes/inventoryView.routes.js";
import publishingRoutes from "./routes/publishing.routes.js";
import landingRoutes from "./routes/landing.routes.js";
import auditGroupRoutes from "./routes/auditGroup.routes.js";
import temperatureLogsRoutes from "./routes/temperatureLogs.js";
import { smallJsonUnlessLarge } from "./middleware/body.js";

const app = express();

// The API sits behind nginx on the same machine. Trust the X-Forwarded-For
// header only when the request really comes from this machine, so req.ip is
// the visitor's own address and cannot be faked by calling the Node port
// directly. The limits in middleware/rateLimit.js count by req.ip. If a load
// balancer is ever put in front, its address range has to be added here.
app.set("trust proxy", "loopback");

// ── CORS: only the website may call the API from a browser ───
// The live website addresses are built in, so the site keeps working on a
// server whose .env has neither ALLOWED_ORIGINS nor FRONTEND_URL. More
// addresses (comma separated) can be added through either variable.
// Preview builds of the frontend project on Vercel are allowed too.
const BUILT_IN_ORIGINS = [
  "https://www.auditprorx.com",
  "https://auditprorx.com",
  "http://localhost:3000",
];
const PREVIEW_ORIGIN = /^https:\/\/project2rx-frontend-[a-z0-9-]+\.vercel\.app$/;

const cleanOrigin = (origin) => String(origin).trim().replace(/\/+$/, "");
const allowedOrigins = new Set(
  [
    ...BUILT_IN_ORIGINS,
    ...(process.env.ALLOWED_ORIGINS || "").split(","),
    ...(process.env.FRONTEND_URL || "").split(","),
  ]
    .map(cleanOrigin)
    .filter(Boolean),
);

app.use(
  cors({
    // No Origin header = not a browser page (Stripe, curl, server to server).
    // An unknown origin is answered without the CORS headers, so the browser
    // refuses to hand the reply to that page. It is not turned into an error.
    origin: (origin, cb) =>
      cb(
        null,
        !origin || allowedOrigins.has(origin) || PREVIEW_ORIGIN.test(origin),
      ),
    credentials: true,
  }),
);
app.use("/webhook", webhookRoutes);

// ── Request size ─────────────────────────────────────────────
// Default: 100 KB of JSON, so nobody can send huge requests before a login
// check. The few routes that really receive large JSON (master sheet save,
// posts, shared report rows) are skipped here and read their body with a
// larger limit AFTER their own login check. See middleware/body.js.
// File uploads go through multer, not here.
app.use(smallJsonUnlessLarge);
app.use(express.urlencoded({ limit: "100kb", extended: true }));

app.get("/", (req, res) => {
  res.send("AuditProRx API Running");
});

// register routes
app.use("/auth", authRoutes);
app.use("/api/audits", auditRoutes);

// add this line alongside your other app.use() calls
app.use("/admin", adminRoutes);
app.use("/api", supplierRoutes);
app.use("/pay", paymentRoutes);
app.use("/api/inventory-view", inventoryViewRoutes);
app.use("/post", publishingRoutes);
app.use("/landing", landingRoutes);
app.use("/audit-groups", auditGroupRoutes);
app.use("/api/temperature-logs", temperatureLogsRoutes);

// ── Last stop for errors ─────────────────────────────────────
// Anything a route did not handle itself ends here. Known, harmless cases
// get a clear answer; everything else is logged and answered with a plain
// message (no server details).
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err?.type === "entity.too.large")
    return res.status(413).json({ error: "The request is too large." });
  if (err?.type === "entity.parse.failed")
    return res.status(400).json({ error: "The request could not be read." });

  // Upload refusals (see utils/multer.js and the pharmacy documents upload)
  if (err?.name === "MulterError") {
    const tooBig = err.code === "LIMIT_FILE_SIZE";
    return res.status(tooBig ? 413 : 400).json({
      error: tooBig
        ? "The file is too large."
        : `Upload refused: ${err.message}`,
    });
  }
  if (err?.expose === true && err.status >= 400 && err.status < 500)
    return res.status(err.status).json({ error: err.message });

  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

export default app;
