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

describe("Failure injection and resilience tests", () => {
  const apiKey = "resilience-test-key";

  it("handles database query exceptions with structured 500 rather than crashing", async () => {
    const failingDb: Database = {
      async query() {
        throw new Error("Simulated database connection failure");
      },
      async close() {}
    };

    const app = buildApp(failingDb, apiKey);
    const res = await app.inject({
      method: "POST",
      url: "/clients",
      headers: { "x-api-key": apiKey },
      payload: { code: "FAIL_DB", name: "Failing Corp" }
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal error" });
  });

  it("handles malformed JSON request bodies with structured 422 error", async () => {
    const db = testDatabase();
    const app = buildApp(db, apiKey);
    const res = await app.inject({
      method: "POST",
      url: "/clients",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      payload: { invalid_field: 123 }
    });

    expect(res.statusCode).toBe(422);
  });

  it("sustains concurrent burst requests without crashing", async () => {
    const db = testDatabase();
    const app = buildApp(db, apiKey);
    const requests = Array.from({ length: 30 }, () =>
      app.inject({ method: "GET", url: "/health" })
    );

    const responses = await Promise.all(requests);
    for (const r of responses) {
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ status: "ok" });
    }
  });
});
