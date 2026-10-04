import { describe, expect, it } from "vitest";
import { ambiguousReadings, count, describeMeasure, localCurrency, physical, referenceRatio } from "../src/lib/measures";
import { amountMatches, readMeasure, writtenNumbers } from "../src/lib/reader";
import { serialiseRecord, writeReplay } from "../src/lib/replay-log";
import type { ReplayRecord } from "../src/lib/model-flow";

const ratio = (check: ReturnType<typeof referenceRatio>) => "count" in check ? check.count : check.reason;

describe("measures", () => {
  it("reads money written with symbols, codes, words and scale suffixes", () => {
    expect(localCurrency("$50")).toMatchObject({ kind: "currency", quantity: 50, unit: "USD", dimension: "money" });
    expect(localCurrency("£20")).toMatchObject({ quantity: 20, unit: "GBP" });
    expect(localCurrency("€3.5m")).toMatchObject({ quantity: 3.5e6, unit: "EUR" });
    expect(localCurrency("A$1,200")).toMatchObject({ quantity: 1200, unit: "AUD" });
    expect(localCurrency("$5k")).toMatchObject({ quantity: 5000, unit: "USD" });
    expect(localCurrency("50 USD")).toMatchObject({ quantity: 50, unit: "USD" });
    expect(localCurrency("JPY 900")).toMatchObject({ quantity: 900, unit: "JPY" });
    expect(localCurrency("100 bucks")).toMatchObject({ quantity: 100, unit: "USD" });
    expect(localCurrency("2 billion euros")).toMatchObject({ quantity: 2e9, unit: "EUR" });
    expect(localCurrency("30 cents")!.quantity).toBeCloseTo(0.3, 12);
    for (const input of ["5 m", "2 PB", "144 jouls", "10 pounds", "5 mph", "$", "$-5", "50 ABC"]) expect(localCurrency(input)).toBeUndefined();
  });

  it("offers every defensible reading of an ambiguous unit, default first", () => {
    expect(ambiguousReadings("20 pounds")?.map(reading => [reading.measure.kind, reading.measure.unit])).toEqual([["physical", "lb"], ["currency", "GBP"]]);
    expect(ambiguousReadings("3 oz")?.map(reading => reading.measure.dimension)).toEqual(["mass", "volume"]);
    expect(ambiguousReadings("1 ton")).toHaveLength(3);
    expect(ambiguousReadings("2 gallons")?.[1].measure).toMatchObject({ quantity: 2 * 4.54609, unit: "L" });
    for (const input of ["2 kg", "1/2 cup", "pounds", "20 pounds of feathers"]) expect(ambiguousReadings(input)).toBeUndefined();
  });

  it("names dimensions beyond the catalogue and keeps counts safe to display", () => {
    expect(physical(12, "V")).toMatchObject({ dimension: "voltage" });
    expect(physical(3, "mol")).toMatchObject({ dimension: "amount of substance" });
    expect(physical(2, "1/s")).toMatchObject({ dimension: "frequency", unit: "s^-1" });
    expect(physical(-1, "kg")).toBeUndefined();
    expect(count(3, "slice of pizza", "slices of pizza")).toMatchObject({ kind: "count", dimension: "count", item: "slice of pizza", items: "slices of pizza" });
    expect(count(3, "<b>slice</b>")).toBeUndefined();
    expect(count(1e19, "grain")).toBeUndefined();
    expect(describeMeasure(count(1, "egg", "eggs")!)).toBe("1 egg");
    expect(describeMeasure(count(12, "egg", "eggs")!)).toBe("12 eggs");
    expect(describeMeasure({ ...physical(8849, "m")!, estimate: { subject: "Everest", perUnit: 8849, perUnitUnit: "m", written: "Everest" } })).toBe("≈ 8,850 m");
  });

  it("divides only like with like", () => {
    expect(ratio(referenceRatio(physical(40, "tonne")!, 12, "tonne"))).toBeCloseTo(3.333, 3);
    expect(ratio(referenceRatio(physical(40, "tonne")!, 12, "m"))).toBe("dimension_mismatch");
    expect(ratio(referenceRatio(physical(37, "degC")!, 1, "degC"))).toBe("dimension_mismatch");
    expect(ratio(referenceRatio(localCurrency("$50")!, 5, "USD"))).toBe(10);
    expect(ratio(referenceRatio(localCurrency("$50")!, 5, "$"))).toBe(10);
    expect(ratio(referenceRatio(localCurrency("$50")!, 5, "EUR"))).toBe("dimension_mismatch");
    const slices = count(3, "slice of pizza", "slices of pizza")!;
    expect(ratio(referenceRatio(slices, 8, "count"))).toBe(0.375);
    expect(ratio(referenceRatio(slices, 8, "slices"))).toBe(0.375);
    expect(ratio(referenceRatio(slices, 8, "kg"))).toBe("dimension_mismatch");
    expect(ratio(referenceRatio(slices, 0, "count"))).toBe("invalid_value");
  });
});

