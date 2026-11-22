import { describe, it, expect } from "vitest";
import {
  transitionWorkspaceState,
  calculateTaskCostNZD,
  generateWebhookEventSignature,
  verifyWebhookEventSignature,
  AIAutomationTaskSchema
} from "../src/workflows/afforditPortalSchema.js";
import crypto from "crypto";

describe("AffordIT Client Portal & AI Automation Engine", () => {
  it("transitions workspace state through standard delivery stages", () => {
    const s1 = transitionWorkspaceState("intake", "scoping");
    expect(s1.success).toBe(true);
    expect(s1.state).toBe("scoping");

    const s2 = transitionWorkspaceState("scoping", "architecture_design");
    expect(s2.success).toBe(true);
    expect(s2.state).toBe("architecture_design");

    const s3 = transitionWorkspaceState("architecture_design", "sprint_execution");
    expect(s3.success).toBe(true);
    expect(s3.state).toBe("sprint_execution");

    const s4 = transitionWorkspaceState("sprint_execution", "user_acceptance");
    expect(s4.success).toBe(true);
    expect(s4.state).toBe("user_acceptance");

    const s5 = transitionWorkspaceState("user_acceptance", "production_live");
    expect(s5.success).toBe(true);
    expect(s5.state).toBe("production_live");
  });

  it("blocks illegal workspace state transitions", () => {
    const res = transitionWorkspaceState("intake", "production_live");
    expect(res.success).toBe(false);
    expect(res.state).toBe("intake");
    expect(res.error).toContain("Illegal state transition");
  });

  it("allows rolling back to earlier stages when changes are requested", () => {
    const rollback = transitionWorkspaceState("user_acceptance", "sprint_execution");
    expect(rollback.success).toBe(true);
    expect(rollback.state).toBe("sprint_execution");
  });

  it("calculates AI task costs in NZD accurately based on token consumption", () => {
    const cost = calculateTaskCostNZD(2000, 1000, "claude-3-5-sonnet");
    // 2 * 0.005 + 1 * 0.025 = 0.010 + 0.025 = 0.035 NZD
    expect(cost).toBe(0.035);
  });

  it("validates AI automation task schema structure and prevents negative tokens", () => {
    const valid = AIAutomationTaskSchema.safeParse({
      taskId: crypto.randomUUID(),
      workspaceId: "affordit-proj-01",
      taskType: "code_audit",
      model: "claude-3-5-sonnet",
      promptTokens: 1500,
      completionTokens: 800,
      latencyMs: 1450.5,
      status: "completed"
    });
    expect(valid.success).toBe(true);

    const invalid = AIAutomationTaskSchema.safeParse({
      taskId: "not-a-uuid",
      workspaceId: "pr",
      taskType: "unsupported",
      model: "gpt-4o",
      promptTokens: -100,
      completionTokens: 50,
      latencyMs: -10,
      status: "pending"
    });
    expect(invalid.success).toBe(false);
  });

  it("generates and verifies HMAC-SHA256 signatures for webhook delivery", () => {
    const secret = "affordit_webhook_secret_key_prod";
    const payload = JSON.stringify({ event: "project.approved", budget: 15000 });
    const now = Math.floor(Date.now() / 1000);

    const sigHeader = generateWebhookEventSignature(payload, secret, now);
    const verification = verifyWebhookEventSignature(sigHeader, payload, secret);
    expect(verification.valid).toBe(true);
  });

  it("rejects tampered webhook payloads", () => {
    const secret = "affordit_webhook_secret_key_prod";
    const payload = JSON.stringify({ event: "milestone.paid", amount: 5000 });
    const tamperedPayload = JSON.stringify({ event: "milestone.paid", amount: 50000 });
    const now = Math.floor(Date.now() / 1000);

    const sigHeader = generateWebhookEventSignature(payload, secret, now);
    const verification = verifyWebhookEventSignature(sigHeader, tamperedPayload, secret);
    expect(verification.valid).toBe(false);
    expect(verification.reason).toBe("Cryptographic HMAC digest mismatch");
  });

  it("rejects expired webhook signatures to prevent replay attacks", () => {
    const secret = "affordit_webhook_secret_key_prod";
    const payload = JSON.stringify({ event: "client.created" });
    const past = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago (> 300s)

    const sigHeader = generateWebhookEventSignature(payload, secret, past);
    const verification = verifyWebhookEventSignature(sigHeader, payload, secret);
    expect(verification.valid).toBe(false);
    expect(verification.reason).toBe("Webhook timestamp expired outside replay window");
  });
});
