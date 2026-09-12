import { describe, expect, it } from "vitest";
import bundle from "../evals/animal-reference-proposals-22.json";
import { buildRangeScenes } from "../src/lib/range-scenes";
import { sceneLimits, sceneSaliencePolicy } from "../src/lib/scene-packets";

const wombat = bundle.references[0];
const one = (row: unknown = wombat) => ({ ...bundle, references: [row] });

describe("evaluation-only animal mass intervals", () => {
  it("divides by opposing mass endpoints, retaining both range and source qualifiers", () => {
    const scenes = buildRangeScenes({ quantity: 23, sourceUnit: "kg" }, bundle);
    expect(scenes).toHaveLength(3);
    const scene = scenes[0];
    expect(scene.computed).toMatchObject({ min: 23 / 39, max: 23 / 22, unit: "ratio", operands: { input_kg: 23, mass_min_kg: 22, mass_max_kg: 39 } });
    expect(scene.headline).toBe("About 0.59–1.0 bare-nosed wombats by weight.");
    expect(scene.sources[0].publishedMass).toEqual(wombat.publishedMass);
    expect(scene.sources[0].biologicalScope).toEqual(wombat.biologicalScope);
    expect(scene.sources[0].url).toBe(wombat.source.url);
    expect(scene.sources[0].massExcerpt).toBe(wombat.source.massExcerpt);
    for (const qualifier of Object.values(wombat.biologicalScope)) expect(scene.basis).toContain(qualifier);
    expect(scene.basis).toContain(wombat.otherPublishedMassStatement!);
    expect(scene.basis).toContain("fractional equivalents do not imply complete animals");
  });

  it("solves both kinetic endpoints and reconstructs the supplied energy", () => {
    const [scene] = buildRangeScenes({ quantity: 900, sourceUnit: "J" }, one());
    expect(scene.computed.min).toBeCloseTo(Math.sqrt(1800 / 39), 12);
    expect(scene.computed.max).toBeCloseTo(Math.sqrt(1800 / 22), 12);
    expect(0.5 * 39 * scene.computed.min ** 2).toBeCloseTo(900, 10);
    expect(0.5 * 22 * scene.computed.max ** 2).toBeCloseTo(900, 10);
    expect(scene.headline).toBe("Imagine a bare-nosed wombat moving at about 15–20 mph");
    expect(scene.basis).toContain("not a running speed, biological capability or survival claim");
    expect(scene.computed.unit).toBe("m/s");
  });

  it("keeps the emperor's adult and seasonal scope visible in both kinds of headline", () => {
    for (const measurement of [{ quantity: 900, sourceUnit: "J" }, { quantity: 23, sourceUnit: "kg" }]) {
      const penguin = buildRangeScenes(measurement, bundle)[1];
      expect(penguin.headline).toMatch(/adult emperor penguins? during the hatching period/);
      expect(penguin.basis).toContain(bundle.references[1].requiredQualifier);
      expect(penguin.sources[0].biologicalScope.season).toBe(bundle.references[1].biologicalScope.season);
    }
  });

  it("is invariant to equivalent input units and normalizes published pounds exactly", () => {
    const kilograms = buildRangeScenes({ quantity: 23, sourceUnit: "kg" }, bundle);
    const grams = buildRangeScenes({ quantity: 23000, sourceUnit: "grams" }, bundle);
    expect(grams.map(scene => scene.computed)).toEqual(kilograms.map(scene => scene.computed));
    expect(grams[0]).toMatchObject({ quantity: 23000, sourceUnit: "grams" });
    const rabbit = kilograms[2];
    expect(rabbit.computed.operands.mass_min_kg).toBeCloseTo(2 * 0.45359237, 12);
    expect(rabbit.computed.operands.mass_max_kg).toBeCloseTo(11 * 0.45359237, 12);
    expect(rabbit.computed.min).toBeCloseTo(23 / (11 * 0.45359237), 12);
    expect(rabbit.computed.max).toBeCloseTo(23 / (2 * 0.45359237), 12);
    expect(rabbit.sources[0].publishedMass.unit).toBe("lb");
    const joules = buildRangeScenes({ quantity: 900, sourceUnit: "J" }, bundle);
    const kilojoules = buildRangeScenes({ quantity: 0.9, sourceUnit: "kJ" }, bundle);
    expect(kilojoules.map(scene => scene.computed)).toEqual(joules.map(scene => scene.computed));
    const convertedRange = one({ ...wombat, publishedMass: { ...wombat.publishedMass, min: 22000, max: 39000, unit: "g" } });
    expect(buildRangeScenes({ quantity: 23, sourceUnit: "kg" }, convertedRange)[0].computed).toEqual(kilograms[0].computed);
  });

  it("rejects the whole mass interval if just one endpoint fails salience", () => {
    // Ratios at the other endpoint remain within the admitted range.
    expect(buildRangeScenes({ quantity: 3, sourceUnit: "kg" }, one())).toEqual([]);
    expect(3 / 22).toBeGreaterThan(sceneSaliencePolicy.minRatio);
    expect(buildRangeScenes({ quantity: 30000, sourceUnit: "kg" }, one())).toEqual([]);
    expect(30000 / 39).toBeLessThan(sceneSaliencePolicy.maxRatio);
    expect(buildRangeScenes({ quantity: 39 * sceneSaliencePolicy.minRatio, sourceUnit: "kg" }, one())).toHaveLength(1);
    expect(buildRangeScenes({ quantity: 22 * sceneSaliencePolicy.maxRatio, sourceUnit: "kg" }, one())).toHaveLength(1);
  });

  it("rejects the whole speed interval when only its fast or slow endpoint fails", () => {
    const tooFast = 0.5 * 22 * (sceneLimits.maxKineticSpeed + 1) ** 2;
    expect(Math.sqrt(2 * tooFast / 39)).toBeLessThan(sceneLimits.maxKineticSpeed);
    expect(buildRangeScenes({ quantity: tooFast, sourceUnit: "J" }, one())).toEqual([]);
    const minimumSpeed = sceneSaliencePolicy.minSpeedMph * 0.44704;
    const tooSlow = 0.5 * 30 * minimumSpeed ** 2;
    expect(Math.sqrt(2 * tooSlow / 22)).toBeGreaterThan(minimumSpeed);
    expect(Math.sqrt(2 * tooSlow / 39)).toBeLessThan(minimumSpeed);
    expect(buildRangeScenes({ quantity: tooSlow, sourceUnit: "J" }, one())).toEqual([]);
  });

  it("rejects bad intervals, incompatible units, missing provenance and duplicate IDs", () => {
    for (const mass of [{ min: 0, max: 39 }, { min: -1, max: 39 }, { min: 39, max: 22 }, { min: 22, max: 22 }, { min: NaN, max: 39 }, { min: 22, max: Infinity }, { unit: "J" }, { unit: "mg/Mg" }, { kind: "average" }]) {
      expect(() => buildRangeScenes({ quantity: 23, sourceUnit: "kg" }, one({ ...wombat, publishedMass: { ...wombat.publishedMass, ...mass } }))).toThrow();
    }
    for (const source of [{ ...wombat.source, url: "http://example.com" }, { ...wombat.source, institution: "" }, { ...wombat.source, massExcerpt: "" }]) {
      expect(() => buildRangeScenes({ quantity: 23, sourceUnit: "kg" }, one({ ...wombat, source }))).toThrow();
    }
    expect(() => buildRangeScenes({ quantity: 23, sourceUnit: "kg" }, { ...bundle, references: [wombat, wombat] })).toThrow("invalid_range_id");
    expect(() => buildRangeScenes({ quantity: 23, sourceUnit: "kg" }, one({ ...wombat, biologicalScope: {} }))).toThrow();
    expect(() => buildRangeScenes({ quantity: 23, sourceUnit: "kg" }, { ...bundle, references: new Array(1) })).toThrow();
  });

  it("handles zero, unsupported dimensions and numerical extremes explicitly", () => {
    expect(buildRangeScenes({ quantity: 0, sourceUnit: "J" }, bundle)).toEqual([]);
    expect(buildRangeScenes({ quantity: 0, sourceUnit: "kg" }, bundle).every(scene => scene.computed.min === 0 && scene.computed.max === 0)).toBe(true);
    expect(buildRangeScenes({ quantity: 32, sourceUnit: "degF" }, bundle)).toEqual([]);
    expect(buildRangeScenes({ quantity: 900, sourceUnit: "W" }, bundle)).toEqual([]);
    expect(buildRangeScenes({ quantity: 1e308, sourceUnit: "J" }, bundle)).toEqual([]);
    for (const quantity of [-1, Infinity, NaN]) expect(() => buildRangeScenes({ quantity, sourceUnit: "kg" }, bundle)).toThrow();
  });

  it("does not mutate source data and gives each result independent nested source fields", () => {
    const original = JSON.stringify(bundle);
    const input = Object.freeze({ quantity: 900, sourceUnit: "J" });
    const first = buildRangeScenes(input, bundle);
    const second = buildRangeScenes(input, bundle);
    expect(first).toEqual(second);
    first[0].sources[0].publishedMass.min = 1;
    first[0].sources[0].biologicalScope.species = "fiction";
    expect(second[0].sources[0].publishedMass.min).toBe(22);
    expect(second[0].sources[0].biologicalScope.species).toBe(wombat.biologicalScope.species);
    expect(JSON.stringify(bundle)).toBe(original);
  });
});
