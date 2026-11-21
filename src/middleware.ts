import { createHmac, timingSafeEqual } from "node:crypto";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export interface RateLimitOptions {
  capacity: number;
  refillPerSecond: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
}

export class TokenBucketRateLimiter {
  private buckets = new Map<string, { tokens: number; lastRefill: number }>();
  private readonly capacity: number;
  private readonly refillPerSecond: number;

  constructor(options: RateLimitOptions) {
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
  }

  public check(key: string, nowMs = Date.now()): RateLimitResult {
    let entry = this.buckets.get(key);
    if (!entry) {
      entry = { tokens: this.capacity, lastRefill: nowMs };
      this.buckets.set(key, entry);
    } else {
      const elapsedSec = (nowMs - entry.lastRefill) / 1000;
      entry.tokens = Math.min(this.capacity, entry.tokens + elapsedSec * this.refillPerSecond);
      entry.lastRefill = nowMs;
    }

    if (entry.tokens >= 1) {
      entry.tokens -= 1;
      const resetSeconds = Math.ceil((this.capacity - entry.tokens) / this.refillPerSecond);
      return { allowed: true, remaining: Math.floor(entry.tokens), resetSeconds };
    }

    const resetSeconds = Math.ceil((1 - entry.tokens) / this.refillPerSecond);
    return { allowed: false, remaining: 0, resetSeconds };
  }

  public reset(key?: string): void {
    if (key) {
      this.buckets.delete(key);
    } else {
      this.buckets.clear();
    }
  }
}

export function signWebhookPayload(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): { signature: string; timestamp: number } {
  const hmac = createHmac("sha256", secret);
  hmac.update(`${timestamp}.${payload}`);
  return { signature: hmac.digest("hex"), timestamp };
}

export function verifyWebhookSignature(
  payload: string,
  secret: string,
  headerSignature: string,
  headerTimestamp: string,
  toleranceSeconds = 300
): { valid: boolean; reason?: string } {
  if (!headerSignature || !headerTimestamp) {
    return { valid: false, reason: "missing signature or timestamp header" };
  }

  const ts = Number.parseInt(headerTimestamp, 10);
  if (Number.isNaN(ts)) {
    return { valid: false, reason: "invalid timestamp header" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSeconds) {
    return { valid: false, reason: "timestamp outside tolerance window" };
  }

  const hmac = createHmac("sha256", secret);
  hmac.update(`${ts}.${payload}`);
  const expectedSig = hmac.digest("hex");

  try {
    const expectedBuf = Buffer.from(expectedSig, "hex");
    const actualBuf = Buffer.from(headerSignature, "hex");
    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
      return { valid: false, reason: "signature mismatch" };
    }
    return { valid: true };
  } catch {
    return { valid: false, reason: "signature parsing failure" };
  }
}

export interface GatewayMiddlewareOptions {
  apiKey: string;
  webhookSecret?: string;
  rateLimiter?: TokenBucketRateLimiter;
}

export function attachGatewayHooks(app: FastifyInstance, options: GatewayMiddlewareOptions): void {
  const limiter = options.rateLimiter ?? new TokenBucketRateLimiter({ capacity: 100, refillPerSecond: 10 });

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    (request as unknown as { startTime: number }).startTime = Date.now();
    const requestId = (request.headers["x-request-id"] as string) || `req_${Math.random().toString(36).slice(2, 10)}`;
    reply.header("x-request-id", requestId);
  });

  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url === "/health") return;

    // 1. Rate limiting check
    const clientKey = (request.headers["x-api-key"] as string) || request.ip || "anonymous";
    const limitResult = limiter.check(clientKey);

    reply.header("x-ratelimit-limit", 100);
    reply.header("x-ratelimit-remaining", limitResult.remaining);
    reply.header("x-ratelimit-reset", limitResult.resetSeconds);

    if (!limitResult.allowed) {
      reply.code(429).send({ error: "rate limit exceeded, retry later" });
      return;
    }

    // 2. Authentication check
    if (request.url.startsWith("/webhooks/")) return;

    const providedKey = request.headers["x-api-key"];
    if (providedKey !== options.apiKey) {
      reply.code(401).send({ error: "missing or invalid API key" });
      return;
    }
  });

  app.addHook("onSend", async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const startTime = (request as unknown as { startTime: number }).startTime;
    if (startTime) {
      const elapsedMs = Date.now() - startTime;
      reply.header("x-response-time", `${elapsedMs}ms`);
    }
    return payload;
  });
}
