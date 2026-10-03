import { describe, expect, it } from "vitest";
import { checkProposal, creativeProposalInput, estimateError, lineGateReasons, magnitudeWindow, proposalUnit, scoreCreativeResponse } from "../src/lib/creative-proposals";

const bus = { label: "double-decker buses", singular: "double-decker bus", value: 12, unit: "tonne", basis: "A London bus weighs about 12 t empty.", family: "vehicles", line: "That's {N} double-decker buses parked nose to tail." };

describe("creative proposals", () => {
  it("gives the model an order-of-magnitude window, never the exact quantity", () => {
    const window = magnitudeWindow(5, "km");
    expect(window).toMatchObject({ dimension: "length", displayUnit: "km", measurementLow: 1, measurementHigh: 10, referenceLow: 0.01, referenceHigh: 10 });
    const input = creativeProposalInput(window!, "sport");
    expect(input).toContain("between 1 and 10 km");
    expect(input).not.toMatch(/\b5\b/);
    expect(input).not.toContain("context");
    expect(creativeProposalInput(window!, "sport", "5 km of pure misery")).toContain("pure misery");
    expect(magnitudeWindow(37, "degC")).toBeUndefined();
    expect(magnitudeWindow(0, "kg")).toBeUndefined();
  });

  it("checks units and dimensions, computes the count in code and fills the line", () => {
    const check = checkProposal(bus, 0, { quantity: 40, sourceUnit: "tonne" });
    expect(check).toMatchObject({ ok: true, displayCount: "3.33", family: "vehicles" });
    expect(check.text).toBe("That's 3.33 double-decker buses parked nose to tail.");
    expect(checkProposal({ ...bus, unit: "µg", value: 5e12 }, 0, { quantity: 40, sourceUnit: "tonne" }).ok).toBe(true);
    expect(proposalUnit("microns")).toBe("um");
    expect(checkProposal({ ...bus, unit: "m" }, 0, { quantity: 40, sourceUnit: "tonne" }).reasons).toContain("dimension_mismatch");
    expect(checkProposal({ ...bus, value: 1e-6 }, 0, { quantity: 40, sourceUnit: "tonne" }).reasons).toContain("ratio_out_of_range");
    expect(checkProposal({ ...bus, value: 0 }, 0, { quantity: 40, sourceUnit: "tonne" }).reasons).toContain("invalid_value");
    expect(checkProposal({ ...bus, unit: "furlongs of joy" }, 0, { quantity: 40, sourceUnit: "tonne" }).reasons).toContain("unit_unparsed");
    expect(checkProposal({ ...bus, basis: "I'm sorry, I can't help with that." }, 0, { quantity: 40, sourceUnit: "tonne" }).reasons).toContain("refusal_text");
  });

  it("gates lines to exactly one placeholder, the reference, and no other numbers", () => {
    expect(lineGateReasons(bus.line, bus.label, bus.singular)).toEqual([]);
    expect(lineGateReasons("Roughly {N} Boeing 747s on the runway.", "Boeing 747s", "Boeing 747")).toEqual([]);
    expect(lineGateReasons("{N} buses, or 3 if you squint.", "buses", "bus")).toContain("line_extra_number");
    expect(lineGateReasons("{N} giraffes, two of them grumpy.", "giraffes", "giraffe")).toContain("line_extra_number");
    expect(lineGateReasons("{N} cats and ٣ dogs.", "cats", "cat")).toContain("line_extra_number");
    expect(lineGateReasons("{N} buses and {N} cars.", "buses", "bus")).toContain("line_placeholder_count");
    expect(lineGateReasons("<b>{N}</b> buses.", "buses", "bus")).toContain("line_markup");
    expect(lineGateReasons("That's {N} of them.", "buses", "bus")).toContain("line_missing_label");
  });

  it("classifies provider responses, including refusals and reasoning-only answers", () => {
    const measurement = { quantity: 40, sourceUnit: "tonne" };
    const proposals = { proposals: [bus, { ...bus, unit: "m" }, { ...bus, value: 6 }] };
    expect(scoreCreativeResponse({ response: proposals }, measurement).outcome).toBe("ok");
    expect(scoreCreativeResponse({ choices: [{ message: { content: "```json\n" + JSON.stringify(proposals) + "\n```" } }] }, measurement).checks.filter(check => check.ok)).toHaveLength(2);
    expect(scoreCreativeResponse({ response: null, choices: [{ message: { content: null, reasoning_content: JSON.stringify(proposals) } }] }, measurement).outcome).toBe("ok");
    expect(scoreCreativeResponse({ choices: [{ message: { content: null, refusal: "I can't help with that request." } }] }, measurement).outcome).toBe("refusal");
    expect(scoreCreativeResponse({ response: "I'm sorry, but I cannot create content about drugs." }, measurement).outcome).toBe("refusal");
    expect(scoreCreativeResponse({ response: "lol" }, measurement).outcome).toBe("unparseable");
    expect(scoreCreativeResponse({ response: { proposals: [] } }, measurement).outcome).toBe("schema_error");
    expect(scoreCreativeResponse({ response: { proposals: [{ ...bus, unit: "m" }] } }, measurement).outcome).toBe("no_valid_proposal");
  });

  it("scores estimates as absolute base-10 log error against the sourced value", () => {
    expect(estimateError({ value: 1000, unit: "kg" }, { quantity: 1, unit: "tonne" }).error).toBeCloseTo(0, 12);
    expect(estimateError({ value: 10, unit: "tonne" }, { quantity: 1, unit: "tonne" }).error).toBeCloseTo(1, 12);
    expect(estimateError({ value: 10, unit: "m" }, { quantity: 1, unit: "tonne" }).reason).toBe("dimension_mismatch");
    expect(estimateError({ value: -1, unit: "kg" }, { quantity: 1, unit: "tonne" }).reason).toBe("invalid_value");
  });
});
