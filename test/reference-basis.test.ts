import { describe, expect, it } from "vitest";
import { InvalidReferenceBasisError, referenceBasisSchema, referenceFromBasis } from "../src/lib/reference-basis";

const input = (basis: object, overrides = {}) => ({ referenceLabel: "very serious test thing", basis, context: "a careful physical setup", quip: "science remains unconvinced", ...overrides });

describe("referenceFromBasis", () => {
  it("calculates bounded physical bases in canonical SI units", () => {
    expect(referenceFromBasis(input({ kind: "cuboid_volume", length: "50 m", width: "25 m", depth: "2 m" })).referenceQuantity).toBe(2500);
    expect(referenceFromBasis(input({ kind: "work_over_distance", energy: "1e15 J", distance: "100 m" }))).toMatchObject({ referenceQuantity: 1e13, referenceUnit: "N" });
    expect(referenceFromBasis(input({ kind: "lifting_energy", mass: "30 kg", height: ".3 m" })).referenceQuantity).toBeCloseTo(30 * .3 * 9.80665);
    expect(referenceFromBasis(input({ kind: "power_duration", power: "2 kW", duration: "30 min" }))).toMatchObject({ referenceQuantity: 3_600_000, referenceUnit: "J" });
  });

  it("parses complete atomic literals and normalizes aliases", () => {
    expect(referenceFromBasis(input({ kind: "work_over_distance", energy: "1 GJ", distance: "1 kilometre" })).referenceQuantity).toBe(1_000_000);
    expect(referenceFromBasis(input({ kind: "work_over_distance", energy: "1e15J", distance: "100m" }))).toMatchObject({ referenceQuantity: 1e13, referenceUnit: "N" });
    expect(referenceFromBasis(input({ kind: "cuboid_volume", length: "1 metres", width: "100 centimetres", depth: "1000 millimetres" })).referenceQuantity).toBe(1);
    expect(referenceFromBasis(input({ kind: "direct", measure: "1m^2" }))).toMatchObject({ referenceQuantity: 1, referenceUnit: "m^2" });
    expect(referenceFromBasis(input({ kind: "direct", measure: "2 1/s" }))).toMatchObject({ referenceQuantity: 2, referenceUnit: "s^-1" });
  });

  it("normalizes direct measures while retaining valid negative temperatures", () => {
    expect(referenceFromBasis(input({ kind: "direct", measure: "25 °C" }))).toMatchObject({ referenceQuantity: 25, referenceUnit: "degC" });
    expect(referenceFromBasis(input({ kind: "direct", measure: "-18 Celsius" }))).toMatchObject({ referenceQuantity: -18, referenceUnit: "degC" });
    expect(() => referenceFromBasis(input({ kind: "direct", measure: "-274 degC" }))).toThrow(InvalidReferenceBasisError);
    expect(() => referenceFromBasis(input({ kind: "direct", measure: "0 J" }))).toThrow(InvalidReferenceBasisError);
    expect(() => referenceFromBasis(input({ kind: "direct", measure: "-1 J" }))).toThrow(InvalidReferenceBasisError);
    expect(() => referenceFromBasis(input({ kind: "direct", measure: "1e-999 degC" }))).toThrow(InvalidReferenceBasisError);
  });

  it("keeps numeric explanations bounded for extreme but finite references", () => {
    const result = referenceFromBasis(input({ kind: "direct", measure: "1e308 J" }));
    expect(result.assumption.length).toBeLessThanOrEqual(300);
    expect(result.assumption).toContain("1e+308 J");
  });

  it("rejects dimension errors, non-positive derived operands, and numeric range failures", () => {
    for (const basis of [
      { kind: "lifting_energy", mass: "2 m", height: "1 m" },
      { kind: "cuboid_volume", length: "0 m", width: "1 m", depth: "1 m" },
      { kind: "power_duration", power: "-1 W", duration: "1 s" },
      { kind: "work_over_distance", energy: "1e308 J", distance: "1e-308 m" },
      { kind: "cuboid_volume", length: "1e-300 m", width: "1e-300 m", depth: "1e-300 m" }
    ]) expect(() => referenceFromBasis(input(basis))).toThrow(InvalidReferenceBasisError);
  });

  it("rejects contradictory or unbounded model prose and invalid structures", () => {
    expect(() => referenceFromBasis(input({ kind: "direct", measure: "1 J" }, { context: "a setup with 2 things" }))).toThrow(InvalidReferenceBasisError);
    expect(() => referenceFromBasis(input({ kind: "direct", measure: "1 J" }, { referenceLabel: "x".repeat(161) }))).toThrow(InvalidReferenceBasisError);
    expect(() => referenceFromBasis(input({ kind: "direct", measure: "1 J" }, { quip: " " }))).toThrow(InvalidReferenceBasisError);
    expect(() => referenceFromBasis(input({ kind: "direct", measure: "1 J" }, { basis: { kind: "power_duration", power: "1 W", duration: "1 s", formula: "anything" } }))).toThrow(InvalidReferenceBasisError);
    expect(() => referenceFromBasis(input({ kind: "direct", measure: "1 2 m" }))).toThrow(InvalidReferenceBasisError);
    expect(() => referenceFromBasis(input({ kind: "power_duration", power: "2 5 W", duration: "1 s" }))).toThrow(InvalidReferenceBasisError);
  });

  it("publishes a strict schema with all model fields required", () => {
    expect(referenceBasisSchema).toMatchObject({ type: "object", additionalProperties: false, required: ["referenceLabel", "basis", "context", "quip"] });
    expect(referenceFromBasis(input({ kind: "cuboid_volume", first: "50 m", second: "25 m", third: "2 m" }))).toMatchObject({ referenceQuantity: 2500, referenceUnit: "m^3" });
    expect(referenceFromBasis(input({ kind: "direct", first: "1 GJ", second: "", third: "" }))).toMatchObject({ referenceQuantity: 1, referenceUnit: "GJ" });
    expect(() => referenceFromBasis(input({ kind: "direct", first: "1 J", second: "2 s", third: "" }))).toThrow();
    expect(() => referenceFromBasis(input({ kind: "power_duration", first: "2 W", second: "1 s", third: "3 m" }))).toThrow();
  });
});
