import { z } from "zod";
import crypto from "crypto";

export const WorkspaceStateEnum = z.enum([
  "intake",
  "scoping",
  "architecture_design",
  "sprint_execution",
  "user_acceptance",
  "production_live"
]);
export type WorkspaceState = z.infer<typeof WorkspaceStateEnum>;

const VALID_TRANSITIONS: Record<WorkspaceState, WorkspaceState[]> = {
  intake: ["scoping"],
  scoping: ["architecture_design", "intake"],
  architecture_design: ["sprint_execution", "scoping"],
  sprint_execution: ["user_acceptance"],
  user_acceptance: ["production_live", "sprint_execution"],
  production_live: []
};

export const AIModelPricingNZD: Record<string, { promptPer1k: number; completionPer1k: number }> = {
  "claude-3-5-sonnet": { promptPer1k: 0.005, completionPer1k: 0.025 },
  "gpt-4o": { promptPer1k: 0.004, completionPer1k: 0.016 },
  "gemini-1-5-pro": { promptPer1k: 0.002, completionPer1k: 0.008 }
};

export const AIAutomationTaskSchema = z.object({
  taskId: z.string().uuid(),
  workspaceId: z.string().min(3),
  taskType: z.enum([
    "lead_enrichment",
    "prompt_generation",
    "code_audit",
    "test_suite_synthesis",
    "workflow_orchestration"
  ]),
  model: z.string(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  latencyMs: z.number().positive(),
  status: z.enum(["pending", "executing", "completed", "failed"])
});
export type AIAutomationTask = z.infer<typeof AIAutomationTaskSchema>;

export function calculateTaskCostNZD(promptTokens: number, completionTokens: number, model: string): number {
  const pricing = AIModelPricingNZD[model] || { promptPer1k: 0.003, completionPer1k: 0.012 };
  const promptCost = (promptTokens / 1000) * pricing.promptPer1k;
  const completionCost = (completionTokens / 1000) * pricing.completionPer1k;
  return Number((promptCost + completionCost).toFixed(6));
}

export function transitionWorkspaceState(
  currentState: WorkspaceState,
  nextState: WorkspaceState
): { success: boolean; state: WorkspaceState; error?: string } {
  const allowed = VALID_TRANSITIONS[currentState] || [];
  if (!allowed.includes(nextState)) {
    return {
      success: false,
      state: currentState,
      error: `Illegal state transition from ${currentState} to ${nextState}. Allowed: [${allowed.join(", ")}]`
    };
  }
  return { success: true, state: nextState };
}

export function generateWebhookEventSignature(payload: string, secret: string, timestamp: number): string {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(`${timestamp}.${payload}`);
  return `t=${timestamp},v1=${hmac.digest("hex")}`;
}

export function verifyWebhookEventSignature(
  header: string,
  payload: string,
  secret: string,
  maxAgeSeconds = 300
): { valid: boolean; reason?: string } {
  const parts = header.split(",");
  const timePart = parts.find((p) => p.startsWith("t="));
  const sigPart = parts.find((p) => p.startsWith("v1="));

  if (!timePart || !sigPart) {
    return { valid: false, reason: "Malformed signature header format" };
  }

  const timestamp = parseInt(timePart.slice(2), 10);
  const signature = sigPart.slice(3);

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > maxAgeSeconds) {
    return { valid: false, reason: "Webhook timestamp expired outside replay window" };
  }

  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) {
    return { valid: false, reason: "Cryptographic HMAC digest mismatch" };
  }

  return { valid: true };
}
