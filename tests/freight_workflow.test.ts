import { describe, it, expect } from "vitest";
import {
  FreightWorkflowEngine,
  FreightWorkflow,
  ExecutionContext
} from "../src/workflows/freightSchema.js";
import crypto from "crypto";

describe("Freight Workflow Schema & Triage Engine", () => {
  const sampleWorkflow: FreightWorkflow = {
    workflowId: "wf-gate-inbound-01",
    facilityId: "wh-atlanta-crossdock",
    version: "2.1.0",
    name: "Automated Inbound Gate & eBOL Digitize Flow",
    tmsWebhookUrl: "https://tms.example.com/api/v1/gate-events",
    steps: [
      {
        id: "step_checkin",
        name: "Driver Gate Arrival",
        stepType: "driver_checkin",
        requiredPriorSteps: [],
        timeoutSeconds: 1800,
        fields: [
          { name: "driverPhone", label: "Driver Mobile", type: "string", required: true, validationRegex: "^\\+1\\d{10}$" },
          { name: "cdlNumber", label: "Commercial Driver License", type: "string", required: true },
          { name: "tractorNumber", label: "Power Unit / Tractor #", type: "string", required: true }
        ]
      },
      {
        id: "step_appointment",
        name: "Dock Door Assignment",
        stepType: "dock_appointment",
        requiredPriorSteps: ["step_checkin"],
        timeoutSeconds: 3600,
        fields: [
          { name: "dockDoor", label: "Assigned Dock Door", type: "string", required: true, validationRegex: "^DOOR-(0[1-9]|[1-9][0-9])$" },
          { name: "expectedUnloadMinutes", label: "Target Unload Duration", type: "number", required: true }
        ]
      },
      {
        id: "step_inspection",
        name: "Trailer Seal & Temperature Inspection",
        stepType: "trailer_inspection",
        requiredPriorSteps: ["step_appointment"],
        timeoutSeconds: 1800,
        fields: [
          { name: "sealIntact", label: "Security Seal Status", type: "boolean", required: true },
          { name: "sealNumber", label: "Bolt Seal ID", type: "string", required: true },
          { name: "tempFahrenheit", label: "Reefer Temperature", type: "number", required: false }
        ]
      },
      {
        id: "step_ebol",
        name: "eBOL Document Digitize & Driver Signature",
        stepType: "ebol_digitization",
        requiredPriorSteps: ["step_inspection"],
        timeoutSeconds: 3600,
        fields: [
          { name: "pieceCount", label: "Verified Pallet / Piece Count", type: "number", required: true },
          { name: "bolNumber", label: "Bill of Lading Number", type: "string", required: true },
          { name: "driverSignature", label: "Cryptographic E-Signature", type: "signature", required: true }
        ]
      }
    ]
  };

  it("successfully parses valid freight workflow schema and validates DAG dependencies", () => {
    const engine = new FreightWorkflowEngine(sampleWorkflow);
    expect(engine).toBeDefined();
  });

  it("detects and rejects circular or invalid prior step dependencies", () => {
    const invalidWorkflow = {
      ...sampleWorkflow,
      steps: [
        {
          id: "step_a",
          name: "Step A",
          stepType: "driver_checkin" as const,
          requiredPriorSteps: ["step_b"],
          timeoutSeconds: 600,
          fields: []
        },
        {
          id: "step_b",
          name: "Step B",
          stepType: "dock_appointment" as const,
          requiredPriorSteps: ["step_c"],
          timeoutSeconds: 600,
          fields: []
        }
      ]
    };

    expect(() => new FreightWorkflowEngine(invalidWorkflow)).toThrow(
      "Step step_b references non-existent prior step: step_c"
    );
  });

  it("executes the full gate-to-eBOL workflow successfully with valid inputs", () => {
    const engine = new FreightWorkflowEngine(sampleWorkflow);
    let ctx: ExecutionContext = {
      workflowId: sampleWorkflow.workflowId,
      facilityId: sampleWorkflow.facilityId,
      driverId: "drv-88341",
      carrierCode: "KNIG",
      appointmentRef: "APT-20261121-004",
      completedSteps: {},
      history: []
    };

    // Step 1: Check-in
    const res1 = engine.executeStep(
      "step_checkin",
      {
        driverPhone: "+14045550199",
        cdlNumber: "GA-98234112",
        tractorNumber: "TR-4091"
      },
      ctx,
      "gate_kiosk"
    );
    expect(res1.success).toBe(true);
    ctx = res1.context;

    // Step 2: Dock Appointment
    const res2 = engine.executeStep(
      "step_appointment",
      {
        dockDoor: "DOOR-14",
        expectedUnloadMinutes: 45
      },
      ctx,
      "dock_scheduler"
    );
    expect(res2.success).toBe(true);
    ctx = res2.context;

    // Step 3: Trailer Inspection
    const res3 = engine.executeStep(
      "step_inspection",
      {
        sealIntact: true,
        sealNumber: "SEAL-99214A",
        tempFahrenheit: 34.5
      },
      ctx,
      "dock_operator"
    );
    expect(res3.success).toBe(true);
    ctx = res3.context;

    // Step 4: eBOL Digitize
    const res4 = engine.executeStep(
      "step_ebol",
      {
        pieceCount: 24,
        bolNumber: "BOL-US-2026-90412",
        driverSignature: "sig_ed25519_88a4f910"
      },
      ctx,
      "driver_mobile_app"
    );
    expect(res4.success).toBe(true);
    ctx = res4.context;

    expect(Object.keys(ctx.completedSteps)).toHaveLength(4);
    expect(ctx.history).toHaveLength(4);

    // Verify TMS Dispatch Webhook generation
    const webhook = engine.generateTmsDispatchWebhook(ctx, "secret-tms-hmac-key");
    expect(webhook.url).toBe("https://tms.example.com/api/v1/gate-events");
    expect(webhook.payload.status).toBe("COMPLETED");
    expect(webhook.payload.carrierCode).toBe("KNIG");
    expect(webhook.payload.appointmentRef).toBe("APT-20261121-004");

    // Validate HMAC verification
    const expectedSig = crypto
      .createHmac("sha256", "secret-tms-hmac-key")
      .update(`${webhook.timestamp}.${JSON.stringify(webhook.payload)}`)
      .digest("hex");
    expect(webhook.signature).toBe(expectedSig);
  });

  it("prevents execution when prerequisite steps are missing", () => {
    const engine = new FreightWorkflowEngine(sampleWorkflow);
    const ctx: ExecutionContext = {
      workflowId: sampleWorkflow.workflowId,
      facilityId: sampleWorkflow.facilityId,
      driverId: "drv-101",
      carrierCode: "SWFT",
      appointmentRef: "APT-100",
      completedSteps: {},
      history: []
    };

    // Attempting step_appointment before step_checkin
    const res = engine.executeStep("step_appointment", { dockDoor: "DOOR-02", expectedUnloadMinutes: 30 }, ctx);
    expect(res.success).toBe(false);
    expect(res.errors?.[0]).toContain("Prerequisite step 'step_checkin' must be completed before 'step_appointment'");
  });

  it("validates regex field constraints (e.g. invalid driver phone or dock door)", () => {
    const engine = new FreightWorkflowEngine(sampleWorkflow);
    const ctx: ExecutionContext = {
      workflowId: sampleWorkflow.workflowId,
      facilityId: sampleWorkflow.facilityId,
      driverId: "drv-102",
      carrierCode: "JBHT",
      appointmentRef: "APT-102",
      completedSteps: {},
      history: []
    };

    const res = engine.executeStep(
      "step_checkin",
      {
        driverPhone: "invalid-phone",
        cdlNumber: "TX-12345",
        tractorNumber: "TR-10"
      },
      ctx
    );

    expect(res.success).toBe(false);
    expect(res.errors?.[0]).toContain("failed format validation regex");
  });
});
