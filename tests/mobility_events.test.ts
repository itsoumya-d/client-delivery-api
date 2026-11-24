import { describe, expect, it } from "vitest";
import {
  calculateParkingFee,
  MobilityFacilityEngine,
  normalizeLicensePlate,
  type TariffRule,
} from "../src/mobility_events.js";

describe("Mobility IoT & Occupancy Engine", () => {
  const tariff: TariffRule = {
    gracePeriodMinutes: 15,
    hourlyRateCents: 250, // 2.50 EUR
    dailyCapCents: 2000,  // 20.00 EUR
  };

  it("normalizes license plate formatting", () => {
    expect(normalizeLicensePlate("M-PP 1234E")).toBe("MPP1234E");
    expect(normalizeLicensePlate(" b-xy 999 ")).toBe("BXY999");
  });

  it("applies grace period for short parking stays", () => {
    const entry = new Date("2026-11-24T10:00:00Z");
    const exit = new Date("2026-11-24T10:14:00Z");
    const res = calculateParkingFee(entry, exit, tariff);

    expect(res.durationMinutes).toBe(14);
    expect(res.feeCents).toBe(0);
    expect(res.gracePeriodApplied).toBe(true);
  });

  it("calculates billable fee and caps at maximum daily rate", () => {
    const entry = new Date("2026-11-24T08:00:00Z");
    const exit2Hours = new Date("2026-11-24T10:00:00Z");
    const res2 = calculateParkingFee(entry, exit2Hours, tariff);
    // 120 min - 15 min grace = 105 min -> 2 hours billable * 250 = 500 cents
    expect(res2.feeCents).toBe(500);

    const exitFullDay = new Date("2026-11-24T22:00:00Z");
    const resDay = calculateParkingFee(entry, exitFullDay, tariff);
    expect(resDay.feeCents).toBe(2000); // capped at daily maximum
  });

  it("tracks facility occupancy and emits HMAC-signed session events", () => {
    const facility = new MobilityFacilityEngine("fac-munich-1", 100, tariff, "test-secret");
    expect(facility.currentOccupancy).toBe(0);

    const entryEvent = facility.ingestEvent({
      eventId: "evt-01",
      facilityId: "fac-munich-1",
      licensePlate: "M-PP 8888",
      timestamp: "2026-11-24T09:00:00Z",
      type: "ENTRY",
      confidence: 0.99,
    });

    expect(facility.currentOccupancy).toBe(1);
    expect(facility.occupancyRate).toBe(0.01);
    expect(entryEvent.session.status).toBe("ACTIVE");
    expect(JSON.parse(entryEvent.signedPayload).signature).toHaveLength(64);

    const exitEvent = facility.ingestEvent({
      eventId: "evt-02",
      facilityId: "fac-munich-1",
      licensePlate: "m-pp-8888",
      timestamp: "2026-11-24T11:00:00Z",
      type: "EXIT",
      confidence: 0.98,
    });

    expect(facility.currentOccupancy).toBe(0);
    expect(exitEvent.session.status).toBe("COMPLETED");
    expect(exitEvent.session.durationMinutes).toBe(120);
    expect(exitEvent.session.feeCents).toBe(500);
  });
});
