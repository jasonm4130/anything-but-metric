import { describe, expect, it } from "vitest";
import { unit } from "mathjs";
import catalog from "../evals/grounded-references.json";
import additions from "../evals/scene-reference-additions.json";
import { anchorMotionScenes } from "../src/lib/motion-anchors";
import { buildScenePackets, type ScenePacket } from "../src/lib/scene-packets";

const mouse = additions.find(fact => fact.id === "mass-g502-hero")!;
const bolt = catalog.find(fact => fact.id === "speed-bolt-100m")!;
function motion(quantity = 900, sourceUnit = "J"): ScenePacket {
  return buildScenePackets({ quantity, sourceUnit }, [mouse]).find(packet => packet.mechanism === "launch-object")!;
}

describe("source-backed motion speed anchors", () => {
  it("preserves finite motion when twice the input energy would overflow", () => {
    const synthetic = { ...mouse, id: "mass-synthetic-extreme", referenceQuantity: 1e306, referenceUnit: "kg", assumption: "Synthetic arithmetic boundary, not a physical object." };
    const original = buildScenePackets({ quantity: 9e307, sourceUnit: "J" }, [synthetic]).find(packet => packet.mechanism === "launch-object")!;
    expect(original.computed.value).toBeCloseTo(Math.sqrt(180), 12);
    const [scene] = anchorMotionScenes([original], [bolt]);
    expect(scene?.computed.comparisonRatio).toBeCloseTo(Math.sqrt(180) / bolt.referenceQuantity, 12);
  });

  it("combines a computed object speed with Bolt's qualified record average", () => {
    const original = motion();
    const [scene] = anchorMotionScenes([original], catalog);
    const expected = Math.sqrt(2 * 900 / 0.121) / bolt.referenceQuantity;
    expect(scene.mechanism).toBe("motion-speed-anchor");
    expect(scene.headline).toBe("Imagine a gaming mouse moving at about 11.7 times Usain Bolt's average speed over his record 100 m race");
    expect(scene.computed.comparisonRatio).toBeCloseTo(expected, 12);
    expect(scene.computed.value).toBe(original.computed.value);
    expect(scene.computed.unit).toBe("m/s");
    expect(scene.computed.formula).toBe(original.computed.formula + "; comparison_ratio = moving_speed_m_s / reference_speed_m_s");
    expect(scene.computed.operands).toMatchObject(original.computed.operands);
    expect(scene.computed.operands.reference_speed_m_s).toBe(bolt.referenceQuantity);
    expect(scene.quantity).toBe(900);
    expect(scene.sourceUnit).toBe("J");
    expect(scene.basis.startsWith(original.basis + " ")).toBe(true);
    expect(scene.basis).toContain("not a claim the object survives");
    expect(scene.basis).toContain(bolt.assumption);
    expect(scene.basis).toContain("not his top speed or an endurance speed");
    expect(scene.basis).toContain("not numbers of runners or an actual race");
    expect(scene.sources.slice(0, original.sources.length)).toEqual(original.sources);
    expect(scene.sources.at(-1)).toEqual({ id: bolt.id, quantity: bolt.referenceQuantity, unit: "m/s", assumption: bolt.assumption, url: bolt.sourceUrl, note: bolt.sourceNote });
  });

  it("converts compatible input-energy, mass and speed units before comparing", () => {
    const original = motion(0.9, "kJ");
    const alternate = { ...bolt, referenceQuantity: unit(bolt.referenceQuantity, "m/s").toNumber("km/h"), referenceUnit: "km/h" };
    const [scene] = anchorMotionScenes([original], [alternate]);
    expect(scene.quantity).toBe(0.9);
    expect(scene.sourceUnit).toBe("kJ");
    expect(scene.computed.operands.energy_j).toBe(900);
    expect(scene.computed.comparisonRatio).toBeCloseTo(original.computed.value / bolt.referenceQuantity, 12);
    expect(scene.sources.at(-1)?.unit).toBe("km/h");
    expect(scene.sources.at(-1)?.quantity).toBe(alternate.referenceQuantity);
    const grams = structuredClone(original);
    grams.sources[0].quantity *= 1000; grams.sources[0].unit = "g";
    expect(anchorMotionScenes([grams], [bolt])[0].computed.comparisonRatio).toBeCloseTo(scene.computed.comparisonRatio!, 12);
  });

  it("rejects invalid speed facts and duplicate catalog ids", () => {
    const original = motion();
    for (const invalid of [
      { ...bolt, referenceQuantity: 0 }, { ...bolt, referenceQuantity: -1 },
      { ...bolt, referenceQuantity: NaN }, { ...bolt, referenceUnit: "kg" },
      { ...bolt, sourceUrl: "http://example.com" }, { ...bolt, sourceNote: "" }
    ]) expect(() => anchorMotionScenes([original], [invalid])).toThrow();
    expect(() => anchorMotionScenes([original], [bolt, bolt])).toThrow();
  });

  it("admits only the existing bounded ratio range without clamping", () => {
    const original = motion();
    // Synthetic speed values test the boundary; no claim that these are Bolt's speed.
    const reference = (ratio: number) => ({ ...bolt, id: "speed-synthetic-test", referenceLabel: "a synthetic test speed", assumption: "A synthetic arithmetic test reference.", referenceQuantity: original.computed.value / ratio });
    for (const ratio of [0.1, 1, 1000]) expect(anchorMotionScenes([original], [reference(ratio)])[0].computed.comparisonRatio).toBeCloseTo(ratio, 10);
    for (const ratio of [0.099, 1001]) expect(anchorMotionScenes([original], [reference(ratio)])).toEqual([]);
  });

  it("does not turn non-motion, inconsistent or duplicate-source packets into scenes", () => {
    const original = motion();
    const invalid = [
      { ...original, mechanism: "direct" }, { ...original, quantity: 901 }, { ...original, sourceUnit: "kg" },
      { ...original, computed: { ...original.computed, unit: "kg" } },
      { ...original, computed: { ...original.computed, value: 0 } },
      { ...original, computed: { ...original.computed, value: Infinity } },
      { ...original, computed: { ...original.computed, value: original.computed.value * 2 } },
      { ...original, sources: [original.sources[0], original.sources[0]] },
      { ...original, sources: [{ ...original.sources[0], unit: "s" }] }
    ];
    for (const packet of invalid) expect(anchorMotionScenes([packet], [bolt])).toEqual([]);
    expect(() => anchorMotionScenes([original, original], [bolt])).toThrow("duplicate_motion_scene");
  });

  it("preserves both inputs even when a returned scene is subsequently edited", () => {
    const original = motion();
    const before = JSON.stringify({ original, bolt });
    const [scene] = anchorMotionScenes([original], [bolt]);
    scene.sources[0].assumption = "changed";
    scene.sources.at(-1)!.quantity = 1;
    scene.computed.operands.mass_kg = 1;
    expect(JSON.stringify({ original, bolt })).toBe(before);
  });

  it("does not carry a stale preformatted speed headline into the derived scene", () => {
    const original = { ...motion(), displayHeadline: "A gaming mouse at 273 mph" };
    const [scene] = anchorMotionScenes([original], [bolt]);
    expect(scene).not.toHaveProperty("displayHeadline");
    expect(scene.headline).toContain("11.7 times");
    expect(original.displayHeadline).toBe("A gaming mouse at 273 mph");
  });
});
