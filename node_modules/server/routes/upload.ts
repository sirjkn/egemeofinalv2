import { Router, Request, Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";

const router = Router();

// Ensure uploads directory exists
const UPLOADS_DIR = path.resolve(__dirname, "../uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    const name = crypto.randomBytes(16).toString("hex") + ext;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

// POST /api/upload  →  { success: true, url: "/uploads/abc123.jpg" }
router.post("/", (req: Request, res: Response) => {
  upload.single("photo")(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, error: err.message || "Upload failed" });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No file uploaded" });
    }
    res.json({ success: true, url: `/uploads/${req.file.filename}` });
  });
});

export default router;
