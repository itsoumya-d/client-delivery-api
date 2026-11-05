import { readFileSync } from "node:fs";
import { newDb } from "pg-mem";
import { describe, expect, it, beforeEach } from "vitest";
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

describe("client delivery API", () => {
  let db: Database;
  let app: ReturnType<typeof buildApp>;
  const headers = { "x-api-key": "test-key" };

  beforeEach(() => {
    db = testDatabase();
    app = buildApp(db, "test-key");
  });

  async function client(code = "ACME") {
    const response = await app.inject({ method: "POST", url: "/clients", headers, payload: { code, name: "Acme Ltd" } });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  async function project(clientId: number, code = "PRJ-1") {
    const response = await app.inject({
      method: "POST", url: "/projects", headers,
      payload: { client_id: clientId, code, name: "Portal", budget_cents: 5000000, start_date: "2026-01-01", end_date: "2026-06-30" }
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  it("serves health without auth", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("rejects missing API key", async () => {
    const response = await app.inject({ method: "POST", url: "/clients", payload: { code: "X", name: "X" } });
    expect(response.statusCode).toBe(401);
  });

  it("creates a client", async () => {
    const row = await client();
    expect(row.code).toBe("ACME");
  });

  it("rejects duplicate client", async () => {
    await client();
    const response = await app.inject({ method: "POST", url: "/clients", headers, payload: { code: "ACME", name: "Again" } });
    expect(response.statusCode).toBe(422);
  });

  it("creates a project", async () => {
    const c = await client();
    const p = await project(c.id);
    expect(p.status).toBe("active");
  });

  it("rejects project without client", async () => {
    const response = await app.inject({
      method: "POST", url: "/projects", headers,
      payload: { client_id: 999, code: "P", name: "P", budget_cents: 100, start_date: "2026-01-01", end_date: "2026-02-01" }
    });
    expect(response.statusCode).toBe(404);
  });

  it("rejects invalid project dates", async () => {
    const c = await client();
    const response = await app.inject({
      method: "POST", url: "/projects", headers,
      payload: { client_id: c.id, code: "P", name: "P", budget_cents: 100, start_date: "2026-06-01", end_date: "2026-01-01" }
    });
    expect(response.statusCode).toBe(422);
  });

  it("adds a milestone", async () => {
    const c = await client();
    const p = await project(c.id);
    const response = await app.inject({
      method: "POST", url: "/milestones", headers,
      payload: { project_id: p.id, name: "Discovery", amount_cents: 1000000, due_date: "2026-02-01" }
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().status).toBe("pending");
  });

  it("rejects duplicate milestone", async () => {
    const c = await client();
    const p = await project(c.id);
    const payload = { project_id: p.id, name: "Discovery", amount_cents: 1000000, due_date: "2026-02-01" };
    await app.inject({ method: "POST", url: "/milestones", headers, payload });
    const response = await app.inject({ method: "POST", url: "/milestones", headers, payload });
    expect(response.statusCode).toBe(422);
  });

  it("approves a milestone", async () => {
    const c = await client();
    const p = await project(c.id);
    const m = await app.inject({ method: "POST", url: "/milestones", headers, payload: { project_id: p.id, name: "Discovery", amount_cents: 1000000, due_date: "2026-02-01" } });
    const response = await app.inject({ method: "POST", url: `/milestones/${m.json().id}/approve`, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("approved");
  });

  it("is idempotent on repeated approval", async () => {
    const c = await client();
    const p = await project(c.id);
    const m = await app.inject({ method: "POST", url: "/milestones", headers, payload: { project_id: p.id, name: "Discovery", amount_cents: 1000000, due_date: "2026-02-01" } });
    await app.inject({ method: "POST", url: `/milestones/${m.json().id}/approve`, headers });
    const second = await app.inject({ method: "POST", url: `/milestones/${m.json().id}/approve`, headers });
    expect(second.json().unchanged).toBe(true);
  });

  it("proposes a change request", async () => {
    const c = await client();
    const p = await project(c.id);
    const response = await app.inject({ method: "POST", url: "/changes", headers, payload: { project_id: p.id, title: "Extra report", scope: "Add one report", cost_impact_cents: 250000 } });
    expect(response.statusCode).toBe(201);
  });

  it("approves a change request", async () => {
    const c = await client();
    const p = await project(c.id);
    const ch = await app.inject({ method: "POST", url: "/changes", headers, payload: { project_id: p.id, title: "Extra", scope: "Scope", cost_impact_cents: 250000 } });
    const response = await app.inject({ method: "POST", url: `/changes/${ch.json().id}/decide`, headers, payload: { approved: true } });
    expect(response.json().status).toBe("approved");
  });

  it("rejects a change request", async () => {
    const c = await client();
    const p = await project(c.id);
    const ch = await app.inject({ method: "POST", url: "/changes", headers, payload: { project_id: p.id, title: "Extra", scope: "Scope", cost_impact_cents: 250000 } });
    const response = await app.inject({ method: "POST", url: `/changes/${ch.json().id}/decide`, headers, payload: { approved: false } });
    expect(response.json().status).toBe("rejected");
  });

  it("summarises project financials", async () => {
    const c = await client();
    const p = await project(c.id);
    const m1 = await app.inject({ method: "POST", url: "/milestones", headers, payload: { project_id: p.id, name: "Discovery", amount_cents: 1000000, due_date: "2026-02-01" } });
    await app.inject({ method: "POST", url: "/milestones", headers, payload: { project_id: p.id, name: "Build", amount_cents: 2000000, due_date: "2026-04-01" } });
    await app.inject({ method: "POST", url: `/milestones/${m1.json().id}/approve`, headers });
    const ch = await app.inject({ method: "POST", url: "/changes", headers, payload: { project_id: p.id, title: "Extra", scope: "Scope", cost_impact_cents: 250000 } });
    await app.inject({ method: "POST", url: `/changes/${ch.json().id}/decide`, headers, payload: { approved: true } });
    const response = await app.inject({ method: "GET", url: `/projects/${p.id}/summary`, headers });
    const summary = response.json();
    expect(summary.approved_milestones_cents).toBe(1000000);
    expect(summary.pending_milestones_cents).toBe(2000000);
    expect(summary.approved_change_cents).toBe(250000);
    expect(summary.projected_total_cents).toBe(3250000);
  });

  it("records project activities", async () => {
    const c = await client();
    const p = await project(c.id);
    const response = await app.inject({ method: "GET", url: `/projects/${p.id}/activities`, headers });
    expect(response.json()[0].action).toBe("project_created");
  });

  it("returns 404 for missing project summary", async () => {
    const response = await app.inject({ method: "GET", url: "/projects/999/summary", headers });
    expect(response.statusCode).toBe(404);
  });

  it("runs the full workflow", async () => {
    const c = await client("FULL");
    const p = await project(c.id, "FULL-1");
    const m = await app.inject({ method: "POST", url: "/milestones", headers, payload: { project_id: p.id, name: "Delivery", amount_cents: 500000, due_date: "2026-03-01" } });
    await app.inject({ method: "POST", url: `/milestones/${m.json().id}/approve`, headers });
    const summary = await app.inject({ method: "GET", url: `/projects/${p.id}/summary`, headers });
    expect(summary.json().remaining_cents).toBe(4500000);
  });
});
