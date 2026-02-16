import express from "express";
import cors from "cors";
import auditRoutes from "./routes/audit.routes.js";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("BatchRx API Running");
});

// register routes
app.use("/api/audits", auditRoutes);

export default app;
