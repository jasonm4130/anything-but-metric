import { describe, expect, it, vi } from "vitest";
import { unit } from "mathjs";
import { interpretMeasurement } from "../src/lib/measurement";

describe("complete fractional measurements", () => {
  it.each([
    ["55 mph", 55, "mi/h"], ["20 kph", 20, "km/h"], ["1/2 litre", 0.5, "L"], ["3/4kg", 750, "g"], ["1 1/2 kg", 1500, "g"],
    ["1/2 m/s", 0.5, "m/s"], ["1/2 1/s", 0.5, "Hz"], ["0/2 L", 0, "L"],
    ["1e3/2 joules", 500, "J"], ["1/2 MB", 500000, "byte"], ["1/2 Mb", 62500, "byte"],
    ["1/2 L 250 mL", 750, "mL"], ["1 1/2 kg 250g", 1750, "g"], ["1/2 L 1/4 L", 750, "mL"],
    ["half a litre", 0.5, "L"], ["a quarter of a kilogram", 250, "g"], ["three quarters of a litre", 750, "mL"],
    ["one and a half litres", 1.5, "L"], ["-1 1/2 °C", -1.5, "degC"],
    ["half a square metre", 0.5, "m^2"], ["half 1/s", 0.5, "Hz"], ["half mmH2O", 0.5, "mmH2O"],
    ["1/2 mmH2O", 0.5, "mmH2O"], ["12 mmH2O", 12, "mmH2O"]
  ])("computes %s without a parser model", async (input, expected, target) => {
    const parser = vi.fn().mockResolvedValue({recognized:false,quantity:0,sourceUnit:"m"});
    const result = await interpretMeasurement(input as string, parser);
    expect(result.recognized).toBe(true);
    expect(unit(result.quantity,result.sourceUnit).toNumber(target as string)).toBeCloseTo(expected as number,9);
    expect(parser).not.toHaveBeenCalled();
  });

  it.each(["1/0 L", "1e-999/2 L", "1/1e999 L", "1e999/2 L", "1 2/0 L", "1e30 1/2 L", "1/2 L 3 kg", "1/2 L -1/4 L", "1/2/3 L", "1/2 L1/4", "1/2", "1 1/2"])("rejects invalid or lossy arithmetic %s without a model", async input => {
    const parser = vi.fn().mockResolvedValue({recognized:true,quantity:1,sourceUnit:"L"});
    expect((await interpretMeasurement(input,parser)).recognized).toBe(false);
    expect(parser).not.toHaveBeenCalled();
  });

  it("lets the unit resolver resolve a fractional unit without replacing the computed quantity", async () => {
    for (const [quantity,recognized] of [[0.5,true],[1,false]] as const) {
      const parser = vi.fn().mockResolvedValue({recognized:true,quantity,sourceUnit:"L"});
      expect((await interpretMeasurement("1/2 litreish",parser)).recognized).toBe(recognized);
      expect(parser).toHaveBeenCalledExactlyOnceWith("1/2 litreish");
    }
  });

  it.each(["half 2 litres", "half a 2 L", "half of 100 kg", "half a 2 L bottle"])("preserves the full numeric-tail phrase for interpretation: %s", async input => {
    const parser = vi.fn().mockResolvedValue({recognized:true,quantity:1,sourceUnit:"L"});
    expect(await interpretMeasurement(input,parser)).toEqual({recognized:true,quantity:1,sourceUnit:"L"});
    expect(parser).toHaveBeenCalledExactlyOnceWith(input);
  });
});
