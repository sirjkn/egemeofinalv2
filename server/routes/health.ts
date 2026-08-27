import { Router, Request, Response } from "express";
import pool from "../db/connection";

const router = Router();

router.get("/", async (_req: Request, res: Response) => {
  try {
    await pool.query("SELECT 1");
    res.json({ success: true, db: "connected" });
  } catch (err: any) {
    res.status(503).json({ success: false, db: "disconnected", error: err.message });
  }
});

export default router;
