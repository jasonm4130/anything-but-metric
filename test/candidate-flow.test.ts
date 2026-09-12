import { describe, expect, it } from "vitest";
import { chooseCandidate, validateCandidates } from "../src/lib/candidate-flow";

const base = { referenceQuantity: 10, referenceUnit: "J", referenceLabel: "test objects", assumption: "A bounded test action." };

describe("candidate flow", () => {
  it("keeps valid natural-unit candidates when a sibling is invalid", () => {
    const candidates = validateCandidates({ candidates: [
      { ...base, family: "objects" },
      { ...base, family: "wrong dimension", referenceUnit: "m" },
      { ...base, family: "vehicles", referenceQuantity: 1 }
    ] }, { quantity: 100, sourceUnit: "J" });
    expect(candidates.map(candidate => candidate.family)).toEqual(["objects", "vehicles"]);
    expect(chooseCandidate(candidates, () => 0.9)?.family).toBe("vehicles");
  });

  it("prefers readable ratios, deduplicates normalized families, and permits zero and temperature", () => {
    const candidates = validateCandidates({ candidates: [
      { ...base, family: "  Objects ", referenceQuantity: 1_000_000 },
      { ...base, family: "objects", referenceQuantity: 1 },
      { ...base, family: "vehicles", referenceQuantity: 10 }
    ] }, { quantity: 100, sourceUnit: "J" });
    expect(chooseCandidate(candidates, () => 0)?.family).toBe("objects");
    expect(chooseCandidate(candidates, () => 0.99)?.family).toBe("vehicles");
    const zero = validateCandidates({ candidates: [
      { ...base, family: "zero", referenceQuantity: 1_000_000 },
      { ...base, family: "two", referenceQuantity: 1_000_000 },
      { ...base, family: "three", referenceQuantity: 1_000_000 }
    ] }, { quantity: 0, sourceUnit: "J" });
    expect(chooseCandidate(zero, () => 0.5)).toBeDefined();
  });

  it("rejects a set with no valid candidates", () => {
    expect(() => validateCandidates({ candidates: [
      { ...base, family: "bad", referenceUnit: "m" },
      { ...base, family: "also bad", referenceQuantity: 0 },
      { ...base, family: "third bad", assumption: "" }
    ] }, { quantity: 100, sourceUnit: "J" })).toThrow();
  });

  it("does not trust candidate source fields", () => {
    const spoofed = { ...base, family: "test", quantity: 999, sourceUnit: "kg" };
    const candidates = validateCandidates({ candidates: [spoofed, { ...spoofed, family: "two" }, { ...spoofed, family: "three" }] }, { quantity: 144, sourceUnit: "J" });
    expect(candidates[0].result).toMatchObject({ quantity: 144, sourceUnit: "J", dimension: "energy" });
  });
});
