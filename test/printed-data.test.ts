import { describe, expect, it } from "vitest";
import { printedDataComparison } from "../src/lib/printed-data";

describe("experimental printed data representation", () => {
  it("represents a petabyte without treating arbitrary binary data as ASCII text", () => {
    const result = printedDataComparison(1, "PB")!;
    expect(result.operands.bytes).toBe(1e15);
    expect(result.operands.sheets).toBe(500000000000);
    expect(result.computed.nominalStackMetres).toBe(53000000);
    expect(result.computed.earthDiameters).toBeCloseTo(4.1549074945, 9);
    expect(result.computed.earthDiametersAtPaperSpecificationLimits[0]).toBeGreaterThan(4);
    expect(result.computed.earthDiametersAtPaperSpecificationLimits[1]).toBeLessThan(4.3);
  });
  it("preserves decimal, binary and bit distinctions", () => {
    expect(printedDataComparison(1, "PiB")!.operands.bytes).toBe(2 ** 50);
    expect(printedDataComparison(8, "Pb")!.operands.bytes).toBe(1e15);
    expect(printedDataComparison(1, "Pb")!.operands.bytes).toBe(1e15 / 8);
  });
  it("rounds physical sheets up, including a partially filled reverse side", () => {
    for (const [bytes, sheets] of [[1, 1], [1001, 1], [2000, 1], [2001, 2], [4000, 2]]) {
      const result = printedDataComparison(bytes, "B")!;
      expect(result.operands.sheets).toBe(sheets);
      expect(result.computed.unusedByteCapacity).toBe(sheets * 2000 - bytes);
    }
  });
  it("declines fractional bytes and unsafe magnitudes without silently padding the input", () => {
    for (const [quantity, sourceUnit] of [[1, "b"], [0.5, "B"], [0, "B"], [1, "EB"], [144, "J"]] as const) {
      expect(printedDataComparison(quantity, sourceUnit)).toBeUndefined();
    }
    expect(printedDataComparison(Number.MAX_SAFE_INTEGER, "B")).toBeUndefined();
  });
  it("keeps the physical assumptions fixed when an Earth-sized comparison is unreadable", () => {
    const small = printedDataComparison(1, "MB")!;
    expect(small.headline).toBeUndefined();
    expect(small.operands.hexCharactersPerPage).toBe(2000);
    expect(small.operands.thicknessMetres).toBe(106e-6);
  });
});
