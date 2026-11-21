import { z } from "zod";
import crypto from "crypto";

export const WorkflowStepTypeSchema = z.enum([
  "driver_checkin",
  "dock_appointment",
  "trailer_inspection",
  "ebol_digitization",
  "tms_dispatch_webhook"
]);

export type WorkflowStepType = z.infer<typeof WorkflowStepTypeSchema>;

export const FreightFieldSchema = z.object({
  name: z.string().min(1),
  label: z.string(),
  type: z.enum(["string", "number", "boolean", "signature", "photo", "select"]),
  required: z.boolean().default(true),
  validationRegex: z.string().optional()
});

export const WorkflowStepDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  stepType: WorkflowStepTypeSchema,
  fields: z.array(FreightFieldSchema),
  requiredPriorSteps: z.array(z.string()).default([]),
  timeoutSeconds: z.number().positive().default(3600)
});

export const FreightWorkflowSchema = z.object({
  workflowId: z.string().min(1),
  facilityId: z.string().min(1),
  version: z.string().default("1.0.0"),
  name: z.string().min(1),
  steps: z.array(WorkflowStepDefinitionSchema).min(1),
  tmsWebhookUrl: z.string().url().optional()
});

export type FreightWorkflow = z.infer<typeof FreightWorkflowSchema>;
export type WorkflowStepDefinition = z.infer<typeof WorkflowStepDefinitionSchema>;

export interface ExecutionContext {
  workflowId: string;
  facilityId: string;
  driverId: string;
  carrierCode: string;
  appointmentRef: string;
  completedSteps: Record<string, Record<string, unknown>>;
  history: Array<{
    stepId: string;
    completedAt: string;
    operator: string;
  }>;
}

export class FreightWorkflowEngine {
  private schema: FreightWorkflow;

  constructor(schema: FreightWorkflow) {
    this.schema = FreightWorkflowSchema.parse(schema);
    this.validateDAG();
  }

  private validateDAG(): void {
    const stepIds = new Set(this.schema.steps.map(s => s.id));
    for (const step of this.schema.steps) {
      for (const prior of step.requiredPriorSteps) {
        if (!stepIds.has(prior)) {
          throw new Error(`Step ${step.id} references non-existent prior step: ${prior}`);
        }
        if (prior === step.id) {
          throw new Error(`Step ${step.id} cannot depend on itself`);
        }
      }
    }
  }

  public validateStepInput(stepId: string, input: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const step = this.schema.steps.find(s => s.id === stepId);
    if (!step) {
      return { valid: false, errors: [`Step ${stepId} not found in workflow schema`] };
    }

    const errors: string[] = [];
    for (const field of step.fields) {
      const val = input[field.name];
      if (field.required && (val === undefined || val === null || val === "")) {
        errors.push(`Missing required field '${field.name}' (${field.label})`);
        continue;
      }
      if (val !== undefined && val !== null && field.validationRegex) {
        const re = new RegExp(field.validationRegex);
        if (!re.test(String(val))) {
          errors.push(`Field '${field.name}' failed format validation regex: ${field.validationRegex}`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  public executeStep(
    stepId: string,
    input: Record<string, unknown>,
    ctx: ExecutionContext,
    operator: string = "system"
  ): { success: boolean; context: ExecutionContext; errors?: string[] } {
    const step = this.schema.steps.find(s => s.id === stepId);
    if (!step) {
      return { success: false, context: ctx, errors: [`Step ${stepId} does not exist`] };
    }

    // Verify dependencies
    for (const req of step.requiredPriorSteps) {
      if (!ctx.completedSteps[req]) {
        return {
          success: false,
          context: ctx,
          errors: [`Prerequisite step '${req}' must be completed before '${stepId}'`]
        };
      }
    }

    // Validate inputs against field schema
    const validation = this.validateStepInput(stepId, input);
    if (!validation.valid) {
      return { success: false, context: ctx, errors: validation.errors };
    }

    const updatedCompleted = { ...ctx.completedSteps, [stepId]: input };
    const updatedHistory = [
      ...ctx.history,
      {
        stepId,
        completedAt: new Date().toISOString(),
        operator
      }
    ];

    const updatedContext: ExecutionContext = {
      ...ctx,
      completedSteps: updatedCompleted,
      history: updatedHistory
    };

    return { success: true, context: updatedContext };
  }

  public generateTmsDispatchWebhook(ctx: ExecutionContext, secretKey: string): {
    url: string | undefined;
    payload: Record<string, unknown>;
    signature: string;
    timestamp: number;
  } {
    const timestamp = Date.now();
    const payload = {
      workflowId: this.schema.workflowId,
      facilityId: ctx.facilityId,
      appointmentRef: ctx.appointmentRef,
      carrierCode: ctx.carrierCode,
      driverId: ctx.driverId,
      status: "COMPLETED",
      summary: ctx.completedSteps,
      auditLength: ctx.history.length,
      dispatchedAt: new Date(timestamp).toISOString()
    };

    const signature = crypto
      .createHmac("sha256", secretKey)
      .update(`${timestamp}.${JSON.stringify(payload)}`)
      .digest("hex");

    return {
      url: this.schema.tmsWebhookUrl,
      payload,
      signature,
      timestamp
    };
  }
}
