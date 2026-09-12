import { describe, expect, it } from "vitest";
import catalog from "../evals/grounded-references.json";
import additions from "../evals/scene-reference-additions.json";
import scaleAnchors from "../evals/scene-scale-anchors.json";
import dataReferences from "../evals/scene-data-reference-proposals.json";
import { buildScenePackets, isSalientScenePacket, routeRecentSceneFamilies, sceneSaliencePolicy, sceneLimits, scenePacketInput, scenePacketSchema, selectScenePacket, type FamilyRoutingReport } from "../src/lib/scene-packets";
const subset = (...ids: string[]) => catalog.filter(fact => ids.includes(fact.id));
const phone = "mass-iphone-17";

describe("trusted scene packets", () => {
  it("records the original one-family petabyte coverage before enabling new data scenes", () => {
    const baseline = buildScenePackets({ quantity: 1, sourceUnit: "PB" }, [...catalog, ...additions]);
    expect(baseline).toHaveLength(1);
    expect(baseline[0].sources[0].id).toBe("data-lto9-tape");
    expect(baseline[0].computed.value).toBeCloseTo(1e15 / 18e12, 10);
  });
  it("calculates appliance duration from energy and preserves its factual provenance", () => {
    const [packet] = buildScenePackets({ quantity: 4.2, sourceUnit: "kJ" }, subset("power-apple-adapter"));
    expect(packet).toMatchObject({ mechanism: "run-appliance", quantity: 4.2, sourceUnit: "kJ", computed: { value: 60, unit: "s", operands: { energy_j: 4200, power_w: 70 } } });
    expect(packet.headline).toContain("1 minute");
    expect(packet.basis).toContain("no conversion losses");
    expect(packet.sources[0]).toMatchObject({ id: "power-apple-adapter", quantity: 70, unit: "W", url: expect.stringContaining("https://"), assumption: expect.any(String) });
    expect(packet.sources[0].note).toBe(catalog.find(fact => fact.id === "power-apple-adapter")!.sourceNote);
  });

  it("distinguishes generated output from consumed appliance energy", () => {
    const [hoover] = buildScenePackets({ quantity: 2080000000 * 60, sourceUnit: "J" }, subset("power-hoover"));
    expect(hoover).toMatchObject({ mechanism: "generate-energy", computed: { value: 60, unit: "s" } });
    expect(hoover.headline).toBe("The energy Hoover Dam at nameplate capacity would generate in about 1 minute");
    expect(hoover.sources[0].scenarioRole).toBe("power-generator");
    expect(hoover.headline).not.toContain("run Hoover");
    const consumer = buildScenePackets({ quantity: 4200, sourceUnit: "J" }, subset("power-apple-adapter"))[0];
    expect(consumer.mechanism).toBe("run-appliance");
  });

  it("accepts typed catalog scene metadata, retains it, and skips missing labels safely", () => {
    const original = subset(phone)[0];
    const extra = { ...original, id: "mass-new-object", singularLabel: "a documented test object", scenarioRole: "object" };
    const packets = buildScenePackets({ quantity: 10, sourceUnit: "J" }, [extra]);
    expect(packets).toHaveLength(1);
    expect(packets[0].headline).toContain("a documented test object");
    expect(packets[0].sources[0]).toMatchObject({ singularLabel: extra.singularLabel, scenarioRole: "object", url: original.sourceUrl, note: original.sourceNote });
    expect(buildScenePackets({ quantity: 10, sourceUnit: "J" }, [{ ...extra, singularLabel: undefined }])).toEqual([]);
    expect(() => buildScenePackets({ quantity: 10, sourceUnit: "J" }, [{ ...extra, scenarioRole: "power-generator" }])).toThrow("invalid_scene_metadata");
    expect(() => buildScenePackets({ quantity: 10, sourceUnit: "J" }, [{ ...extra, singularLabel: " " }])).toThrow("invalid_scene_metadata");
    const power = { ...subset("power-hoover")[0], id: "power-new-generator", singularLabel: "a documented generator", scenarioRole: "power-generator" };
    expect(buildScenePackets({ quantity: 2080000000, sourceUnit: "J" }, [power])[0].mechanism).toBe("generate-energy");
    expect(buildScenePackets({ quantity: 100, sourceUnit: "J" }, [{ ...power, scenarioRole: undefined }])).toEqual([]);
    const area = { ...subset("area-fiba-court")[0], id: "area-new-rectangle", singularLabel: "a documented rectangle", scenarioRole: "area" };
    expect(buildScenePackets({ quantity: 420, sourceUnit: "m^3" }, [area])[0].headline).toContain("a documented rectangle");
  });

  it("derives lift height and landmark ratio from E=mgh, retaining all three bases", () => {
    const energy = 0.177 * 9.80665 * 105;
    const packet = buildScenePackets({ quantity: energy, sourceUnit: "J" }, subset(phone, "length-fifa-pitch")).find(packet => packet.mechanism === "lift-object")!;
    expect(packet.computed.value).toBeCloseTo(105, 10);
    expect(packet.computed.comparisonRatio).toBeCloseTo(1, 10);
    expect(packet.sources.map(source => source.id)).toEqual([phone, "length-fifa-pitch", "constant-standard-gravity"]);
    expect(packet.headline).toContain("straight up");
    expect(packet.basis).toContain("changes in gravity");
  });

  it("uses E=mv²/2 for motion, rejects absurd speeds and constant-gravity extents", () => {
    const packets = buildScenePackets({ quantity: 0.5 * 0.177 * 20 ** 2, sourceUnit: "J" }, subset(phone, "length-six-foot-table"));
    const motion = packets.find(packet => packet.mechanism === "launch-object")!;
    expect(motion.computed.value).toBeCloseTo(20, 10);
    expect(motion.headline).toContain("44.7 mph");
    expect(motion.basis).toContain("not a claim the object survives");
    expect(buildScenePackets({ quantity: 1e30, sourceUnit: "J" }, subset(phone, "length-fifa-pitch"))).toEqual([]);
    const excessiveLift = buildScenePackets({ quantity: 0.177 * 9.80665 * (sceneLimits.maxLiftMetres + 1), sourceUnit: "J" }, subset(phone, "length-fifa-pitch"));
    expect(excessiveLift.some(packet => packet.mechanism === "lift-object")).toBe(false);
  });

  it("computes volume/area depth in imperial units and states the geometry assumption", () => {
    const packet = buildScenePackets({ quantity: 7140 * 0.3048, sourceUnit: "L" }, subset("area-fifa-pitch"))[0];
    expect(packet.computed.value).toBeCloseTo(0.0003048, 12);
    expect(packet.headline).toContain("0.012 inches");
    expect(packet.basis).toContain("terrain, drainage and containment");
    const feet = buildScenePackets({ quantity: 7140 * 0.3048, sourceUnit: "m^3" }, subset("area-fifa-pitch"))[0];
    expect(feet.headline).toContain("1 foot");
    expect(buildScenePackets({ quantity: 7140 * 101, sourceUnit: "m^3" }, subset("area-fifa-pitch"))).toEqual([]);
  });

  it("computes travel time from distance/speed without assuming endurance", () => {
    const packet = buildScenePackets({ quantity: 299792.458, sourceUnit: "km" }, subset("speed-light-vacuum"))[0];
    expect(packet.computed.value).toBeCloseTo(1, 10);
    expect(packet.headline).toContain("1 second");
    expect(packet.basis).toContain("no acceleration, obstacles or endurance assumption");
  });

  it("computes supported weight at standard gravity and keeps mass counts direct", () => {
    const weight = buildScenePackets({ quantity: 2 * 0.177 * 9.80665, sourceUnit: "N" }, subset(phone))[0];
    expect(weight.computed.value).toBeCloseTo(2, 12);
    expect(weight.sources.map(source => source.id)).toEqual([phone, "constant-standard-gravity"]);
    const mass = buildScenePackets({ quantity: 354, sourceUnit: "g" }, subset(phone))[0];
    expect(mass).toMatchObject({ mechanism: "direct", computed: { value: 2, unit: "ratio" } });
  });

  it("treats temperature as a difference and zero as a direct comparison only", () => {
    const freezing = buildScenePackets({ quantity: 32, sourceUnit: "degF" }, subset("temperature-water-freezing"))[0];
    expect(freezing.headline).toBe("About the same temperature as fresh water at its freezing point");
    expect(freezing.computed).toMatchObject({ value: 0, unit: "delta_degF", operands: { source_degF: 32, reference_degF: 32 } });
    const zero = buildScenePackets({ quantity: 0, sourceUnit: "J" }, catalog);
    expect(zero.length).toBeGreaterThan(0);
    expect(zero.every(packet => packet.mechanism === "direct" && packet.computed.value === 0)).toBe(true);
    expect(() => buildScenePackets({ quantity: -274, sourceUnit: "degC" }, catalog)).toThrow();
    expect(() => buildScenePackets({ quantity: -1, sourceUnit: "kg" }, catalog)).toThrow();
    expect(() => buildScenePackets({ quantity: Infinity, sourceUnit: "J" }, catalog)).toThrow();
  });

  it("renders intensive direct measurements as ratios rather than counts of objects", () => {
    const packet = buildScenePackets({ quantity: 1800000, sourceUnit: "Pa" }, subset("pressure-espresso-extraction"))[0];
    expect(packet.headline).toBe("About 2 times the pressure of a nine-bar espresso extraction");
  });

  it("bounds and diversifies packets reproducibly, without fabricating scale groups", () => {
    const measurement = { quantity: 144, sourceUnit: "J" };
    const first = buildScenePackets(measurement, catalog, { seed: 7 });
    expect(first.length).toBeLessThanOrEqual(12);
    expect(new Set(first.map(packet => packet.mechanism)).size).toBe(4);
    expect(new Set(first.map(packet => packet.id)).size).toBe(first.length);
    expect(buildScenePackets(measurement, catalog, { seed: 7 })).toEqual(first);
    expect(buildScenePackets(measurement, catalog, { seed: 19 })).not.toEqual(first);
    expect(buildScenePackets(measurement, catalog, { seed: 7, maxPackets: 3 })).toHaveLength(3);
    expect(() => buildScenePackets(measurement, catalog, { maxPackets: 13 })).toThrow("invalid_scene_limit");
    expect(() => buildScenePackets(measurement, catalog, { draw: () => 1 })).toThrow("invalid_scene_draw");
    const large = buildScenePackets({ quantity: 1e12, sourceUnit: "J" }, catalog);
    expect(large.some(packet => packet.mechanism === "generate-energy" && /minutes/.test(packet.headline))).toBe(true);
    const extreme = buildScenePackets({ quantity: 1e308, sourceUnit: "J" }, catalog);
    expect(extreme).toEqual([]);
    expect(extreme.every(packet => Number.isFinite(packet.computed.value))).toBe(true);
    expect(large.every(packet => packet.sources.every(source => catalog.some(fact => fact.id === source.id) || source.id === "constant-standard-gravity"))).toBe(true);
  });

  it("rejects valid but unvisual scenes before diversity sampling", () => {
    const packets = buildScenePackets({ quantity: 144, sourceUnit: "J" }, [...catalog, ...additions], { seed: 13 });
    expect(packets.length).toBeGreaterThan(0);
    expect(packets.every(isSalientScenePacket)).toBe(true);
    expect(packets.some(packet => packet.id.includes("hoover") || packet.id.includes("mass-iss") || packet.id.includes("red-blood-cell"))).toBe(false);
    expect(packets.filter(packet => packet.mechanism === "lift-object").every(packet => packet.computed.value >= sceneSaliencePolicy.minLiftMetres)).toBe(true);
    expect(buildScenePackets({ quantity: 144, sourceUnit: "J" }, subset("power-hoover"))).toEqual([]);
    expect(buildScenePackets({ quantity: 1e308, sourceUnit: "J" }, [...catalog, ...additions])).toEqual([]);
    expect(buildScenePackets({ quantity: 1e-30, sourceUnit: "m" }, [...catalog, ...additions])).toEqual([]);
  });

  it("renders combined-catalog power ratios grammatically without calling measured averages rated power", () => {
    const kettle = additions.find(fact => fact.id === "power-breville-smart-kettle")!;
    const packet = buildScenePackets({ quantity: 4800, sourceUnit: "W" }, [kettle])[0];
    expect(packet.headline).toBe("About 2 times " + kettle.referenceLabel);
    const consolePower = additions.find(fact => fact.id === "power-switch-2-mario-kart")!;
    const consoleScene = buildScenePackets({ quantity: 190, sourceUnit: "J" }, [consolePower])[0];
    expect(consoleScene.basis).toContain("stated power stays constant");
    expect(consoleScene.basis).toContain(consolePower.assumption);
    expect(consoleScene.basis).not.toContain("rated power");
  });

  it("rejects provenance-free catalogs and prevents writer fields overwriting facts", () => {
    expect(() => buildScenePackets({ quantity: 144, sourceUnit: "J" }, [{ ...catalog[0], sourceUrl: undefined }])).toThrow("missing_scene_provenance");
    const packets = buildScenePackets({ quantity: 144, sourceUnit: "J" }, catalog);
    const selected = selectScenePacket({ packetId: packets[0].id, quip: "The lab has questions.", headline: "999 flying cars", computed: { value: 999 }, quantity: 7, sources: [] }, packets)!;
    expect(selected.packet).toBe(packets[0]);
    expect(selected.packet.quantity).toBe(144);
    expect(selected.packet.sources.length).toBeGreaterThan(0);
    expect(selectScenePacket({ packetId: "made-up", quip: "Nope." }, packets)).toBeUndefined();
    expect(selectScenePacket({ packetId: packets[0].id, quip: " " }, packets)).toBeUndefined();
    expect(scenePacketSchema(packets).properties.packetId.enum).toEqual(packets.map(packet => packet.id));
    const input = JSON.parse(scenePacketInput(packets));
    expect(input[0]).toEqual({ id: packets[0].id, headline: packets[0].headline, basis: packets[0].basis, computed: packets[0].computed });
  });

  it("uses a fixed real ensemble count and stated appliance draw for large-energy durations", () => {
    const hairdryer = additions.find(fact => fact.id === "power-dyson-supersonic")!;
    const wembley = scaleAnchors.anchors.find(anchor => anchor.id === "ensemble-wembley-seats")!;
    const scene = buildScenePackets({ quantity: 1e12, sourceUnit: "J" }, [hairdryer], { scaleAnchors: { schemaVersion: 1, anchors: [wembley] } }).find(packet => packet.mechanism === "ensemble-appliance")!;
    expect(scene).toMatchObject({ family: "stadium", mechanism: "ensemble-appliance", computed: { unit: "s", operands: { energy_j: 1e12, fixed_count: 90000, power_w: 1600, ensemble_power_w: 144000000 } } });
    expect(scene.computed.value).toBeCloseTo(1e12 / (90000 * 1600), 10);
    expect(scene.headline).toContain("Imagine a Dyson Supersonic hair dryer for each of Wembley's 90,000 seats");
    expect(scene.headline).toContain("1.93 hours");
    expect(scene.basis).toContain("not a claim that devices can operate continuously");
    expect(scene.sources.map(source => source.id)).toEqual([wembley.id, hairdryer.id]);
    expect(scene.sources[0].fictionFrame).toBe(wembley.fictionFrame);
    expect(scene.sources[0].note).toBe(wembley.sourceNote);
    expect(scene.sources[1].assumption).toBe(hairdryer.assumption);
  });

  it("preserves ensemble configurations and rejects altered derived counts", () => {
    const toaster = additions.find(fact => fact.id === "power-russell-hobbs-adventure-toaster")!;
    const airliner = scaleAnchors.anchors.find(anchor => anchor.id === "ensemble-a380-certified-seats")!;
    const airlinerScene = buildScenePackets({ quantity: 1e12, sourceUnit: "J" }, [toaster], { scaleAnchors: { schemaVersion: 1, anchors: [airliner] } })[0];
    expect(airlinerScene.headline).toContain("853 maximum certified passenger places");
    expect(airlinerScene.basis).toContain("not typical airline seating");
    const eye = scaleAnchors.anchors.find(anchor => anchor.id === "ensemble-london-eye-passenger-places")!;
    expect(() => buildScenePackets({ quantity: 1e12, sourceUnit: "J" }, [toaster], { scaleAnchors: { schemaVersion: 1, anchors: [{ ...eye, referenceQuantity: 801 }] } })).toThrow("invalid_scale_derivation");
    expect(() => buildScenePackets({ quantity: 1e12, sourceUnit: "J" }, [toaster], { scaleAnchors: { schemaVersion: 1, anchors: [{ ...airliner, referenceQuantity: 853.5 }] } })).toThrow("invalid_scale_anchors");
    expect(() => buildScenePackets({ quantity: 1e12, sourceUnit: "J" }, [toaster], { scaleAnchors: { schemaVersion: 1, anchors: [airliner, airliner] } })).toThrow("invalid_scale_anchors");
  });

  it("uses the Eiffel Tower total mass for bounded ideal kinetic motion", () => {
    const tower = scaleAnchors.anchors.find(anchor => anchor.id === "mass-eiffel-tower-total")!;
    const scenes = buildScenePackets({ quantity: 1e12, sourceUnit: "J" }, subset("power-hoover"), { scaleAnchors: { schemaVersion: 1, anchors: [tower] } });
    const scene = scenes.find(packet => packet.mechanism === "launch-object")!;
    expect(scene.computed.value).toBeCloseTo(Math.sqrt(2e12 / 10100000), 10);
    expect(scene.headline).toContain("995 mph");
    expect(scene.computed.operands.mass_kg).toBe(10100000);
    expect(scene.basis).toContain("not a claim the object survives");
    expect(scene.sources[0].assumption).toContain("7,300-tonne metal framework");
    expect(buildScenePackets({ quantity: 1e20, sourceUnit: "J" }, subset("power-hoover"), { scaleAnchors: { schemaVersion: 1, anchors: [tower] } }).some(packet => packet.mechanism === "launch-object")).toBe(false);
  });

  it("keeps optional scale scenes out of old runs and refuses to resize fixed ensembles", () => {
    const measurement = { quantity: 144, sourceUnit: "J" };
    const old = buildScenePackets(measurement, catalog, { seed: 4 });
    expect(buildScenePackets(measurement, catalog, { seed: 4, scaleAnchors: undefined })).toEqual(old);
    const tiny = buildScenePackets({ quantity: 1e-20, sourceUnit: "J" }, [...catalog, ...additions], { scaleAnchors });
    expect(tiny).toEqual([]);
    const huge = buildScenePackets({ quantity: 1e308, sourceUnit: "J" }, [...catalog, ...additions], { scaleAnchors });
    expect(huge).toEqual([]);
    const volumeOnly = { schemaVersion: 1, anchors: scaleAnchors.anchors.filter(anchor => anchor.kind === "volume-anchor"), materialProperties: scaleAnchors.materialProperties };
    expect(buildScenePackets(measurement, catalog, { seed: 4, scaleAnchors: volumeOnly })).toEqual(old);
    const noConsumer = buildScenePackets({ quantity: 1e12, sourceUnit: "J" }, subset("power-hoover"), { scaleAnchors });
    expect(noConsumer.every(packet => packet.mechanism !== "ensemble-appliance")).toBe(true);
  });

  it("unlocks petabyte media diversity with fixed independent allocations, never a multiplied audience", () => {
    const packets = buildScenePackets({ quantity: 1, sourceUnit: "PB" }, [...catalog, ...additions], { seed: 5, dataReferences, scaleAnchors });
    expect(new Set(packets.map(packet => packet.family)).size).toBeGreaterThanOrEqual(5);
    const media = packets.filter(packet => packet.mechanism === "ensemble-media-duration");
    expect(media.length).toBeGreaterThan(0);
    for (const packet of media) {
      const operands = packet.computed.operands;
      expect(operands.input_bytes).toBe(1e15);
      expect(packet.computed.value * operands.fixed_count * operands.bytes_per_second).toBeCloseTo(1e15, -1);
      expect(packet.sources).toHaveLength(2);
      expect(packet.basis).toContain("independent recordings or separately stored files");
      expect(packet.basis).toContain("Never multiply a single shared file by its audience");
      expect(packet.basis).toContain("not human attention, battery life, continuous camera operation");
      expect(packet.basis).toContain(packet.sources[0].assumption);
      expect(packet.basis).toContain(packet.sources[1].assumption);
    }
    const wembleyOnly = { schemaVersion: 1, anchors: scaleAnchors.anchors.filter(anchor => anchor.id === "ensemble-wembley-seats") };
    const podcastOnly = { schemaVersion: 1, references: dataReferences.references.filter(reference => reference.id === "data-podcast-spotify-96k") };
    const podcast = buildScenePackets({ quantity: 1, sourceUnit: "PB" }, catalog, { dataReferences: podcastOnly, scaleAnchors: wembleyOnly }).find(packet => packet.mechanism === "ensemble-media-duration")!;
    expect(podcast.computed.value).toBeCloseTo(1e15 / (90000 * 12000), 8);
    expect(podcast.sources[0].evidenceType).toBe("published-approximate-rate");
    expect(podcast.sources[0].derivation).toEqual({ bitsPerSecond: 96000, bitsPerByte: 8 });
  });

  it("distinguishes decimal and binary bytes and preserves the eightfold MB/Mb difference", () => {
    const only = { schemaVersion: 1, references: dataReferences.references.filter(reference => reference.id === "data-prores-422hq-uhd-24p") };
    for (const [quantity, sourceUnit, expectedBytes] of [[1, "PB", 1e15], [1, "PiB", 2 ** 50], [800, "MB", 800e6], [800, "Mb", 100e6]] as const) {
      const packet = buildScenePackets({ quantity, sourceUnit }, catalog, { dataReferences: only }).find(packet => packet.mechanism === "media-duration")!;
      expect(packet.computed.operands.input_bytes).toBe(expectedBytes);
      expect(packet.computed.value).toBeCloseTo(expectedBytes / 88375000, 8);
      expect(packet.quantity).toBe(quantity);
      expect(packet.sourceUnit).toBe(sourceUnit);
      expect(packet.basis).toContain("ProRes is variable bitrate");
    }
  });

  it("counts explicitly encoded payloads without presenting partial files as complete", () => {
    const image = dataReferences.references.find(reference => reference.id === "data-defined-square-rgb24-image")!;
    const only = { schemaVersion: 1, references: [image] };
    const packet = buildScenePackets({ quantity: 1.5 * 50331648, sourceUnit: "B" }, catalog, { dataReferences: only }).find(packet => packet.mechanism === "content-payload-count")!;
    expect(packet.computed.value).toBe(1.5);
    expect(packet.computed.unit).toBe("payload-equivalents");
    expect(packet.headline).toContain("times the payload");
    expect(packet.basis).toContain("do not imply fractional files are complete");
    expect(packet.sources[0].derivation).toEqual({ widthPixels: 4096, heightPixels: 4096, bitsPerPixel: 24, bitsPerByte: 8 });
    const pageOnly = { schemaVersion: 1, references: dataReferences.references.filter(reference => reference.id === "data-defined-ascii-page-2000") };
    const pages = buildScenePackets({ quantity: 100000, sourceUnit: "B" }, catalog, { dataReferences: pageOnly, scaleAnchors });
    expect(pages.some(packet => packet.mechanism === "content-payload-count")).toBe(true);
    expect(pages.some(packet => packet.mechanism === "ensemble-content-payload-count")).toBe(false);
  });

  it("rejects altered encodings and invalid bounds and never resizes media or ensembles to fill coverage", () => {
    const first = dataReferences.references[0];
    for (const altered of [{ ...first, referenceQuantity: 96000 }, { ...first, derivation: { bitsPerSecond: 96000, bitsPerByte: 7 } }, { ...first, eligibleSeconds: { min: 10, max: 1 } }, { ...first, referenceUnit: "bit/s" }, { ...first, kind: "defined-content-size", referenceUnit: "B", eligibleCount: { min: 1, max: 10 } }]) {
      expect(() => buildScenePackets({ quantity: 1, sourceUnit: "PB" }, catalog, { dataReferences: { schemaVersion: 1, references: [altered] } })).toThrow();
    }
    const tiny = buildScenePackets({ quantity: 1, sourceUnit: "B" }, catalog, { dataReferences, scaleAnchors });
    expect(tiny).toEqual([]);
    const enormous = buildScenePackets({ quantity: 1e280, sourceUnit: "PB" }, catalog, { dataReferences, scaleAnchors });
    expect(enormous).toEqual([]);
    expect(buildScenePackets({ quantity: 1, sourceUnit: "PB" }, catalog, { dataReferences: undefined, scaleAnchors: undefined })).toEqual(buildScenePackets({ quantity: 1, sourceUnit: "PB" }, catalog));
  });

  it("reproduces repeated no-history podcast choices despite six-family petabyte pools", () => {
    // R12 independently reported six offered families but podcasts on four of five
    // Flash selections. This offline replay proves the opportunity to repeat persists.
    const choices = Array.from({ length: 5 }, (_, seed) => {
      const pool = buildScenePackets({ quantity: 1, sourceUnit: "PB" }, [...catalog, ...additions], { seed, dataReferences, scaleAnchors });
      expect(new Set(pool.map(packet => packet.family)).size).toBe(6);
      return pool.find(packet => packet.family === "podcast-listening")!;
    });
    expect(choices.every(Boolean)).toBe(true);
    expect(new Set(choices.map(packet => packet.family)).size).toBe(1);
  });

  it("routes five petabyte draws to five semantic families before truncation", () => {
    const recentFamilies: string[] = [];
    const reports: FamilyRoutingReport[] = [];
    for (let seed = 0; seed < 5; seed++) {
      const [packet] = buildScenePackets({ quantity: 1, sourceUnit: "PB" }, [...catalog, ...additions], { seed, dataReferences, scaleAnchors, recentFamilies, maxPackets: 1, onFamilyRouting: report => reports.push(report) });
      expect(packet).toBeDefined();
      expect(recentFamilies).not.toContain(packet.family);
      recentFamilies.push(packet.family);
    }
    expect(new Set(recentFamilies).size).toBe(5);
    expect(reports.every(report => !report.historyExhausted)).toBe(true);
    const excluded = buildScenePackets({ quantity: 1, sourceUnit: "PB" }, [...catalog, ...additions], { seed: 17, dataReferences, scaleAnchors, recentFamilies: ["podcast-listening"] });
    expect(excluded.every(packet => packet.family !== "podcast-listening" && packet.sources[0].id !== "data-podcast-spotify-96k")).toBe(true);
    expect(new Set(excluded.map(packet => packet.sources[1]?.id).filter(Boolean)).size).toBeGreaterThan(1);
  });

  it("varies ordinary mass families and preserves the selected facts without mutation", () => {
    const history: string[] = [];
    for (let seed = 0; seed < 5; seed++) {
      const [packet] = buildScenePackets({ quantity: 60, sourceUnit: "kg" }, [...catalog, ...additions], { seed, maxPackets: 1, recentFamilies: history });
      expect(history).not.toContain(packet.family);
      history.push(packet.family);
    }
    expect(new Set(history).size).toBe(5);
    const pool = buildScenePackets({ quantity: 60, sourceUnit: "kg" }, [...catalog, ...additions]);
    const before = JSON.stringify(pool);
    const existingHistory = [pool[0].family];
    const routed = routeRecentSceneFamilies(pool, existingHistory);
    expect(JSON.stringify(pool)).toBe(before);
    expect(existingHistory).toEqual([pool[0].family]);
    for (const packet of routed.packets) expect(pool.find(original => original.id === packet.id)).toBe(packet);
  });

  it("relaxes the oldest effective exclusion on exhaustion without inventing coverage", () => {
    const baseline = buildScenePackets({ quantity: 1, sourceUnit: "PB" }, catalog);
    const onlyFamily = baseline[0].family;
    const reports: FamilyRoutingReport[] = [];
    expect(buildScenePackets({ quantity: 1, sourceUnit: "PB" }, catalog, { recentFamilies: [onlyFamily], onFamilyRouting: report => reports.push(report) })).toEqual(baseline);
    expect(reports[0]).toMatchObject({ historyExhausted: true, relaxedFamilies: [onlyFamily], excludedFamilies: [], eligiblePacketCount: 1, remainingPacketCount: 1 });
    const massPool = buildScenePackets({ quantity: 60, sourceUnit: "kg" }, [...catalog, ...additions]);
    const families = [...new Set(massPool.map(packet => packet.family))];
    const repeatedHistory = [...families, families[0]];
    const routed = routeRecentSceneFamilies(massPool, repeatedHistory);
    expect(routed.report.relaxedFamilies).toEqual([families[1]]);
    expect(routed.packets.every(packet => packet.family === families[1])).toBe(true);
    expect(routeRecentSceneFamilies([], ["podcast-listening"]).report).toMatchObject({ eligiblePacketCount: 0, remainingPacketCount: 0, historyExhausted: false, relaxedFamilies: [] });
  });

  it("validates bounded history strictly and leaves omitted or empty history identical", () => {
    const measurement = { quantity: 144, sourceUnit: "J" };
    const baseline = buildScenePackets(measurement, catalog, { seed: 9 });
    expect(buildScenePackets(measurement, catalog, { seed: 9, recentFamilies: [] })).toEqual(baseline);
    for (const invalid of [Array(9).fill("apple-device"), [""], [" apple-device"], ["x".repeat(81)], ["apple_device"], [3], null, "apple-device"]) {
      expect(() => buildScenePackets(measurement, catalog, { recentFamilies: invalid as string[] })).toThrow("invalid_recent_families");
    }
    expect(routeRecentSceneFamilies(baseline, ["unavailable-family"]).packets).toEqual(baseline);
  });

  it("rejects sparse or inherited history entries rather than skipping validation", () => {
    const inherited = new Array<string>(1);
    Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: "apple-device" }));
    for (const history of [new Array<string>(1), inherited]) {
      expect(() => routeRecentSceneFamilies([], history)).toThrow("invalid_recent_families");
    }
  });

  it("excludes the same-seed first choice before a one-packet limit", () => {
    const measurement = { quantity: 1, sourceUnit: "PB" };
    const options = { seed: 21, dataReferences, scaleAnchors, maxPackets: 1 };
    const [first] = buildScenePackets(measurement, [...catalog, ...additions], options);
    const history = Object.freeze([first.family]);
    const reports: FamilyRoutingReport[] = [];
    const [next] = buildScenePackets(measurement, [...catalog, ...additions], { ...options, recentFamilies: history as unknown as string[], onFamilyRouting: report => reports.push(report) });
    expect(next.family).not.toBe(first.family);
    expect(reports[0].historyExhausted).toBe(false);
    expect(history).toEqual([first.family]);
    expect(routeRecentSceneFamilies([first], ["constructor"]).packets).toEqual([first]);
    expect(() => routeRecentSceneFamilies([first], ["__proto__"])).toThrow("invalid_recent_families");
  });
});
