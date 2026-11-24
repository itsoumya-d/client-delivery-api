import { createHmac } from "node:crypto";

export interface TariffRule {
  gracePeriodMinutes: number;
  hourlyRateCents: number;
  dailyCapCents: number;
}

export interface ANPREvent {
  eventId: string;
  facilityId: string;
  licensePlate: string;
  timestamp: string;
  type: "ENTRY" | "EXIT";
  confidence: number;
}

export interface ParkingSession {
  sessionId: string;
  facilityId: string;
  licensePlate: string;
  entryTime: string;
  exitTime?: string;
  durationMinutes?: number;
  feeCents?: number;
  status: "ACTIVE" | "COMPLETED" | "VIOLATION";
}

export function normalizeLicensePlate(plate: string): string {
  return plate.toUpperCase().replace(/[^A-Z0-9]/g, "").trim();
}

export function calculateParkingFee(
  entryTime: Date,
  exitTime: Date,
  tariff: TariffRule
): { durationMinutes: number; feeCents: number; gracePeriodApplied: boolean } {
  const diffMs = exitTime.getTime() - entryTime.getTime();
  const durationMinutes = Math.max(0, Math.ceil(diffMs / (1000 * 60)));

  if (durationMinutes <= tariff.gracePeriodMinutes) {
    return { durationMinutes, feeCents: 0, gracePeriodApplied: true };
  }

  const billableMinutes = durationMinutes - tariff.gracePeriodMinutes;
  const billableHours = Math.ceil(billableMinutes / 60);
  const rawFee = billableHours * tariff.hourlyRateCents;
  const feeCents = Math.min(rawFee, tariff.dailyCapCents);

  return { durationMinutes, feeCents, gracePeriodApplied: false };
}

export class MobilityFacilityEngine {
  private activeSessions = new Map<string, ParkingSession>();
  private completedSessions: ParkingSession[] = [];
  readonly facilityId: string;
  readonly capacity: number;
  readonly tariff: TariffRule;
  readonly secretKey: string;

  constructor(facilityId: string, capacity: number, tariff: TariffRule, secretKey = "telemetry-secret") {
    this.facilityId = facilityId;
    this.capacity = capacity;
    this.tariff = tariff;
    this.secretKey = secretKey;
  }

  get currentOccupancy(): number {
    return this.activeSessions.size;
  }

  get occupancyRate(): number {
    return Math.round((this.activeSessions.size / this.capacity) * 100) / 100;
  }

  ingestEvent(event: ANPREvent): { session: ParkingSession; signedPayload: string } {
    const cleanPlate = normalizeLicensePlate(event.licensePlate);
    let session: ParkingSession;

    if (event.type === "ENTRY") {
      session = {
        sessionId: `sess-${event.facilityId}-${cleanPlate}-${Date.parse(event.timestamp)}`,
        facilityId: event.facilityId,
        licensePlate: cleanPlate,
        entryTime: event.timestamp,
        status: "ACTIVE",
      };
      this.activeSessions.set(cleanPlate, session);
    } else {
      const active = this.activeSessions.get(cleanPlate);
      const entryDate = active ? new Date(active.entryTime) : new Date(event.timestamp);
      const exitDate = new Date(event.timestamp);
      const { durationMinutes, feeCents } = calculateParkingFee(entryDate, exitDate, this.tariff);

      session = {
        sessionId: active ? active.sessionId : `exit-${cleanPlate}-${Date.parse(event.timestamp)}`,
        facilityId: event.facilityId,
        licensePlate: cleanPlate,
        entryTime: active ? active.entryTime : event.timestamp,
        exitTime: event.timestamp,
        durationMinutes,
        feeCents,
        status: active ? "COMPLETED" : "VIOLATION",
      };

      this.activeSessions.delete(cleanPlate);
      this.completedSessions.push(session);
    }

    const payload = JSON.stringify(session);
    const signature = createHmac("sha256", this.secretKey).update(payload).digest("hex");
    const signedPayload = JSON.stringify({ payload: session, signature });

    return { session, signedPayload };
  }
}
