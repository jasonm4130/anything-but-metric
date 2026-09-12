import { describe, expect, it } from "vitest";
import catalog from "../evals/grounded-references.json";
import additions from "../evals/scene-reference-additions.json";
import dataReferences from "../evals/scene-data-reference-proposals.json";
import { buildScenePackets, sceneLimits, sceneSaliencePolicy } from "../src/lib/scene-packets";
import { compileSceneRecipe, parseSceneRecipe, sceneRecipeCards, sceneRecipeContextLimit, sceneRecipeSchema, type SceneRecipeOperation } from "../src/lib/scene-recipes";

const all = [...catalog, ...additions];
const recipe = (operation: SceneRecipeOperation, referenceId: string, context = "The object demands a speaking part.") => ({ operation, referenceId, context });
const fact = (id: string) => all.find(row => row.id === id)!;
const compile = (quantity: number, sourceUnit: string, operation: SceneRecipeOperation, referenceId: string) => compileSceneRecipe({ quantity, sourceUnit }, all, recipe(operation, referenceId), { dataReferences });

describe("evaluation-only source recipe compiler", () => {
  it("offers validated source cards and typed capabilities, without user-specific scene results", () => {
    const cards = sceneRecipeCards(all, dataReferences);
    expect(cards.find(card => card.referenceId === "mass-iphone-17")).toMatchObject({ dimension: "mass", scenarioRole: "object", operations: ["count_equivalent", "energy_motion"], referenceQuantity: 0.177 });
    expect(cards.find(card => card.referenceId === "power-hoover")).toMatchObject({ operations: ["energy_duration"], scenarioRole: "power-generator" });
    expect(cards.find(card => card.referenceId === "data-ursa-cine-12k-raw3to1-24fps")).toMatchObject({ dimension: "data-rate", operations: ["data_duration"], referenceQuantity: 1194000000, referenceUnit: "B/s" });
    expect(cards.every(card => !("computed" in card) && !("headline" in card))).toBe(true);
    expect(cards.some(card => card.referenceId === "data-defined-ascii-page-2000")).toBe(false);
    expect(cards.some(card => ["temperature", "pressure", "speed", "frequency", "angle"].includes(card.dimension))).toBe(false);
    expect(cards.filter(card => card.dimension === "power").every(card => !card.operations.includes("count_equivalent"))).toBe(true);
    const schema = sceneRecipeSchema(cards);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.referenceId.enum).toEqual(cards.map(card => card.referenceId));
  });

  it("rejects malformed, unsourced or incompatible catalogs rather than treating them as creative misses", () => {
    const phone = fact("mass-iphone-17");
    expect(() => sceneRecipeCards([{ ...phone, sourceUrl: "http://example.com" }])).toThrow("missing_scene_provenance");
    expect(() => sceneRecipeCards([{ ...phone, scenarioRole: "power-consumer" }])).toThrow("invalid_scene_metadata");
    const unknown = { ...phone, id: "mass-unnamed-source" };
    expect(sceneRecipeCards([unknown])[0].operations).toEqual(["count_equivalent"]);
    expect(compileSceneRecipe({ quantity: 900, sourceUnit: "J" }, [unknown], recipe("energy_motion", unknown.id))).toBeUndefined();
    const badRate = structuredClone(dataReferences);
    badRate.references[0].referenceQuantity += 1;
    expect(() => sceneRecipeCards(all, badRate)).toThrow("invalid_data_derivation");
    const collision = structuredClone(dataReferences);
    collision.references[0].id = phone.id;
    expect(() => sceneRecipeCards(all, collision)).toThrow("duplicate_data_reference");
  });

  it("strictly accepts one recipe with bounded fictional context and no model operands", () => {
    const valid = recipe("energy_motion", "mass-iphone-17");
    expect(parseSceneRecipe(valid)).toEqual(valid);
    for (const invalid of [null, [valid], { ...valid, mass: 1 }, { ...valid, referenceQuantity: 1 }, { ...valid, population: 90000 }, { ...valid, operation: "eval" }, { ...valid, context: {} }, { ...valid, context: " " }, { ...valid, context: "x".repeat(sceneRecipeContextLimit + 1) }, { ...valid, context: "two\nlines" }, { ...valid, [Symbol("operand")]: 1 }]) {
      expect(parseSceneRecipe(invalid)).toBeUndefined();
    }
    expect(compile(900, "J", "energy_motion", "invented-mass")).toBeUndefined();
    expect(compile(900, "J", "energy_duration", "mass-iphone-17")).toBeUndefined();
    expect(compile(23, "kg", "energy_motion", "mass-iphone-17")).toBeUndefined();
  });

  it("computes fractional quantity equivalents without asserting whole objects or packing", () => {
    const result = compile(23, "kg", "count_equivalent", "mass-parmigiano-wheel")!;
    expect(result.packet.computed.value).toBeCloseTo(23 / 40, 12);
    expect(result.packet.basis).toContain(fact("mass-parmigiano-wheel").assumption);
    expect(result.packet.basis).toContain("fractional equivalents do not imply complete objects");
    expect(result.context).toBe("The object demands a speaking part.");
    expect(compile(32, "degF", "count_equivalent", "temperature-water-freezing")).toBeUndefined();
    expect(compile(70, "W", "count_equivalent", "power-apple-adapter")).toBeUndefined();
    expect(compile(0, "kg", "count_equivalent", "mass-parmigiano-wheel")!.packet.computed.value).toBe(0);
  });

  it("solves motion after binding, preserving exact existing math, source and survival qualification", () => {
    const input = { quantity: 900, sourceUnit: "J" };
    const source = fact("mass-parmigiano-wheel");
    const compiled = compileSceneRecipe(input, all, recipe("energy_motion", source.id))!;
    expect(compiled.packet).toEqual(buildScenePackets(input, [source]).find(packet => packet.mechanism === "launch-object"));
    expect(compiled.packet.computed.value).toBeCloseTo(Math.sqrt(2 * 900 / 40), 12);
    expect(compiled.packet.basis).toContain("not a claim the object survives");
    expect(compiled.packet.sources[0]).toMatchObject({ id: source.id, quantity: 40, unit: "kg", url: source.sourceUrl, note: source.sourceNote, assumption: source.assumption });
    const changedContext = compileSceneRecipe(input, all, recipe("energy_motion", source.id, "The manager imagines a cast of 500 performers."))!;
    expect(changedContext.packet).toEqual(compiled.packet);
    expect(changedContext.packet.basis).not.toContain("500");
  });

  it("preserves generation versus consumption and measured versus rated assumptions", () => {
    const generated = compile(2080000000 * 60, "J", "energy_duration", "power-hoover")!.packet;
    expect(generated.mechanism).toBe("generate-energy");
    expect(generated.computed.value).toBe(60);
    expect(generated.headline).toContain("would generate");
    expect(generated.headline).toContain("nameplate capacity");
    const consumed = compile(900, "J", "energy_duration", "power-switch-2-mario-kart")!.packet;
    expect(consumed.mechanism).toBe("run-appliance");
    expect(consumed.computed.value).toBeCloseTo(900 / 19, 12);
    expect(consumed.basis).toContain(fact("power-switch-2-mario-kart").assumption);
    expect(consumed.basis).not.toContain("rated power");
    expect(consumed.sources[0].scenarioRole).toBe("power-consumer");
  });

  it("solves a generic volume layer without changing material or asserting containment", () => {
    const area = all.find(row => row.id.includes("tennis") && row.referenceUnit === "m^2")!;
    const result = compile(8500, "L", "volume_layer", area.id)!.packet;
    expect(result.computed.value).toBeCloseTo(8.5 / area.referenceQuantity, 12);
    expect(result.headline).toContain("layer");
    expect(result.headline).not.toContain("water");
    expect(result.basis).toContain("perfectly flat, uniform layer");
    expect(result.basis).toContain("ignores terrain, drainage and containment");
    expect(result.sources[0].assumption).toBe(area.assumption);
  });

  it("keeps data byte prefixes, nominal encoding and stored-duration limits exact", () => {
    const id = "data-ursa-cine-12k-raw3to1-24fps";
    for (const [quantity, sourceUnit, bytes] of [[3, "PB", 3e15], [3, "PiB", 3 * 2 ** 50], [12000, "MB", 12e9], [12000, "Mb", 1.5e9]] as const) {
      const packet = compile(quantity, sourceUnit, "data_duration", id)!.packet;
      expect(packet.computed.value).toBeCloseTo(bytes / 1194000000, 8);
      expect(packet.computed.operands.input_bytes).toBe(bytes);
      expect(packet.quantity).toBe(quantity);
      expect(packet.sourceUnit).toBe(sourceUnit);
      expect(packet.sources).toHaveLength(1);
      expect(packet.basis).toContain("nominal and decimal MB");
      expect(packet.basis).toContain("not human attention");
      expect(packet.basis).toContain(dataReferences.references.find(row => row.id === id)!.assumption);
      expect(packet.sources[0].derivation).toEqual(dataReferences.references.find(row => row.id === id)!.derivation);
    }
    expect(compile(3, "PB", "data_duration", "data-podcast-spotify-96k")).toBeUndefined();
  });

  it("uses existing physical and salience bounds without fallback, clamping or invented groups", () => {
    const mass = 40;
    expect(compile(0.5 * mass * (sceneLimits.maxKineticSpeed + 1) ** 2, "J", "energy_motion", "mass-parmigiano-wheel")).toBeUndefined();
    expect(compile(0.5 * mass * (sceneSaliencePolicy.minSpeedMph * 0.44704 / 2) ** 2, "J", "energy_motion", "mass-parmigiano-wheel")).toBeUndefined();
    expect(compile(144, "J", "energy_duration", "power-hoover")).toBeUndefined();
    expect(compile(7140 * 101, "m^3", "volume_layer", "area-fifa-pitch")).toBeUndefined();
    expect(compile(7140 * 0.0254 * 0.001, "m^3", "volume_layer", "area-fifa-pitch")).toBeUndefined();
    expect(compile(0, "J", "energy_motion", "mass-parmigiano-wheel")).toBeUndefined();
    for (const quantity of [-1, Infinity, NaN, 1e308]) expect(compile(quantity, "J", "energy_motion", "mass-parmigiano-wheel")).toBeUndefined();
  });

  it("does not mutate the inventory, recipe or supplied measurement", () => {
    const original = JSON.stringify({ all, dataReferences });
    const input = Object.freeze({ quantity: 3, sourceUnit: "PB" });
    const proposed = Object.freeze(recipe("data_duration", "data-ursa-cine-12k-raw3to1-24fps"));
    const result = compileSceneRecipe(input, all, proposed, { dataReferences })!;
    result.packet.sources[0].assumption = "changed only in the returned packet";
    expect(JSON.stringify({ all, dataReferences })).toBe(original);
  });
});
