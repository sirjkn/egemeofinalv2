import dotenv from "dotenv";
dotenv.config();

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import path from "path";
import shareholdersRouter from "./routes/shareholders";
import clientsRouter from "./routes/clients";
import investorsRouter from "./routes/investors";
import uploadRouter from "./routes/upload";
import healthRouter from "./routes/health";
import smsRouter from "./routes/sms";
import mpesaRouter from "./routes/mpesa";
import authRouter from "./routes/auth";
import dbRouter from "./routes/db";

const app = express();
const PORT = process.env.PORT || 3001;

// Allow requests from the frontend origin (set CORS_ORIGIN in .env)
const allowedOrigin = process.env.CORS_ORIGIN || "*";
app.use(cors({ origin: allowedOrigin, credentials: allowedOrigin !== "*" }));

app.use(express.json());

// Serve uploaded photos as static files
app.use("/uploads", express.static(path.resolve(__dirname, "uploads")));

// API routes
app.use("/api/health", healthRouter);
app.use("/api/shareholders", shareholdersRouter);
app.use("/api/clients", clientsRouter);
app.use("/api/investors", investorsRouter);
app.use("/api/upload", uploadRouter);
app.use("/api/sms", smsRouter);
app.use("/api/mpesa", mpesaRouter);
app.use("/api/auth",  authRouter);
app.use("/api/db",    dbRouter);

// JSON 404 for unknown /api/* routes (must come before the SPA catch-all)
app.use("/api", (_req: Request, res: Response) => {
  res.status(404).json({ success: false, error: "API endpoint not found" });
});

// Global JSON error handler — prevents Express from ever returning HTML on errors
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(err.status || 500).json({ success: false, error: err.message || "Internal server error" });
});

// Serve React build in production (cPanel)
if (process.env.NODE_ENV === "production") {
  const dist = path.resolve(__dirname, "../dist");
  app.use(express.static(dist));
  // Only serve index.html for non-API routes
  app.get("*", (req: Request, res: Response) => {
    if (req.path.startsWith("/api")) {
      return res.status(404).json({ success: false, error: "API endpoint not found" });
    }
    res.sendFile(path.join(dist, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
