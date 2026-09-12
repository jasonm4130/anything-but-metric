import { describe, expect, it } from "vitest";
import { groundedInput, groundedResult, groundedSchema, offeredReferences, selectGroundedReference, validateGroundedCatalog } from "../src/lib/grounded-flow";

const catalog = [
  { id: "near", referenceQuantity: 100, referenceUnit: "J", referenceLabel: "test actions", assumption: "A bounded test action." },
  { id: "far", referenceQuantity: 1, referenceUnit: "J", referenceLabel: "tiny actions", assumption: "A bounded tiny action." },
  { id: "wrong", referenceQuantity: 1, referenceUnit: "m", referenceLabel: "lengths", assumption: "A test length." }
];

describe("grounded flow", () => {
  it("offers only compatible catalog references in deterministic readable order", () => {
    const offered = offeredReferences(catalog, { quantity: 100, sourceUnit: "J" });
    expect(offered.map(reference => reference.id)).toEqual(["near", "far"]);
    expect(groundedInput(offered)).not.toContain("100");
    expect(groundedSchema(offered)).toMatchObject({ properties: { referenceId: { enum: ["near", "far"] }, quip: { minLength: 1, maxLength: 160 } }, required: ["referenceId", "quip"] });
    const readable = offeredReferences([...catalog, { id: "unreadable", referenceQuantity: 1e12, referenceUnit: "J", referenceLabel: "huge actions", assumption: "A bounded huge action." }], { quantity: 100, sourceUnit: "J" });
    expect(readable.map(reference => reference.id)).not.toContain("unreadable");
  });

  it("fills only immutable catalog references and falls back deterministically", () => {
    const offered = offeredReferences(catalog, { quantity: 100, sourceUnit: "J" });
    expect(selectGroundedReference({ referenceId: "far", quip: "A dry test joke.", referenceQuantity: 999, referenceUnit: "kg", referenceLabel: "model text" }, offered)).toMatchObject({ reference: { id: "far", referenceQuantity: 1, referenceUnit: "J", referenceLabel: "tiny actions" }, quip: "A dry test joke.", fallback: false });
    expect(selectGroundedReference({ referenceId: "unknown" }, offered)).toMatchObject({ reference: { id: "near" }, fallback: true });
    expect(selectGroundedReference(undefined, offered)).toMatchObject({ reference: { id: "near" }, fallback: true });
    expect(selectGroundedReference({ referenceId: "far", quip: "x".repeat(161) }, offered)).toMatchObject({ reference: { id: "near" }, fallback: true });
    expect(selectGroundedReference({ referenceId: "far" }, offered)).toMatchObject({ reference: { id: "near" }, fallback: true });
    expect(selectGroundedReference({ referenceId: "far", quip: "   " }, offered)).toMatchObject({ reference: { id: "near" }, fallback: true });
  });

  it("rejects malformed or duplicate catalog rows before evaluation", () => {
    expect(validateGroundedCatalog(catalog)).toHaveLength(3);
    expect(() => validateGroundedCatalog([{ ...catalog[0] }, { ...catalog[0] }])).toThrow("invalid_grounded_catalog");
    expect(() => validateGroundedCatalog([{ id: "bad", referenceQuantity: 1, referenceUnit: "not-a-unit", referenceLabel: "bad", assumption: "bad" }])).toThrow("invalid_grounded_catalog");
  });

  it("does not invent a fallback when no catalog reference matches the dimension", () => {
    expect(offeredReferences(catalog, { quantity: 2, sourceUnit: "kg" })).toEqual([]);
    expect(() => selectGroundedReference(undefined, [])).toThrow("unsupported_dimension");
  });

  it("renders intensive dimensions as a ratio without changing source values or quips", () => {
    const pressure = offeredReferences([{ id: "espresso", referenceQuantity: 9, referenceUnit: "bar", referenceLabel: "the pressure of a nine-bar espresso extraction", assumption: "A fixed extraction pressure." }], { quantity: 1e9, sourceUnit: "Pa" })[0];
    const selected = { reference: pressure, quip: "The espresso machine has entered its final form." };
    const result = groundedResult(selected);
    expect(result).toMatchObject({ quantity: 1e9, sourceUnit: "Pa", value: expect.any(Number), headline: `About ${pressure.result.displayValue} times the pressure of a nine-bar espresso extraction`, quip: selected.quip });
    const energy = offeredReferences(catalog, { quantity: 100, sourceUnit: "J" })[0];
    expect(groundedResult({ reference: energy, quip: "Still bounded." }).headline).toBe(energy.result.headline);
  });
});
