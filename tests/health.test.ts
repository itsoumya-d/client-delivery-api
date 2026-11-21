import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { newDb } from "pg-mem";
import { buildApp } from "../src/app.js";
import { Database } from "../src/db.js";

const schema = readFileSync(new URL("../src/schema.sql", import.meta.url), "utf8");

function testDatabase(): Database {
  const mem = newDb();
  mem.public.none(schema);
  const adapter = mem.adapters.createPg();
  const pool = new adapter.Pool();
  return {
    async query(sql: string, params: unknown[] = []) {
      const result = await pool.query(sql, params);
      return result.rows;
    },
    async close() {
      await pool.end();
    }
  };
}

describe("Health & Readiness Probe", () => {
  it("returns 200 and ok status without requiring API key", async () => {
    const db = testDatabase();
    const app = buildApp(db, "test-key");
    const start = Date.now();
    const res = await app.inject({ method: "GET", url: "/health" });
    const duration = Date.now() - start;

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    expect(duration).toBeLessThan(100);
  });
});
