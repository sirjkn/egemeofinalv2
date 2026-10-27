import fs from "fs";
import path from "path";
import pool from "./connection";

const MIGRATIONS_DIR = path.resolve(__dirname, "migrations");

async function run() {
  const client = await pool.connect();
  try {
    // Track which migrations have been applied
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename  VARCHAR(200) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const applied = new Set(
      (await client.query("SELECT filename FROM _migrations")).rows.map((r: any) => r.filename)
    );

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  skip  ${file}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO _migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`  apply ${file}`);
    }

    console.log("Migrations complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