describe("reader", () => {
  const read = (fields: Record<string, unknown>) => ({ response: { kind: "physical", amount: 1, written: "", perUnit: 1, standardUnit: "m", estimated: false, item: "", items: "", subject: "", ...fields } });

  it("only accepts the person's own number, optionally scaled by their number word", () => {
    expect(writtenNumbers("3 slices and 1,000.5 crumbs")).toEqual([3, 1000.5]);
    expect(amountMatches("3 million ants", 3e6)).toBe(true);
    expect(amountMatches("3 million ants", 4e6)).toBe(false);
    expect(amountMatches("a dozen eggs", 1)).toBe(true);
    expect(amountMatches("2 metresish", 3)).toBe(false);
  });

  it("uses code's own factor for units it knows and keeps the model's factor for Jev otherwise", () => {
    expect(readMeasure(read({ amount: 5, written: "km", perUnit: 999, standardUnit: "m" }), "5 km-ish")).toMatchObject({ outcome: "ok", checkEstimate: false, measure: { quantity: 5, unit: "km" } });
    expect(readMeasure(read({ amount: 3, written: "furlongs", perUnit: 201.168, standardUnit: "m" }), "3 furlongs")).toMatchObject({ outcome: "ok", checkEstimate: true, measure: { unit: "m", estimate: { perUnit: 201.168, written: "furlongs" } } });
    expect(readMeasure(read({ amount: 3, written: "dozen eggs", kind: "count", perUnit: 12, standardUnit: "count", item: "egg", items: "eggs" }), "3 dozen eggs")).toMatchObject({ outcome: "ok", measure: { kind: "count", quantity: 36, items: "eggs" }, checkEstimate: true });
    expect(readMeasure(read({ amount: 60, written: "bpm", perUnit: 1, standardUnit: "Hz" }), "60 bpm")).toMatchObject({ outcome: "ok", checkEstimate: true });
    expect(readMeasure(read({ amount: 20, kind: "currency", written: "quid", standardUnit: "gbp" }), "20 quid")).toMatchObject({ outcome: "ok", measure: { kind: "currency", unit: "GBP", quantity: 20 } });
  });

  it("rejects refusals, nothing to measure, scaled temperatures and unknown currencies", () => {
    expect(readMeasure({ response: "I'm sorry, I can't help with that." }, "x").outcome).toBe("refusal");
    expect(readMeasure(read({ kind: "none" }), "hello").outcome).toBe("none");
    expect(readMeasure(read({ amount: 3, written: "body heats", perUnit: 37, standardUnit: "degC" }), "3 body heats").outcome).toBe("invalid_unit");
    expect(readMeasure(read({ kind: "currency", standardUnit: "DOGE" }), "1 dogecoin").outcome).toBe("invalid_unit");
    expect(readMeasure({ response: { kind: "physical" } }, "x").outcome).toBe("schema_error");
  });
});

describe("replay log", () => {
  const record = { schema: "abm-replay.v1", flowVersion: "model-flow.v1", requestId: "r", at: "2026-10-04T00:00:00.000Z", input: "40 t", recentFamilies: [], outcome: "model", status: 200, refused: false, latencyMs: 5, stages: [{ stage: "creative", model: "m", promptVersion: "p", latencyMs: 1, outcome: "ok", request: "x".repeat(60_000), response: "y".repeat(60_000) }] } satisfies ReplayRecord;

  it("drops raw payloads before exceeding the row budget", () => {
    const text = serialiseRecord(record);
    expect(text.length).toBeLessThanOrEqual(96_000);
    expect(JSON.parse(text)).toMatchObject({ truncated: true, stages: [{ response: "[dropped: record too large]", request: "x".repeat(60_000) }] });
  });

  it("writes one row, prunes old rows occasionally and never throws", async () => {
    const queries: unknown[][] = [];
    const db = { prepare: (query: string) => ({ bind: (...values: unknown[]) => ({ run: async () => { queries.push([query, ...values]); } }) }) };
    await writeReplay(db, record, 0.5);
    expect(queries).toHaveLength(1);
    await writeReplay(db, record, 0);
    expect(queries.at(-1)).toEqual(["DELETE FROM conversions WHERE created_at < ?", "2026-09-04T00:00:00.000Z"]);
    const failing = { prepare: () => { throw new Error("no such table"); } };
    await expect(writeReplay(failing, record)).resolves.toBeUndefined();
    await expect(writeReplay(undefined, record)).resolves.toBeUndefined();
  });
});
