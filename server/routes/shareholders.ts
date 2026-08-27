import { Router, Request, Response } from "express";
import pool from "../db/connection";

const router = Router();

const AVATAR_COLORS = [
  "#14b8a6","#6366f1","#8b5cf6","#f59e0b","#ef4444",
  "#22c55e","#f97316","#3b82f6","#ec4899","#0ea5e9",
];

const SELECT = `
  SELECT id, member_number, name, phone, email, id_passport,
         to_char(joined_date, 'YYYY-MM-DD') AS joined_date,
         status, avatar_color, photo_url,
         net_savings, total_profits, contributions_count,
         created_at, updated_at
  FROM shareholders
`;

async function nextMemberNumber(client: any): Promise<number> {
  const { rows } = await client.query(
    "SELECT COALESCE(MAX(member_number), 0) + 1 AS next FROM shareholders"
  );
  return rows[0].next;
}

// ─── GET /api/shareholders ────────────────────────────────────────────────────

router.get("/", async (req: Request, res: Response) => {
  try {
    const { status, search } = req.query as { status?: string; search?: string };
    let query = `${SELECT} WHERE 1=1`;
    const params: (string | number)[] = [];
    let idx = 1;
    if (status && ["Active", "Inactive"].includes(status)) { query += ` AND status = $${idx++}`; params.push(status); }
    if (search) { query += ` AND (name ILIKE $${idx} OR phone ILIKE $${idx})`; params.push(`%${search}%`); idx++; }
    query += " ORDER BY member_number ASC";
    const { rows } = await pool.query(query, params);
    res.json({ success: true, data: rows });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── GET /api/shareholders/check-phone/:phone ─────────────────────────────────

router.get("/check-phone/:phone", async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query("SELECT phone, member_type FROM member_phones WHERE phone = $1", [req.params.phone]);
    res.json({ success: true, available: rows.length === 0, conflict: rows[0] || null });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── GET /api/shareholders/:id ────────────────────────────────────────────────

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`${SELECT} WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, error: "Shareholder not found" });
    res.json({ success: true, data: rows[0] });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── POST /api/shareholders ───────────────────────────────────────────────────

router.post("/", async (req: Request, res: Response) => {
  const { name, phone, email, id_passport, joined_date, status, photo_url, member_number } = req.body;
  if (!name?.trim()) return res.status(400).json({ success: false, error: "Name is required" });
  if (!phone?.trim()) return res.status(400).json({ success: false, error: "Phone is required" });
  if (!/^(0[0-9]{9}|\+[0-9]{7,15})$/.test(phone.trim()))
    return res.status(400).json({ success: false, error: "Invalid phone number" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT phone, member_type FROM member_phones WHERE phone = $1", [phone.trim()]);
    if (existing.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, error: `Phone is already registered as a ${existing.rows[0].member_type}` });
    }

    const countResult = await client.query("SELECT COUNT(*) FROM shareholders");
    const avatarColor = AVATAR_COLORS[parseInt(countResult.rows[0].count) % AVATAR_COLORS.length];
    const memberNum = member_number ? parseInt(member_number) : await nextMemberNumber(client);

    const { rows } = await client.query(
      `INSERT INTO shareholders (member_number, name, phone, email, id_passport, joined_date, status, avatar_color, photo_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, member_number, name, phone, email, id_passport,
                 to_char(joined_date,'YYYY-MM-DD') AS joined_date,
                 status, avatar_color, photo_url, net_savings, total_profits, contributions_count`,
      [memberNum, name.trim(), phone.trim(), email?.trim()||null, id_passport?.trim()||null,
       joined_date||new Date().toISOString().slice(0,10), status||"Active", avatarColor, photo_url||null]
    );
    await client.query("COMMIT");
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err: any) {
    await client.query("ROLLBACK");
    if (err.code === "23505") return res.status(409).json({ success: false, error: "Phone or member number already exists" });
    res.status(500).json({ success: false, error: err.message });
  } finally { client.release(); }
});

// ─── PATCH /api/shareholders/:id ─────────────────────────────────────────────

router.patch("/:id", async (req: Request, res: Response) => {
  const { name, phone, email, id_passport, joined_date, status, photo_url, member_number } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query("SELECT * FROM shareholders WHERE id = $1", [req.params.id]);
    if (!current.rows[0]) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, error: "Not found" }); }

    if (phone && phone.trim() !== current.rows[0].phone) {
      if (!/^(0[0-9]{9}|\+[0-9]{7,15})$/.test(phone.trim())) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, error: "Invalid phone" }); }
      const clash = await client.query("SELECT phone, member_type FROM member_phones WHERE phone = $1", [phone.trim()]);
      if (clash.rows.length > 0) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, error: `Phone registered as ${clash.rows[0].member_type}` }); }
    }

    const { rows } = await client.query(
      `UPDATE shareholders
       SET member_number = COALESCE($1, member_number),
           name          = COALESCE($2, name),
           phone         = COALESCE($3, phone),
           email         = COALESCE($4, email),
           id_passport   = COALESCE($5, id_passport),
           joined_date   = COALESCE($6, joined_date),
           status        = COALESCE($7, status),
           photo_url     = COALESCE($8, photo_url)
       WHERE id = $9
       RETURNING id, member_number, name, phone, email, id_passport,
                 to_char(joined_date,'YYYY-MM-DD') AS joined_date,
                 status, avatar_color, photo_url, net_savings, total_profits, contributions_count`,
      [member_number||null, name?.trim()||null, phone?.trim()||null,
       email?.trim()??undefined, id_passport?.trim()??undefined,
       joined_date||null, status||null, photo_url??undefined, req.params.id]
    );
    await client.query("COMMIT");
    res.json({ success: true, data: rows[0] });
  } catch (err: any) {
    await client.query("ROLLBACK");
    if (err.code === "23505") return res.status(409).json({ success: false, error: "Phone or member number already exists" });
    res.status(500).json({ success: false, error: err.message });
  } finally { client.release(); }
});

// ─── PATCH /api/shareholders/:id/status ──────────────────────────────────────

router.patch("/:id/status", async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    if (!["Active","Inactive"].includes(status)) return res.status(400).json({ success: false, error: "Invalid status" });
    const { rows } = await pool.query(
      "UPDATE shareholders SET status=$1 WHERE id=$2 RETURNING id,member_number,name,status,avatar_color,photo_url",
      [status, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true, data: rows[0] });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── DELETE /api/shareholders/:id ────────────────────────────────────────────

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const { rowCount } = await pool.query("DELETE FROM shareholders WHERE id=$1", [req.params.id]);
    if (!rowCount) return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true, message: "Deleted" });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

export default router;
