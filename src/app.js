import express from "express";
import cors from "cors";
import auditRoutes from "./routes/audit.routes.js";
import authRoutes from "./routes/auth.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import supplierRoutes from "./routes/supplier.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
import webhookRoutes from "./config/webhook.js";

const app = express();

app.use(cors());
app.use("/webhook", webhookRoutes);

// app.use(express.json());
// ✅ FIX: Increase payload limit
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ limit: "100mb", extended: true }));

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
// app.use("/webhook", webhookRoutes);

export default app;
