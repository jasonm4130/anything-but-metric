import { describe, expect, it, vi } from "vitest";
import { unit } from "mathjs";
import { interpretMeasurement, normalizeMeasurementUnit } from "../src/lib/measurement";
import { conversionFromChoice, validateMeasurement } from "../src/lib/convert";

describe("code-owned additive measurements", () => {
  it("repairs the observed feet/inches dimension failure without invoking the saved parser response", async () => {
    // Post-holdout development regression: the parser incorrectly multiplied the units.
    const parser = vi.fn().mockResolvedValue({ recognized: true, quantity: 1.785, sourceUnit: "ft in" });
    const result = await interpretMeasurement("4 ft 7 in", parser);
    expect(result.recognized).toBe(true);
    expect(validateMeasurement(result.quantity, result.sourceUnit).dimension).toBe("length");
    expect(unit(result.quantity, result.sourceUnit).toNumber("in")).toBeCloseTo(55, 10);
    expect(parser).not.toHaveBeenCalled();
  });

  it("displays a readable mixed measurement while retaining its full numeric value", async () => {
    const parsed = await interpretMeasurement("4 ft 7 in", vi.fn());
    const result = conversionFromChoice({ ...parsed, referenceQuantity: 1, referenceUnit: "in", referenceLabel: "inch-long paper strips", assumption: "One explicitly defined inch per strip." });
    expect(result.quantity).toBe(parsed.quantity);
    expect(result.interpretation).toMatch(/^(?:≈ )?55 in$/);
  });

  it.each([
    ["5ft6in", 66, "in"], ["7 inches 4 feet", 55, "in"], ["1 yd 2 ft 3 in", 63, "in"],
    ["1h30min", 90, "min"], ["1 hour 30 minutes 15 seconds", 5415, "s"],
    ["2kg250g", 2250, "g"], [".5kg2.5g", 502.5, "g"], ["1e3g 2kg", 3000, "g"],
    ["1,000 g 2 kg", 3000, "g"], ["1 MB 8 Mb", 16, "Mb"], ["0 ft 7 in", 7, "in"],
    ["0kg0g", 0, "g"], ["1e-3kg 2g", 3, "g"], ["4 ft 7 in.", 55, "in"]
  ])("preserves every component of %s", async (input, expected, target) => {
    const parser = vi.fn();
    const result = await interpretMeasurement(input as string, parser);
    expect(result.recognized).toBe(true);
    expect(unit(result.quantity, result.sourceUnit).toNumber(target as string)).toBeCloseTo(expected as number, 10);
    expect(parser).not.toHaveBeenCalled();
  });

  it.each([
    "4ft7kg", "20degC10K", "20°C5°F", "20 degrees Celsius 5 kelvin", "1 K 2 K",
    "-4ft7in", "+4ft7in", "4ft-7in", "4ft+7in", "4 ft - 7 in", "4 ft + 7 in",
    "1e-999 m 2 cm", "1e999 m 2 cm", "1e30kg1g", "4ft7in2", "4ft7unknown"
  ])("rejects an ambiguous or unrepresentable sum %s without AI", async input => {
    const parser = vi.fn();
    expect((await interpretMeasurement(input, parser)).recognized).toBe(false);
    expect(parser).not.toHaveBeenCalled();
  });

  it("keeps unresolved prose on its existing interpretation path", async () => {
    for (const input of ["the fence is four feet high", "4 ft 7 in tall", "half the volume of my 2 litre bottle"]) {
      const parser = vi.fn().mockResolvedValue({ recognized: true, quantity: 0.5, sourceUnit: "L" });
      expect(await interpretMeasurement(input, parser)).toEqual({ recognized: true, quantity: 0.5, sourceUnit: "L" });
      expect(parser).toHaveBeenCalledExactlyOnceWith(input);
    }
  });

  it.each(["7ft4in!", "7ft4in!!", "7ft4in?!", "7ft4in..."])("keeps terminal punctuation on the code path: %s", async input => {
    const parser = vi.fn().mockResolvedValue({ recognized: true, quantity: 1, sourceUnit: "ft in" });
    const result = await interpretMeasurement(input, parser);
    expect(validateMeasurement(result.quantity, result.sourceUnit).dimension).toBe("length");
    expect(unit(result.quantity, result.sourceUnit).toNumber("in")).toBeCloseTo(88, 10);
    expect(parser).not.toHaveBeenCalled();
  });

  it.each(["2 m/s", "2 m^2", "2 1/s", "-20 °C"])("preserves single or compound literal %s", async input => {
    const parser = vi.fn();
    expect((await interpretMeasurement(input, parser)).recognized).toBe(true);
    expect(parser).not.toHaveBeenCalled();
  });
});

describe("bounded unit spelling normalization", () => {
  it("normalizes the observed parser spelling without changing its extracted quantity", async () => {
    const parser = vi.fn().mockResolvedValue({ quantity: 27.4, recognized: true, sourceUnit: "killograms" });
    expect(await interpretMeasurement("The crate weighs 27.4 killograms.", parser)).toEqual({ recognized: true, quantity: 27.4, sourceUnit: "kg" });
    expect(parser).toHaveBeenCalledTimes(1);
    parser.mockClear();
    expect(await interpretMeasurement("27.4 killograms", parser)).toEqual({ recognized: true, quantity: 27.4, sourceUnit: "kg" });
    expect(parser).not.toHaveBeenCalled();
  });

  it("preserves supported unit case and refuses ambiguous calorie/byte/bit corrections", () => {
    for (const symbol of ["mg", "Mg", "MB", "Mb"]) expect(normalizeMeasurementUnit(symbol)).toBe(symbol);
    expect(normalizeMeasurementUnit("Calorie")).toBe("kcal");
    expect(normalizeMeasurementUnit("calorie")).toBe("cal");
    expect(normalizeMeasurementUnit("calroie")).toBe("calroie");
    expect(normalizeMeasurementUnit("megabites")).toBe("megabites");
  });
});
