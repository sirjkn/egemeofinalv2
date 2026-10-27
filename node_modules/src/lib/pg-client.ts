/**
 * pg-client.ts
 * Drop-in replacement for the Supabase JS client.
 * Routes all queries through the Node.js server's /api/db/proxy endpoint.
 *
 * Supports the same chainable API:
 *   pgClient.from("table").select("*").eq("col", val).order("col").limit(n)
 *   pgClient.from("table").insert({ ... })
 *   pgClient.from("table").update({ ... }).eq("col", val)
 *   pgClient.from("table").delete().eq("col", val)
 *   pgClient.rpc("fn_name", { params })
 */

export const PG_SERVER_URL_KEY = "pg_server_url";
export const PG_MODE_KEY       = "db_mode"; // "supabase" | "cpanel"

export function getPgServerUrl(): string {
  return (typeof localStorage !== "undefined" && localStorage.getItem(PG_SERVER_URL_KEY)) || "";
}

async function proxyRequest(body: object): Promise<{ data: any; error: any }> {
  const serverUrl = getPgServerUrl();
  if (!serverUrl) return { data: null, error: { message: "cPanel server URL not configured. Set it in App Maintenance → Database Connection." } };
  try {
    const res = await fetch(`${serverUrl.replace(/\/$/, "")}/api/db/proxy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    return json;
  } catch (err: any) {
    return { data: null, error: { message: err.message } };
  }
}

// ─── Query Builder ────────────────────────────────────────────────────────────

type FilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike" | "in" | "is" | "not.is";

class QueryBuilder {
  private _table: string;
  private _operation: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private _select = "*";
  private _filters: { col: string; op: FilterOp; val: any }[] = [];
  private _order: { col: string; asc: boolean }[] = [];
  private _limit?: number;
  private _offset?: number;
  private _data?: any;
  private _onConflict?: string;
  private _single = false;
  private _maybeSingle = false;

  constructor(table: string) {
    this._table = table;
  }

  // ── Terminal setters ──────────────────────────────────────────────────────

  select(cols = "*"): this {
    this._operation = "select";
    this._select = cols;
    return this;
  }

  insert(data: object | object[], options?: { onConflict?: string }): this {
    this._operation = "insert";
    this._data = data;
    if (options?.onConflict) this._onConflict = options.onConflict;
    return this;
  }

  upsert(data: object | object[], options?: { onConflict?: string }): this {
    this._operation = "upsert";
    this._data = data;
    if (options?.onConflict) this._onConflict = options.onConflict;
    return this;
  }

  update(data: object): this {
    this._operation = "update";
    this._data = data;
    return this;
  }

  delete(): this {
    this._operation = "delete";
    return this;
  }

  // ── Filter chain ──────────────────────────────────────────────────────────

  eq(col: string, val: any): this       { this._filters.push({ col, op: "eq",    val }); return this; }
  neq(col: string, val: any): this      { this._filters.push({ col, op: "neq",   val }); return this; }
  gt(col: string, val: any): this       { this._filters.push({ col, op: "gt",    val }); return this; }
  gte(col: string, val: any): this      { this._filters.push({ col, op: "gte",   val }); return this; }
  lt(col: string, val: any): this       { this._filters.push({ col, op: "lt",    val }); return this; }
  lte(col: string, val: any): this      { this._filters.push({ col, op: "lte",   val }); return this; }
  like(col: string, val: any): this     { this._filters.push({ col, op: "like",  val }); return this; }
  ilike(col: string, val: any): this    { this._filters.push({ col, op: "ilike", val }); return this; }
  in(col: string, val: any[]): this     { this._filters.push({ col, op: "in",    val }); return this; }
  is(col: string, val: any): this       { this._filters.push({ col, op: "is",    val }); return this; }
  not(col: string, op: string, val: any): this {
    this._filters.push({ col, op: `not.${op}` as FilterOp, val });
    return this;
  }

  // ── Modifiers ─────────────────────────────────────────────────────────────

  order(col: string, opts?: { ascending?: boolean }): this {
    this._order.push({ col, asc: opts?.ascending !== false });
    return this;
  }

  limit(n: number): this  { this._limit  = n; return this; }
  range(from: number, to: number): this { this._offset = from; this._limit = to - from + 1; return this; }

  single(): this      { this._single = true; return this; }
  maybeSingle(): this { this._maybeSingle = true; return this; }

  // ── Execute ───────────────────────────────────────────────────────────────

  then(resolve: (val: { data: any; error: any }) => any, reject?: (err: any) => any): Promise<any> {
    return this._execute().then(resolve, reject);
  }

  private async _execute(): Promise<{ data: any; error: any }> {
    const body: any = {
      operation:  this._operation,
      table:      this._table,
      select:     this._select,
      filters:    this._filters,
      order:      this._order,
      data:       this._data,
      onConflict: this._onConflict,
    };
    if (this._limit  !== undefined) body.limit  = this._limit;
    if (this._offset !== undefined) body.offset = this._offset;

    const result = await proxyRequest(body);
    if (result.error) return result;

    const arr: any[] = result.data ?? [];
    if (this._single) {
      return arr.length === 0
        ? { data: null, error: { message: "No rows returned", code: "PGRST116" } }
        : { data: arr[0], error: null };
    }
    if (this._maybeSingle) {
      return { data: arr[0] ?? null, error: null };
    }
    return { data: arr, error: null };
  }
}

// ─── Auth stub ────────────────────────────────────────────────────────────────
// Auth stays on Supabase even in cPanel DB mode. This stub is used as a fallback.

const authStub = {
  getUser:    async () => ({ data: { user: null }, error: null }),
  getSession: async () => ({ data: { session: null }, error: null }),
  signInWithPassword: async () => ({ data: {}, error: { message: "Auth is managed by Supabase. cPanel mode only switches the data database." } }),
  signOut: async () => ({ error: null }),
  onAuthStateChange: (_cb: any) => ({ data: { subscription: { unsubscribe: () => {} } } }),
};

// ─── Storage stub ─────────────────────────────────────────────────────────────

const storageStub = {
  from: () => ({
    upload:       async () => ({ data: null, error: { message: "Storage uses the server upload endpoint in cPanel mode." } }),
    getPublicUrl: (_path: string) => ({ data: { publicUrl: "" } }),
    list:         async () => ({ data: [], error: null }),
    remove:       async () => ({ data: null, error: null }),
  }),
};

// ─── RPC helper ───────────────────────────────────────────────────────────────

async function rpc(fnName: string, params?: object): Promise<{ data: any; error: any }> {
  return proxyRequest({ operation: "rpc", rpc_name: fnName, rpc_params: params || {} });
}

// ─── The client ───────────────────────────────────────────────────────────────

export const pgClient = {
  from: (table: string) => new QueryBuilder(table),
  rpc,
  auth: authStub,
  storage: storageStub,
  // Raw SQL for internal use
  raw: (sql: string, params?: any[]) =>
    proxyRequest({ operation: "raw", sql, sqlParams: params }),
};
