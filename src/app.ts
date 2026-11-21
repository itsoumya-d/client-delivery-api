import Fastify, { FastifyInstance } from "fastify";
import { z } from "zod";
import { Database } from "./db.js";
import { DeliveryService, NotFoundError, ValidationError } from "./service.js";
import { attachGatewayHooks, TokenBucketRateLimiter, verifyWebhookSignature } from "./middleware.js";

const clientSchema = z.object({ code: z.string().min(1), name: z.string().min(1) });
const projectSchema = z.object({
  client_id: z.number().int().positive(),
  code: z.string().min(1),
  name: z.string().min(1),
  budget_cents: z.number().int().positive(),
  start_date: z.string(),
  end_date: z.string()
});
const milestoneSchema = z.object({
  project_id: z.number().int().positive(),
  name: z.string().min(1),
  amount_cents: z.number().int().positive(),
  due_date: z.string()
});
const changeSchema = z.object({
  project_id: z.number().int().positive(),
  title: z.string().min(1),
  scope: z.string().min(1),
  cost_impact_cents: z.number().int()
});
const decisionSchema = z.object({ approved: z.boolean() });

export interface AppOptions {
  rateLimiter?: TokenBucketRateLimiter;
  webhookSecret?: string;
}

export function buildApp(db: Database, apiKey: string, options?: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const service = new DeliveryService(db);

  attachGatewayHooks(app, {
    apiKey,
    rateLimiter: options?.rateLimiter,
    webhookSecret: options?.webhookSecret
  });

  const handle = (error: unknown) => {
    if (error instanceof NotFoundError) return { status: 404, body: { error: error.message } };
    if (error instanceof ValidationError) return { status: 422, body: { error: error.message } };
    if (error instanceof z.ZodError) return { status: 422, body: { error: error.issues } };
    return { status: 500, body: { error: "internal error" } };
  };

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/webhooks/events", async (request, reply) => {
    const secret = options?.webhookSecret ?? "whsec_default";
    const sig = request.headers["x-signature-sha256"] as string;
    const ts = request.headers["x-signature-timestamp"] as string;
    const rawPayload = JSON.stringify(request.body ?? {});
    const verification = verifyWebhookSignature(rawPayload, secret, sig, ts);
    if (!verification.valid) {
      return reply.code(401).send({ error: "unauthorized webhook", reason: verification.reason });
    }
    return reply.code(200).send({ received: true });
  });

  app.post("/clients", async (request, reply) => {
    try {
      const body = clientSchema.parse(request.body);
      const row = await service.createClient(body.code, body.name);
      return reply.code(201).send(row);
    } catch (error) {
      const result = handle(error);
      return reply.code(result.status).send(result.body);
    }
  });

  app.post("/projects", async (request, reply) => {
    try {
      const body = projectSchema.parse(request.body);
      const row = await service.createProject(body.client_id, body.code, body.name, body.budget_cents, body.start_date, body.end_date);
      return reply.code(201).send(row);
    } catch (error) {
      const result = handle(error);
      return reply.code(result.status).send(result.body);
    }
  });

  app.post("/milestones", async (request, reply) => {
    try {
      const body = milestoneSchema.parse(request.body);
      const row = await service.addMilestone(body.project_id, body.name, body.amount_cents, body.due_date);
      return reply.code(201).send(row);
    } catch (error) {
      const result = handle(error);
      return reply.code(result.status).send(result.body);
    }
  });

  app.post("/milestones/:id/approve", async (request, reply) => {
    try {
      const id = z.coerce.number().int().positive().parse((request.params as { id: string }).id);
      return await service.approveMilestone(id);
    } catch (error) {
      const result = handle(error);
      return reply.code(result.status).send(result.body);
    }
  });

  app.post("/changes", async (request, reply) => {
    try {
      const body = changeSchema.parse(request.body);
      const row = await service.proposeChange(body.project_id, body.title, body.scope, body.cost_impact_cents);
      return reply.code(201).send(row);
    } catch (error) {
      const result = handle(error);
      return reply.code(result.status).send(result.body);
    }
  });

  app.post("/changes/:id/decide", async (request, reply) => {
    try {
      const id = z.coerce.number().int().positive().parse((request.params as { id: string }).id);
      const body = decisionSchema.parse(request.body);
      return await service.decideChange(id, body.approved);
    } catch (error) {
      const result = handle(error);
      return reply.code(result.status).send(result.body);
    }
  });

  app.get("/projects/:id/summary", async (request, reply) => {
    try {
      const id = z.coerce.number().int().positive().parse((request.params as { id: string }).id);
      return await service.summary(id);
    } catch (error) {
      const result = handle(error);
      return reply.code(result.status).send(result.body);
    }
  });

  app.get("/projects/:id/activities", async (request, reply) => {
    try {
      const id = z.coerce.number().int().positive().parse((request.params as { id: string }).id);
      return await service.activities(id);
    } catch (error) {
      const result = handle(error);
      return reply.code(result.status).send(result.body);
    }
  });

  return app;
}
