import { describe, expect, it } from "vitest";
import catalog from "../evals/grounded-references.json";
import additions from "../evals/scene-reference-additions.json";
import scaleAnchors from "../evals/scene-scale-anchors.json";
import dataReferences from "../evals/scene-data-reference-proposals.json";
import { buildScenePackets } from "../src/lib/scene-packets";
import { displayHeadlineForScene, withSceneDisplay } from "../src/lib/scene-display";

const all = [...catalog, ...additions];
function subset(...ids: string[]) { return all.filter(fact => ids.includes(fact.id)); }

describe("concise trusted scene presentation", () => {
  it("makes mass and volume references readable without claiming contents or physical packing", () => {
    const mass = buildScenePackets({ quantity: 23, sourceUnit: "kg" }, subset("mass-switch-2"))[0];
    const before = JSON.stringify(mass);
    expect(displayHeadlineForScene(mass)).toBe("About 43 Nintendo Switch 2 consoles by weight");
    expect(mass.computed.value).toBeCloseTo(23 / 0.534, 10);
    expect(mass.basis).toContain(subset("mass-switch-2")[0].assumption);
    expect(JSON.stringify(mass)).toBe(before);
    const volume = buildScenePackets({ quantity: 8500, sourceUnit: "L" }, subset("volume-schaefer-keg-50l"))[0];
    expect(displayHeadlineForScene(volume)).toBe("About 170 beer kegs' worth by volume");
    expect(volume.basis).toContain(subset("volume-schaefer-keg-50l")[0].assumption);
    const single = buildScenePackets({ quantity: 40, sourceUnit: "kg" }, subset("mass-parmigiano-wheel"))[0];
    expect(displayHeadlineForScene(single)).toBe("About 1 Parmesan wheel by weight");
    expect(displayHeadlineForScene({ ...mass, computed: { ...mass.computed, unit: "s" } })).toBe(mass.headline);
  });
  it("uses the exact computed speed with concise nouns while retaining the particular object's factual basis", () => {
    const cheese = additions.find(fact => fact.id === "mass-parmigiano-wheel")!;
    const energy = 0.5 * cheese.referenceQuantity * (6 * 0.44704) ** 2;
    const packet = buildScenePackets({ quantity: energy, sourceUnit: "J" }, [cheese]).find(packet => packet.mechanism === "launch-object")!;
    const before = JSON.stringify(packet);
    const display = withSceneDisplay(packet);
    expect(display.displayHeadline).toBe("Imagine a wheel of Parmesan moving at about 6 mph");
    expect(display.basis).toContain(cheese.assumption);
    expect(display.basis).toContain("not a claim the object survives");
    expect(display.headline).toBe(packet.headline);
    expect(display.sources).toBe(packet.sources);
    expect(display.computed).toBe(packet.computed);
    expect(JSON.stringify(packet)).toBe(before);
    const mouse = buildScenePackets({ quantity: 144, sourceUnit: "J" }, subset("mass-g502-hero")).find(packet => packet.mechanism === "launch-object")!;
    expect(displayHeadlineForScene(mouse)).toMatch(/^Imagine a gaming mouse moving at about [\d,.]+ mph$/);
    expect(mouse.basis).toContain("Logitech G502 HERO");
    const towerAnchor = scaleAnchors.anchors.find(anchor => anchor.id === "mass-eiffel-tower-total")!;
    const tower = buildScenePackets({ quantity: 1e12, sourceUnit: "J" }, catalog, { scaleAnchors: { schemaVersion: 1, anchors: [towerAnchor] } }).find(packet => packet.mechanism === "launch-object" && packet.sources[0].id === towerAnchor.id)!;
    expect(displayHeadlineForScene(tower)).toBe("Imagine the Eiffel Tower moving at about 995 mph");
    expect(tower.basis).toContain("entire reported mass moving together");
  });

  it("separates upward lifting from the landmark's actual length or overall height", () => {
    const dippy = buildScenePackets({ quantity: 144, sourceUnit: "J" }, subset("mass-iphone-17", "length-dippy-replica")).find(packet => packet.mechanism === "lift-object")!;
    const before = JSON.stringify(dippy);
    const display = withSceneDisplay(dippy);
    expect(display.displayHeadline).toBe("Lift an iPhone 17 straight up by about 3.19 times the Dippy replica's head-to-tail length");
    expect(display.basis).toContain("this is the exhibit, not an average living dinosaur");
    expect(display.basis).toContain("ignoring losses and changes in gravity");
    expect(display.headline).toBe(dippy.headline);
    expect(display.sources).toBe(dippy.sources);
    expect(display.computed).toBe(dippy.computed);
    expect(JSON.stringify(dippy)).toBe(before);
    const tower = buildScenePackets({ quantity: 144, sourceUnit: "J" }, subset("mass-g502-hero", "length-eiffel-current-height")).find(packet => packet.mechanism === "lift-object")!;
    expect(displayHeadlineForScene(tower)).toBe("Lift a gaming mouse straight up by about 0.368 times the Eiffel Tower's overall height (including its antenna)");
    expect(tower.basis).toContain("without its optional tuning weights");
    expect(tower.basis).toContain("330 m, including its antenna");
  });

  it("keeps lift headlines when a reference or usable comparison ratio is missing", () => {
    const packet = buildScenePackets({ quantity: 144, sourceUnit: "J" }, subset("mass-iphone-17", "length-dippy-replica")).find(packet => packet.mechanism === "lift-object")!;
    for (const index of [0, 1]) {
      const sources = packet.sources.map((source, i) => i === index ? { ...source, id: "unknown-reference" } : source);
      expect(displayHeadlineForScene({ ...packet, sources })).toBe(packet.headline);
    }
    for (const comparisonRatio of [undefined, 0, -1, NaN, Infinity]) {
      expect(displayHeadlineForScene({ ...packet, computed: { ...packet.computed, comparisonRatio } })).toBe(packet.headline);
    }
    expect(displayHeadlineForScene({ ...packet, computed: { ...packet.computed, unit: "m/s" } })).toBe(packet.headline);
  });

  it("shortens fixed-ensemble scenes without losing configuration qualifications or sources", () => {
    const hairdryer = subset("power-dyson-supersonic");
    const wembley = scaleAnchors.anchors.find(anchor => anchor.id === "ensemble-wembley-seats")!;
    const packet = buildScenePackets({ quantity: 1e12, sourceUnit: "J" }, hairdryer, { scaleAnchors: { schemaVersion: 1, anchors: [wembley] } }).find(packet => packet.mechanism === "ensemble-appliance")!;
    expect(displayHeadlineForScene(packet)).toBe("A hairdryer at every Wembley seat for 1.93 hours");
    expect(packet.basis).toContain("does not describe attendance");
    expect(packet.basis).toContain("not a claim that devices can operate continuously");
    for (const [id, required] of [["ensemble-a380-certified-seats", "853 maximum certified passenger places"], ["ensemble-opera-house-concert-hall", "in-the-round"], ["ensemble-london-eye-passenger-places", "800 passenger places"]]) {
      const anchor = scaleAnchors.anchors.find(anchor => anchor.id === id)!;
      const candidate = buildScenePackets({ quantity: 1e12, sourceUnit: "J" }, hairdryer, { scaleAnchors: { schemaVersion: 1, anchors: [anchor] } }).find(packet => packet.mechanism === "ensemble-appliance")!;
      expect(displayHeadlineForScene(candidate)).toContain(required);
    }
  });

  it("renders a depth without inventing water or another material", () => {
    const tennis = additions.find(fact => fact.id === "area-doubles-tennis-court")!;
    const packet = buildScenePackets({ quantity: tennis.referenceQuantity * 18.9 * 0.3048, sourceUnit: "m^3" }, [tennis])[0];
    expect(displayHeadlineForScene(packet)).toBe("A layer 18.9 feet deep over a doubles tennis court");
    expect(displayHeadlineForScene(packet)).not.toContain("water");
    expect(withSceneDisplay(packet).basis).toContain("ignores terrain, drainage and containment");
  });

  it("uses reviewed object labels and preserves fallback for missing labels, unsupported mechanisms, mismatched units and zero", () => {
    const packet = buildScenePackets({ quantity: 144, sourceUnit: "J" }, subset("mass-g502-hero"))[0];
    expect(displayHeadlineForScene({ ...packet, sources: [{ ...packet.sources[0], id: "mass-new-object" }] })).toBe("Imagine an unweighted Logitech G502 HERO mouse moving at about 109 mph");
    expect(displayHeadlineForScene({ ...packet, sources: [{ ...packet.sources[0], id: "mass-unknown", singularLabel: undefined }] })).toBe(packet.headline);
    expect(displayHeadlineForScene({ ...packet, computed: { ...packet.computed, unit: "mph" } })).toBe(packet.headline);
    expect(displayHeadlineForScene({ ...packet, computed: { ...packet.computed, value: 0 } })).toBe(packet.headline);
    const pressure = buildScenePackets({ quantity: 900000, sourceUnit: "Pa" }, subset("pressure-espresso-extraction"))[0];
    expect(displayHeadlineForScene(pressure)).toBe(pressure.headline);
  });

  it("makes the allocation readable while keeping its exact encoding in the displayed basis", () => {
    const onlyWembley = { schemaVersion: 1, anchors: scaleAnchors.anchors.filter(anchor => anchor.id === "ensemble-wembley-seats") };
    const onlyPodcast = { schemaVersion: 1, references: dataReferences.references.filter(reference => reference.id === "data-podcast-spotify-96k") };
    const packet = buildScenePackets({ quantity: 1, sourceUnit: "PB" }, catalog, { dataReferences: onlyPodcast, scaleAnchors: onlyWembley }).find(packet => packet.mechanism === "ensemble-media-duration")!;
    const before = JSON.stringify(packet);
    const display = withSceneDisplay(packet);
    expect(display.displayHeadline).toBe("Imagine every Wembley seat with its own 10.7 days of podcast audio");
    expect(packet.basis).toContain("Never multiply a single shared file by its audience");
    expect(packet.basis).toContain("not a universal podcast bitrate");
    expect(display.basis).toContain("96,000-bit/s");
    expect(display.basis).toBe(packet.basis);
    expect(display.computed).toBe(packet.computed);
    expect(display.sources).toBe(packet.sources);
    expect(display.headline).toBe(packet.headline);
    expect(JSON.stringify(packet)).toBe(before);
    const onlyImage = { schemaVersion: 1, references: dataReferences.references.filter(reference => reference.id === "data-defined-square-rgb24-image") };
    const image = buildScenePackets({ quantity: 1.5 * 50331648, sourceUnit: "B" }, catalog, { dataReferences: onlyImage }).find(packet => packet.mechanism === "content-payload-count")!;
    expect(displayHeadlineForScene(image)).toBe("About 1.5 uncompressed 4096-by-4096 RGB picture payloads");
    expect(withSceneDisplay(image).basis).toContain("do not imply fractional files are complete");
  });

  it.each([
    ["data-prores-422hq-uhd-24p", "ensemble-wembley-seats", "Imagine every Wembley seat with its own 2.1 minutes of 4K editing footage", "707-Mbit/s"],
    ["data-stereo-pcm-44100-16", "ensemble-london-eye-passenger-places", "Imagine each of the London Eye's 800 passenger places with its own 82 days of uncompressed stereo audio", "44.1-kHz 16-bit PCM"],
    ["data-ursa-cine-12k-raw3to1-24fps", "", "Storage for about 9.69 days of 12K cinema footage", "Blackmagic RAW 3:1"]
  ])("keeps the source settings of %s without crowding the headline", (referenceId, anchorId, expected, encoding) => {
    const references = dataReferences.references.filter(reference => reference.id === referenceId);
    const anchors = scaleAnchors.anchors.filter(anchor => anchor.id === anchorId);
    const packet = buildScenePackets({ quantity: 1, sourceUnit: "PB" }, catalog, {
      dataReferences: { schemaVersion: 1, references }, scaleAnchors: { schemaVersion: 1, anchors }
    }).find(packet => packet.mechanism === (anchorId ? "ensemble-media-duration" : "media-duration"))!;
    const before = JSON.stringify(packet);
    const display = withSceneDisplay(packet);
    expect(display.displayHeadline).toBe(expected);
    expect(display.basis).toBe(packet.basis);
    expect(display.basis).toContain(encoding);
    expect(display.basis).toContain("not human attention");
    expect(display.computed).toBe(packet.computed);
    expect(display.sources).toBe(packet.sources);
    expect(JSON.stringify(packet)).toBe(before);
  });

  it("leaves media with unknown sources or mismatched units in its original form", () => {
    const packet = buildScenePackets({ quantity: 1, sourceUnit: "PB" }, catalog, {
      dataReferences, scaleAnchors: { schemaVersion: 1, anchors: scaleAnchors.anchors.filter(anchor => anchor.id === "ensemble-wembley-seats") }
    }).find(packet => packet.mechanism === "ensemble-media-duration")!;
    for (const index of [0, 1]) {
      const sources = packet.sources.map((source, i) => i === index ? { ...source, id: "unknown-reference" } : source);
      expect(displayHeadlineForScene({ ...packet, sources })).toBe(packet.headline);
    }
    expect(displayHeadlineForScene({ ...packet, computed: { ...packet.computed, unit: "payload-equivalents" } })).toBe(packet.headline);
  });
});
