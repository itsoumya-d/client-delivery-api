import { readFileSync } from "node:fs";
import { newDb } from "pg-mem";
import { describe, expect, it, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import { Database } from "../src/db.js";
import { TokenBucketRateLimiter, signWebhookPayload, verifyWebhookSignature } from "../src/middleware.js";

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

describe("gateway middleware, rate limiter and webhook signatures", () => {
  let db: Database;
  const apiKey = "gateway-test-key";
  const webhookSecret = "whsec_super_secret_signing_key";

  beforeEach(() => {
    db = testDatabase();
  });

  it("attaches x-request-id and x-response-time telemetry headers", async () => {
    const app = buildApp(db, apiKey);
    const res = await app.inject({
      method: "GET",
      url: "/health"
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).toBeDefined();
    expect(res.headers["x-response-time"]).toBeDefined();
    expect(res.headers["x-response-time"]).toMatch(/\d+ms/);
  });

  it("enforces token bucket rate limiting and returns 429 when exhausted", async () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 3, refillPerSecond: 0.1 });
    const app = buildApp(db, apiKey, { rateLimiter: limiter });

    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/clients",
        headers: { "x-api-key": apiKey },
        payload: { code: `C_${i}`, name: `Client ${i}` }
      });
      expect(res.statusCode).toBe(201);
      expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
    }

    // 4th request must exceed capacity
    const rejected = await app.inject({
      method: "POST",
      url: "/clients",
      headers: { "x-api-key": apiKey },
      payload: { code: "C_OVER", name: "Client Over" }
    });

    expect(rejected.statusCode).toBe(429);
    expect(rejected.json()).toEqual({ error: "rate limit exceeded, retry later" });
    expect(rejected.headers["x-ratelimit-remaining"]).toBe("0");
  });

  it("signs and verifies webhook payload with HMAC-SHA256", () => {
    const payload = JSON.stringify({ event: "milestone.approved", milestone_id: 101 });
    const { signature, timestamp } = signWebhookPayload(payload, webhookSecret);

    const check = verifyWebhookSignature(payload, webhookSecret, signature, String(timestamp), 60);
    expect(check.valid).toBe(true);
    expect(check.reason).toBeUndefined();
  });

  it("rejects tampered webhook payloads", () => {
    const originalPayload = JSON.stringify({ event: "milestone.approved", milestone_id: 101 });
    const { signature, timestamp } = signWebhookPayload(originalPayload, webhookSecret);

    const tamperedPayload = JSON.stringify({ event: "milestone.approved", milestone_id: 999 });
    const check = verifyWebhookSignature(tamperedPayload, webhookSecret, signature, String(timestamp), 60);

    expect(check.valid).toBe(false);
    expect(check.reason).toBe("signature mismatch");
  });

  it("rejects expired webhook timestamps", () => {
    const payload = JSON.stringify({ event: "project.created" });
    const pastTimestamp = Math.floor(Date.now() / 1000) - 400; // 400s ago, outside 300s tolerance
    const { signature } = signWebhookPayload(payload, webhookSecret, pastTimestamp);

    const check = verifyWebhookSignature(payload, webhookSecret, signature, String(pastTimestamp), 300);
    expect(check.valid).toBe(false);
    expect(check.reason).toBe("timestamp outside tolerance window");
  });

  it("handles valid webhook ingestion through /webhooks/events", async () => {
    const app = buildApp(db, apiKey, { webhookSecret });
    const eventPayload = { event: "change_request.approved", id: 42 };
    const rawPayload = JSON.stringify(eventPayload);
    const { signature, timestamp } = signWebhookPayload(rawPayload, webhookSecret);

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/events",
      headers: {
        "content-type": "application/json",
        "x-signature-sha256": signature,
        "x-signature-timestamp": String(timestamp)
      },
      payload: eventPayload
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
  });

  it("rejects unauthorized webhook ingestion with invalid signature", async () => {
    const app = buildApp(db, apiKey, { webhookSecret });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/events",
      headers: {
        "content-type": "application/json",
        "x-signature-sha256": "bad_hex_signature",
        "x-signature-timestamp": String(Math.floor(Date.now() / 1000))
      },
      payload: { event: "unauthorized" }
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthorized webhook");
  });
});
