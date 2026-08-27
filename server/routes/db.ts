import { Router, Request, Response } from "express";
import { Pool } from "pg";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePool(cfg: DbConfig): Pool {
  return new Pool({
    host:     cfg.host,
    port:     cfg.port,
    database: cfg.database,
    user:     cfg.user,
    password: cfg.password,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 8000,
  });
}

interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
}

function getDefaultConfig(): DbConfig {
  return {
    host:     process.env.DB_HOST     || "localhost",
    port:     parseInt(process.env.DB_PORT || "5432"),
    database: process.env.DB_NAME     || "",
    user:     process.env.DB_USER     || "",
    password: process.env.DB_PASSWORD || "",
    ssl:      process.env.DB_SSL === "true",
  };
}

// Rebuild the internal default pool from env vars (after .env update)
function reloadDefaultPool() {
  // We import the pool module's pool but can't hot-reload it easily.
  // Instead the proxy always uses a fresh pool from current env or provided config.
}

// ─── POST /api/db/test ────────────────────────────────────────────────────────
// Test a PostgreSQL connection with provided credentials.

router.post("/test", async (req: Request, res: Response) => {
  const cfg: DbConfig = {
    host:     req.body.host     || "localhost",
    port:     parseInt(req.body.port || "5432"),
    database: req.body.database || "",
    user:     req.body.user     || "",
    password: req.body.password || "",
    ssl:      !!req.body.ssl,
  };

  const pool = makePool(cfg);
  try {
    const client = await pool.connect();
    const { rows } = await client.query("SELECT version(), current_database() AS db, current_user AS usr, now() AS ts");
    client.release();
    await pool.end();
    res.json({ success: true, info: rows[0] });
  } catch (err: any) {
    await pool.end().catch(() => {});
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── POST /api/db/configure ───────────────────────────────────────────────────
// Save cPanel credentials to .env file so the server pool uses them on restart.

router.post("/configure", async (req: Request, res: Response) => {
  const { host, port, database, user, password, ssl } = req.body;

  const envPath = path.resolve(process.cwd(), ".env");
  let envContent = "";
  try { envContent = fs.readFileSync(envPath, "utf8"); } catch { /* new file */ }

  const set = (key: string, val: string) => {
    const re = new RegExp(`^${key}=.*$`, "m");
    const line = `${key}=${val}`;
    return re.test(envContent) ? envContent.replace(re, line) : envContent + `\n${line}`;
  };

  envContent = set("DB_HOST",     host     || "localhost");
  envContent = set("DB_PORT",     String(port || 5432));
  envContent = set("DB_NAME",     database || "");
  envContent = set("DB_USER",     user     || "");
  envContent = set("DB_PASSWORD", password || "");
  envContent = set("DB_SSL",      ssl ? "true" : "false");

  try {
    fs.writeFileSync(envPath, envContent, "utf8");
    // Reload env in current process
    dotenv.config({ override: true });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/db/proxy ───────────────────────────────────────────────────────
// Generic CRUD proxy.  Accepts a Supabase-style query spec and executes it.
//
// Body shape:
// {
//   operation : "select" | "insert" | "update" | "delete" | "upsert" | "rpc" | "raw"
//   table     : string          (omit for rpc/raw)
//   select    : string          (SELECT column list, default "*")
//   filters   : Filter[]        [{col, op, val}]
//   order     : Order[]         [{col, asc: bool}]
//   limit     : number
//   offset    : number
//   data      : object | object[]  (for insert/update/upsert)
//   onConflict: string          (for upsert)
//   rpc_name  : string          (for rpc)
//   rpc_params: object          (for rpc)
//   sql       : string          (for raw — admin only)
//   sqlParams : any[]           (for raw)
//   config?   : DbConfig        (override default pool)
// }

type FilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike" | "in" | "is" | "not.is";

interface Filter { col: string; op: FilterOp; val: any }
interface Order  { col: string; asc: boolean }

function buildWhere(filters: Filter[], params: any[], startIdx: number): string {
  if (!filters?.length) return "";
  const parts = filters.map((f) => {
    const col = `"${f.col.replace(/"/g, "")}"`;
    switch (f.op) {
      case "eq":     params.push(f.val); return `${col} = $${startIdx++}`;
      case "neq":    params.push(f.val); return `${col} != $${startIdx++}`;
      case "gt":     params.push(f.val); return `${col} > $${startIdx++}`;
      case "gte":    params.push(f.val); return `${col} >= $${startIdx++}`;
      case "lt":     params.push(f.val); return `${col} < $${startIdx++}`;
      case "lte":    params.push(f.val); return `${col} <= $${startIdx++}`;
      case "like":   params.push(f.val); return `${col} LIKE $${startIdx++}`;
      case "ilike":  params.push(f.val); return `${col} ILIKE $${startIdx++}`;
      case "in":     params.push(f.val); return `${col} = ANY($${startIdx++})`;
      case "is":     return f.val === null ? `${col} IS NULL` : `${col} IS ${f.val ? "TRUE" : "FALSE"}`;
      case "not.is": return f.val === null ? `${col} IS NOT NULL` : `${col} IS NOT ${f.val ? "TRUE" : "FALSE"}`;
      default:       params.push(f.val); return `${col} = $${startIdx++}`;
    }
  });
  return "WHERE " + parts.join(" AND ");
}

// Resolve pool: use provided config override or fall back to current env
function resolvePool(configOverride?: DbConfig): Pool {
  if (configOverride) return makePool(configOverride);
  return makePool(getDefaultConfig());
}

router.post("/proxy", async (req: Request, res: Response) => {
  const { operation, table, select: sel, filters, order, limit, offset,
          data, onConflict, rpc_name, rpc_params, sql: rawSql, sqlParams,
          config: configOverride } = req.body;

  const pool = resolvePool(configOverride);
  const client = await pool.connect();

  try {
    let rows: any[] = [];

    // ── SELECT ────────────────────────────────────────────────────────────────
    if (operation === "select") {
      const params: any[] = [];
      const cols = (sel || "*").replace(/[`]/g, ""); // basic sanitise
      const where = buildWhere(filters || [], params, 1);
      const orderClause = (order || []).map((o: Order) =>
        `"${o.col.replace(/"/g, "")}" ${o.asc ? "ASC" : "DESC"}`
      ).join(", ");
      let sql = `SELECT ${cols} FROM "${table}" ${where}`;
      if (orderClause) sql += ` ORDER BY ${orderClause}`;
      if (limit)  sql += ` LIMIT $${params.length + 1}` + (params.push(limit)  && "");
      if (offset) sql += ` OFFSET $${params.length + 1}` + (params.push(offset) && "");
      const result = await client.query(sql, params);
      rows = result.rows;
    }

    // ── INSERT ────────────────────────────────────────────────────────────────
    else if (operation === "insert") {
      const records: object[] = Array.isArray(data) ? data : [data];
      rows = [];
      for (const record of records) {
        const keys = Object.keys(record);
        const vals = Object.values(record);
        const cols = keys.map((k) => `"${k}"`).join(", ");
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
        const result = await client.query(
          `INSERT INTO "${table}" (${cols}) VALUES (${placeholders}) RETURNING *`,
          vals
        );
        rows.push(...result.rows);
      }
    }

    // ── UPSERT ────────────────────────────────────────────────────────────────
    else if (operation === "upsert") {
      const records: object[] = Array.isArray(data) ? data : [data];
      rows = [];
      for (const record of records) {
        const keys = Object.keys(record);
        const vals = Object.values(record);
        const cols = keys.map((k) => `"${k}"`).join(", ");
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
        const conflictCol = onConflict || "id";
        const updates = keys.filter(k => k !== conflictCol).map((k, i) =>
          `"${k}" = EXCLUDED."${k}"`
        ).join(", ");
        const sql = `INSERT INTO "${table}" (${cols}) VALUES (${placeholders})
                     ON CONFLICT ("${conflictCol}") DO UPDATE SET ${updates} RETURNING *`;
        const result = await client.query(sql, vals);
        rows.push(...result.rows);
      }
    }

    // ── UPDATE ────────────────────────────────────────────────────────────────
    else if (operation === "update") {
      const keys = Object.keys(data);
      const vals = Object.values(data);
      const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(", ");
      const where = buildWhere(filters || [], vals, keys.length + 1);
      const result = await client.query(
        `UPDATE "${table}" SET ${sets} ${where} RETURNING *`,
        vals
      );
      rows = result.rows;
    }

    // ── DELETE ────────────────────────────────────────────────────────────────
    else if (operation === "delete") {
      const params: any[] = [];
      const where = buildWhere(filters || [], params, 1);
      const result = await client.query(
        `DELETE FROM "${table}" ${where} RETURNING *`,
        params
      );
      rows = result.rows;
    }

    // ── RPC ───────────────────────────────────────────────────────────────────
    else if (operation === "rpc") {
      const params = rpc_params ? Object.values(rpc_params) : [];
      const placeholders = params.map((_, i) => `$${i + 1}`).join(", ");
      const result = await client.query(
        `SELECT * FROM "${rpc_name}"(${placeholders})`,
        params
      );
      rows = result.rows;
    }

    // ── RAW SQL ───────────────────────────────────────────────────────────────
    else if (operation === "raw") {
      const result = await client.query(rawSql, sqlParams || []);
      rows = result.rows;
    }

    res.json({ data: rows, error: null });
  } catch (err: any) {
    res.status(400).json({ data: null, error: { message: err.message, code: err.code } });
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
});

export default router;
