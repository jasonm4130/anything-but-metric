import { unit } from "mathjs";
import { conversionFromChoice, formatNumber, validateMeasurement, type ModelChoice } from "./convert";
import { validateGroundedCatalog, type GroundedReference } from "./grounded-flow";

/** Every number and physical assertion in a packet is owned by code/catalog. */
export type SceneRole = "object" | "power-consumer" | "power-generator" | "area";
export type SceneSource = { id: string; url: string; note: string; quantity: number; unit: string; assumption: string; singularLabel?: string; scenarioRole?: SceneRole; fictionFrame?: string; evidenceType?: string; derivation?: Record<string, number> };
type Fact = GroundedReference & { source: SceneSource; dimension: string; si: number; singularLabel?: string; scenarioRole?: SceneRole; sceneFamily?: string; fictionFrame?: string };
export type ScenePacket = {
  id: string;
  family: string;
  mechanism: string;
  headline: string;
  basis: string;
  quantity: number;
  sourceUnit: string;
  computed: { value: number; unit: string; formula: string; operands: Record<string, number>; displayValue: string; comparisonRatio?: number };
  sources: SceneSource[];
  salienceBounds?: { min: number; max: number };
};
export type FamilyRoutingReport = {
  requestedFamilies: string[];
  excludedFamilies: string[];
  relaxedFamilies: string[];
  eligibleFamilies: string[];
  eligiblePacketCount: number;
  remainingPacketCount: number;
  historyExhausted: boolean;
};
export type ScenePacketOptions = { seed?: number; draw?: () => number; maxPackets?: number; scaleAnchors?: unknown; dataReferences?: unknown; recentFamilies?: string[]; onFamilyRouting?: (report: FamilyRoutingReport) => void };
export const recentFamilyLimit = 8;

/** Input packets have already passed arithmetic and salience checks. History is oldest first. */
export function routeRecentSceneFamilies<T extends { family: string }>(packets: T[], recentFamilies: string[] = []): { packets: T[]; report: FamilyRoutingReport } {
  if (!Array.isArray(recentFamilies) || recentFamilies.length > recentFamilyLimit) throw new Error("invalid_recent_families");
  const history: string[] = [];
  for (let index = 0; index < recentFamilies.length; index++) {
    if (!Object.hasOwn(recentFamilies, index)) throw new Error("invalid_recent_families");
    const family = recentFamilies[index];
    if (typeof family !== "string" || family.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(family)) throw new Error("invalid_recent_families");
    history.push(family);
  }
  const eligibleFamilies = [...new Set(packets.map(packet => packet.family))];
  // Keep the most recent occurrence when a family appears more than once in history.
  const excludedFamilies = history.filter((family, index) => history.lastIndexOf(family) === index && eligibleFamilies.includes(family));
  const relaxedFamilies: string[] = [];
  let remaining = packets.filter(packet => !excludedFamilies.includes(packet.family));
  while (packets.length && !remaining.length && excludedFamilies.length) {
    relaxedFamilies.push(excludedFamilies.shift()!);
    remaining = packets.filter(packet => !excludedFamilies.includes(packet.family));
  }
  return { packets: remaining, report: { requestedFamilies: history, excludedFamilies: [...excludedFamilies], relaxedFamilies, eligibleFamilies, eligiblePacketCount: packets.length, remainingPacketCount: remaining.length, historyExhausted: relaxedFamilies.length > 0 } };
}
const gravity = 9.80665;
const lightSpeed = 299792458;
const gravitySource: SceneSource = { id: "constant-standard-gravity", url: "https://www.bipm.org/en/publications/si-brochure", note: "Conventional standard acceleration of free fall, not a measurement of gravity at a particular location.", quantity: gravity, unit: "m/s^2", assumption: "Use conventional standard gravity, 9.80665 m/s²." };
// These limits are conservative scene policies, not new facts about an object.
export const sceneLimits = { maxLiftMetres: 1000, maxLayerMetres: 100, maxKineticSpeed: 1000, maxRelativisticFraction: 0.01 } as const;
// Readability admission is distinct from arithmetic validity. A coverage gap returns no packets.
export const sceneSaliencePolicy = { minRatio: 0.1, maxRatio: 1000, minDurationSeconds: 0.1, maxDurationSeconds: 20 * 31557600, minLiftMetres: 0.01, minLandmarkMetres: 0.01, maxLandmarkRatio: 100, minSpeedMph: 0.1, minLayerInches: 0.01 } as const;
export function isSalientScenePacket(packet: ScenePacket): boolean {
  const { value, unit: resultUnit, comparisonRatio, operands } = packet.computed;
  if (packet.mechanism === "direct" && (packet.quantity === 0 || resultUnit === "delta_degF")) return true;
  if (packet.mechanism === "direct" || packet.mechanism === "support-weight") return value >= sceneSaliencePolicy.minRatio && value <= sceneSaliencePolicy.maxRatio;
  if (["run-appliance", "generate-energy", "travel-time", "ensemble-appliance"].includes(packet.mechanism)) return value >= sceneSaliencePolicy.minDurationSeconds && value <= sceneSaliencePolicy.maxDurationSeconds;
  if (packet.mechanism === "lift-object") return value >= sceneSaliencePolicy.minLiftMetres && operands.landmark_m >= sceneSaliencePolicy.minLandmarkMetres && comparisonRatio !== undefined && comparisonRatio >= sceneSaliencePolicy.minRatio && comparisonRatio <= sceneSaliencePolicy.maxLandmarkRatio;
  if (packet.mechanism === "launch-object") return value / 0.44704 >= sceneSaliencePolicy.minSpeedMph;
  if (packet.mechanism === "flood-area") return value / 0.0254 >= sceneSaliencePolicy.minLayerInches;
  if (["media-duration", "content-payload-count", "ensemble-media-duration", "ensemble-content-payload-count"].includes(packet.mechanism)) return packet.salienceBounds !== undefined && value >= packet.salienceBounds.min && value <= packet.salienceBounds.max;
  return false;
}
const singular: Record<string, string> = {
  "mass-iphone-17": "an iPhone 17", "mass-iss": "the International Space Station",
  "power-apple-adapter": "an Apple 70-watt adapter", "power-defined-led": "a 10-watt LED bulb", "power-hoover": "Hoover Dam at nameplate capacity",
  "area-fifa-pitch": "a FIFA-recommended football pitch", "area-fiba-court": "a FIBA basketball court", "area-brunei": "Brunei",
};
function family(id: string): string {
  if (/iphone|apple-adapter/.test(id)) return "apple-device";
  if (/iss/.test(id)) return "space-station";
  if (/fifa|football|soccer/.test(id)) return "football";
  if (/earth/.test(id)) return "earth";
  if (/hoover/.test(id)) return "hoover-dam";
  return id.replace(/^[^-]+-/, "");
}
function seededDraw(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state += 0x6D2B79F5; let t = Math.imul(state ^ state >>> 15, 1 | state); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function shuffle<T>(values: T[], draw: () => number): T[] {
  const shuffled = [...values];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const value = draw();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error("invalid_scene_draw");
    const j = Math.floor(value * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}
function natural(value: number, kind: "time" | "length" | "speed"): { value: number; unit: string; text: string } {
  const choices: [number, string][] = kind === "time"
    ? [[31557600, "years"], [86400, "days"], [3600, "hours"], [60, "minutes"], [1, "seconds"]]
    : kind === "length" ? [[1609.344, "miles"], [0.3048, "feet"], [0.0254, "inches"]] : [[0.44704, "mph"]];
  const [factor, label] = choices.find(([scale]) => value >= scale) ?? choices[choices.length - 1];
  const amount = value / factor;
  const display = formatNumber(amount);
  const singularUnits: Record<string, string> = { years: "year", days: "day", hours: "hour", minutes: "minute", seconds: "second", miles: "mile", feet: "foot", inches: "inch" };
  return { value: amount, unit: label, text: `${display} ${display === "1" ? singularUnits[label] ?? label : label}` };
}
function factsFrom(catalog: unknown): Fact[] {
  const validated = validateGroundedCatalog(catalog);
  return validated.map((fact, index) => {
    const raw = (catalog as Record<string, unknown>[])[index];
    if (typeof raw.sourceUrl !== "string" || !/^https:\/\//.test(raw.sourceUrl) || typeof raw.sourceNote !== "string" || !raw.sourceNote.trim()) throw new Error("missing_scene_provenance");
    const measurement = validateMeasurement(fact.referenceQuantity, fact.referenceUnit);
    if (raw.singularLabel !== undefined && (typeof raw.singularLabel !== "string" || !raw.singularLabel.trim() || raw.singularLabel.length > 160)) throw new Error("invalid_scene_metadata");
    const roleDimensions: Record<SceneRole, string> = { object: "mass", "power-consumer": "power", "power-generator": "power", area: "area" };
    if (raw.scenarioRole !== undefined && (typeof raw.scenarioRole !== "string" || !Object.hasOwn(roleDimensions, raw.scenarioRole) || roleDimensions[raw.scenarioRole as SceneRole] !== measurement.dimension)) throw new Error("invalid_scene_metadata");
    const singularLabel = typeof raw.singularLabel === "string" ? raw.singularLabel.trim() : singular[fact.id];
    const defaultRole: SceneRole | undefined = singular[fact.id] ? (measurement.dimension === "mass" ? "object" : measurement.dimension === "area" ? "area" : fact.id === "power-hoover" ? "power-generator" : "power-consumer") : undefined;
    const scenarioRole = raw.scenarioRole as SceneRole | undefined ?? defaultRole;
    if (raw.family !== undefined && (typeof raw.family !== "string" || raw.family.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw.family))) throw new Error("invalid_scene_family");
    const metadata = { ...(singularLabel ? { singularLabel } : {}), ...(scenarioRole ? { scenarioRole } : {}) };
    return { ...fact, ...metadata, dimension: measurement.dimension, ...(typeof raw.family === "string" ? { sceneFamily: raw.family } : {}), si: unit(fact.referenceQuantity, measurement.sourceUnit).toSI().value, source: { id: fact.id, url: raw.sourceUrl, note: raw.sourceNote, quantity: fact.referenceQuantity, unit: measurement.sourceUnit, assumption: fact.assumption, ...metadata } };
  });
}

function scaleFactsFrom(bundle: unknown): { ensembles: Fact[]; masses: Fact[] } {
  if (bundle === undefined) return { ensembles: [], masses: [] };
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) throw new Error("invalid_scale_anchors");
  const input = bundle as { schemaVersion?: unknown; anchors?: unknown };
  if (input.schemaVersion !== 1 || !Array.isArray(input.anchors)) throw new Error("invalid_scale_anchors");
  const ensembles: Fact[] = [];
  const masses: Fact[] = [];
  const ids = new Set<string>();
  for (const raw of input.anchors) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_scale_anchors");
    const row = raw as Record<string, unknown>;
    // Thermal properties are deliberately not consumed: point properties alone do not
    // establish an accuracy bound over a proposed temperature interval.
    if (row.kind === "volume-anchor") continue;
    if (row.kind !== "ensemble-count" && row.kind !== "mass-anchor") throw new Error("invalid_scale_anchors");
    for (const key of ["id", "referenceUnit", "referenceLabel", "family", "fictionFrame", "assumption", "sourceUrl", "sourceNote"] as const) {
      if (typeof row[key] !== "string" || !row[key].trim() || row[key].length > 1000) throw new Error("invalid_scale_anchors");
    }
    if (ids.has(row.id as string) || !(row.sourceUrl as string).startsWith("https://")) throw new Error("invalid_scale_anchors");
    ids.add(row.id as string);
    if (typeof row.referenceQuantity !== "number" || !Number.isFinite(row.referenceQuantity) || row.referenceQuantity <= 0) throw new Error("invalid_scale_anchors");
    const fictionFrame = row.fictionFrame as string;
    const sceneFamily = row.family as string;
    if (row.kind === "mass-anchor") {
      const [mass] = factsFrom([{ ...row, scenarioRole: "object" }]);
      if (mass.dimension !== "mass" || !mass.singularLabel) throw new Error("invalid_scale_anchors");
      masses.push({ ...mass, fictionFrame, sceneFamily, source: { ...mass.source, fictionFrame } });
      continue;
    }
    if (!Number.isSafeInteger(row.referenceQuantity) || typeof row.countedEntity !== "string" || !row.countedEntity.trim()) throw new Error("invalid_scale_anchors");
    if (row.derivation !== undefined) {
      const derivation = row.derivation as Record<string, unknown>;
      if (!derivation || typeof derivation !== "object" || Array.isArray(derivation) || derivation.operation !== "multiply" || !Number.isSafeInteger(derivation.capsules) || !Number.isSafeInteger(derivation.placesPerCapsule) || (derivation.capsules as number) <= 0 || (derivation.placesPerCapsule as number) <= 0 || (derivation.capsules as number) * (derivation.placesPerCapsule as number) !== row.referenceQuantity) throw new Error("invalid_scale_derivation");
    }
    const reference = { id: row.id as string, referenceQuantity: row.referenceQuantity, referenceUnit: row.referenceUnit as string, referenceLabel: row.referenceLabel as string, assumption: row.assumption as string };
    ensembles.push({ ...reference, dimension: "count", si: reference.referenceQuantity, fictionFrame, sceneFamily, source: { id: reference.id, quantity: reference.referenceQuantity, unit: reference.referenceUnit, assumption: reference.assumption, url: row.sourceUrl as string, note: row.sourceNote as string, fictionFrame } });
  }
  return { ensembles, masses };
}

type DataFact = Fact & { kind: "media-rate" | "defined-content-size"; bounds: { min: number; max: number }; allowFixedEnsemble: boolean };
function dataFactsFrom(bundle: unknown): DataFact[] {
  if (bundle === undefined) return [];
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) throw new Error("invalid_data_references");
  const input = bundle as { schemaVersion?: unknown; references?: unknown };
  if (input.schemaVersion !== 1 || !Array.isArray(input.references)) throw new Error("invalid_data_references");
  const ids = new Set<string>();
  return input.references.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_data_references");
    const row = raw as Record<string, unknown>;
    if (row.kind !== "media-rate" && row.kind !== "defined-content-size") throw new Error("invalid_data_references");
    for (const key of ["id", "family", "referenceLabel", "assumption", "fictionFrame", "sourceUrl", "sourceNote", "evidenceType"] as const) {
      if (typeof row[key] !== "string" || !row[key].trim() || row[key].length > 2000) throw new Error("invalid_data_references");
    }
    if (ids.has(row.id as string) || !(row.sourceUrl as string).startsWith("https://")) throw new Error("invalid_data_references");
    ids.add(row.id as string);
    if (row.referenceUnit !== (row.kind === "media-rate" ? "B/s" : "B") || typeof row.referenceQuantity !== "number" || !Number.isFinite(row.referenceQuantity) || row.referenceQuantity <= 0 || typeof row.allowFixedEnsemble !== "boolean") throw new Error("invalid_data_references");
    const bounds = row[row.kind === "media-rate" ? "eligibleSeconds" : "eligibleCount"] as { min?: unknown; max?: unknown };
    if (!bounds || typeof bounds !== "object" || Array.isArray(bounds) || typeof bounds.min !== "number" || typeof bounds.max !== "number" || !Number.isFinite(bounds.min) || !Number.isFinite(bounds.max) || bounds.min <= 0 || bounds.max < bounds.min) throw new Error("invalid_data_bounds");
    const derivation = row.derivation as Record<string, number>;
    if (!derivation || typeof derivation !== "object" || Array.isArray(derivation) || Object.values(derivation).some(value => typeof value !== "number" || !Number.isFinite(value) || value <= 0)) throw new Error("invalid_data_derivation");
    const matches = (...keys: string[]) => Object.keys(derivation).length === keys.length && keys.every(key => Object.hasOwn(derivation, key));
    let derived: number;
    if (row.kind === "media-rate" && matches("bitsPerSecond", "bitsPerByte") && derivation.bitsPerByte === 8) derived = derivation.bitsPerSecond / 8;
    else if (row.kind === "media-rate" && matches("samplesPerSecondPerChannel", "bitsPerSample", "channels", "bitsPerByte") && derivation.bitsPerByte === 8) derived = derivation.samplesPerSecondPerChannel * derivation.bitsPerSample * derivation.channels / 8;
    else if (row.kind === "media-rate" && matches("targetMegabitsPerSecond", "bitsPerMegabit", "bitsPerByte") && derivation.bitsPerMegabit === 1000000 && derivation.bitsPerByte === 8) derived = derivation.targetMegabitsPerSecond * 1000000 / 8;
    else if (row.kind === "media-rate" && matches("publishedMegabytesPerSecond", "decimalBytesPerMegabyte") && derivation.decimalBytesPerMegabyte === 1000000) derived = derivation.publishedMegabytesPerSecond * 1000000;
    else if (row.kind === "defined-content-size" && matches("asciiCharactersIncludingWhitespace", "bytesPerAsciiCharacterInUtf8") && derivation.bytesPerAsciiCharacterInUtf8 === 1) derived = derivation.asciiCharactersIncludingWhitespace;
    else if (row.kind === "defined-content-size" && matches("widthPixels", "heightPixels", "bitsPerPixel", "bitsPerByte") && derivation.bitsPerByte === 8) derived = derivation.widthPixels * derivation.heightPixels * derivation.bitsPerPixel / 8;
    else throw new Error("invalid_data_derivation");
    if (!Number.isFinite(derived) || derived !== row.referenceQuantity) throw new Error("invalid_data_derivation");
    const reference = { id: row.id as string, referenceQuantity: row.referenceQuantity, referenceUnit: row.referenceUnit as string, referenceLabel: row.referenceLabel as string, assumption: row.assumption as string };
    const fictionFrame = row.fictionFrame as string;
    return { ...reference, dimension: row.kind === "media-rate" ? "data-rate" : "data", si: row.referenceQuantity, kind: row.kind, sceneFamily: row.family as string, fictionFrame, bounds: { min: bounds.min, max: bounds.max }, allowFixedEnsemble: row.allowFixedEnsemble,
      source: { id: reference.id, quantity: reference.referenceQuantity, unit: reference.referenceUnit, assumption: reference.assumption, url: row.sourceUrl as string, note: row.sourceNote as string, fictionFrame, evidenceType: row.evidenceType as string, derivation: { ...derivation } } };
  });
}

export function createScenePoolBuilder(catalog: unknown, configuration: Pick<ScenePacketOptions, "scaleAnchors" | "dataReferences"> = {}) {
  const facts = factsFrom(catalog);
  const scaleFacts = scaleFactsFrom(configuration.scaleAnchors);
  const dataFacts = dataFactsFrom(configuration.dataReferences);
  if ([...scaleFacts.ensembles, ...scaleFacts.masses].some(anchor => facts.some(fact => fact.id === anchor.id))) throw new Error("duplicate_scene_anchor");
  if (dataFacts.some(data => [...facts, ...scaleFacts.ensembles, ...scaleFacts.masses].some(fact => fact.id === data.id))) throw new Error("duplicate_data_reference");
  return (measurement: Pick<ModelChoice, "quantity" | "sourceUnit">): ScenePacket[] => {
  const source = validateMeasurement(measurement.quantity, measurement.sourceUnit);
  const sourceSI = unit(source.quantity, source.sourceUnit).toSI().value;
  const packets: ScenePacket[] = [];
  function add(mechanism: string, refs: Fact[], headline: string, basis: string, value: number, resultUnit: string, formula: string, operands: Record<string, number>, comparisonRatio?: number, usesGravity = false, salienceBounds?: { min: number; max: number }) {
    if (!Number.isFinite(value) || value < 0 || (value === 0 && source.quantity !== 0 && source.dimension !== "temperature")) return;
    if (Object.values(operands).some(operand => !Number.isFinite(operand)) || (comparisonRatio !== undefined && (!Number.isFinite(comparisonRatio) || comparisonRatio <= 0))) return;
    packets.push({ id: `${mechanism}:${refs.map(ref => ref.id).join("+")}`, family: refs[0].sceneFamily ?? family(refs[0].id), mechanism, headline, basis, quantity: source.quantity, sourceUnit: source.sourceUnit,
      computed: { value, unit: resultUnit, formula, operands, displayValue: formatNumber(value), ...(comparisonRatio !== undefined ? { comparisonRatio } : {}) },
      sources: [...refs.map(ref => ({ ...ref.source })), ...(usesGravity ? [{ ...gravitySource }] : [])], ...(salienceBounds ? { salienceBounds: { ...salienceBounds } } : {}) });
  }
  for (const fact of facts.filter(fact => fact.dimension === source.dimension)) {
    let converted;
    try { converted = conversionFromChoice({ ...fact, quantity: source.quantity, sourceUnit: source.sourceUnit }); }
    catch { continue; } // A ratio can overflow even when the source and other packets remain valid.
    const intensive = ["pressure", "speed", "frequency"].includes(source.dimension) || (source.dimension === "power" && /^the /i.test(fact.referenceLabel));
    const headline = intensive ? `About ${converted.displayValue} times ${fact.referenceLabel}` : converted.headline;
    add("direct", [fact], headline, converted.assumption, converted.value, source.dimension === "temperature" ? "delta_degF" : "ratio", source.dimension === "temperature" ? "abs(source_degF - reference_degF)" : "source_si / reference_si", source.dimension === "temperature" ? { source_degF: unit(source.quantity, source.sourceUnit).toNumber("degF"), reference_degF: unit(fact.referenceQuantity, fact.referenceUnit).toNumber("degF") } : { source_si: sourceSI, reference_si: fact.si });
  }
  if (source.quantity > 0 && source.dimension !== "temperature") {
    const masses = [...facts.filter(fact => fact.dimension === "mass" && fact.singularLabel && fact.scenarioRole === "object"), ...scaleFacts.masses];
    if (source.dimension === "energy") {
      for (const power of facts.filter(fact => fact.dimension === "power" && fact.singularLabel && (fact.scenarioRole === "power-consumer" || fact.scenarioRole === "power-generator"))) {
        const seconds = sourceSI / power.si;
        const display = natural(seconds, "time");
        const generating = power.scenarioRole === "power-generator";
        const headline = generating ? `The energy ${power.singularLabel} would generate in about ${display.text}` : `Enough energy to run ${power.singularLabel} for about ${display.text}`;
        add(generating ? "generate-energy" : "run-appliance", [power], headline, `Assuming the stated ${generating ? "output" : "power"} stays constant, with no conversion losses. ${power.assumption} Duration = energy / power.`, seconds, "s", "energy_j / power_w", { energy_j: sourceSI, power_w: power.si });
        if (!generating) for (const ensemble of scaleFacts.ensembles) {
          const totalPower = ensemble.si * power.si;
          if (!Number.isFinite(totalPower) || totalPower <= 0) continue;
          const duration = sourceSI / totalPower;
          // Remove only redundant display qualifiers; exact source assumptions survive below.
          const appliance = power.singularLabel!.replace(/ at its rated power$/, "");
          const ensembleHeadline = `Imagine ${appliance} for each of ${ensemble.referenceLabel}: about ${natural(duration, "time").text} of equivalent continuous draw`;
          const basis = `${ensemble.fictionFrame} ${ensemble.assumption} ${power.assumption} Assume every appliance draws the stated power continuously, with no conversion losses. This is an energy equivalence, not a claim that devices can operate continuously or the venue can supply the load. Duration = energy / (fixed count × appliance power).`;
          add("ensemble-appliance", [ensemble, power], ensembleHeadline, basis, duration, "s", "energy_j / (fixed_count * power_w)", { energy_j: sourceSI, fixed_count: ensemble.si, power_w: power.si, ensemble_power_w: totalPower });
        }
      }
      for (const mass of masses) {
        const height = sourceSI / (mass.si * gravity);
        if (height > 0 && height <= sceneLimits.maxLiftMetres) {
          const lengths = facts.filter(fact => fact.dimension === "length" && height / fact.si >= 0.1 && height / fact.si <= 1000);
          for (const length of lengths) add("lift-object", [mass, length], `Enough energy to lift ${mass.singularLabel} about ${formatNumber(height / length.si)} ${length.referenceLabel} straight up`, `Ideal lifting near Earth's surface at standard gravity, ignoring losses and changes in gravity. ${mass.assumption} ${length.assumption}`, height, "m", "energy_j / (mass_kg * gravity_m_s2)", { energy_j: sourceSI, mass_kg: mass.si, gravity_m_s2: gravity, landmark_m: length.si }, height / length.si, true);
        }
        const speed = Math.sqrt(2 * (sourceSI / mass.si));
        if (speed > 0 && speed <= sceneLimits.maxKineticSpeed && speed < lightSpeed * sceneLimits.maxRelativisticFraction) {
          const display = natural(speed, "speed");
          add("launch-object", [mass], `Enough kinetic energy for ${mass.singularLabel} moving at about ${display.text}`, `${mass.fictionFrame ? `${mass.fictionFrame} ` : ""}An ideal energy equivalence, not a claim the object survives: from rest, no drag, no losses, nonrelativistic motion. ${mass.assumption}`, speed, "m/s", "sqrt(2 * energy_j / mass_kg)", { energy_j: sourceSI, mass_kg: mass.si });
        }
      }
    }
    if (source.dimension === "force") for (const mass of masses) {
      const count = sourceSI / (mass.si * gravity);
      add("support-weight", [mass], `About ${formatNumber(count)} times the weight of ${mass.singularLabel} under standard Earth gravity`, `An equivalent downward force under standard gravity, not an orbital weight. ${mass.assumption}`, count, "ratio", "force_n / (mass_kg * gravity_m_s2)", { force_n: sourceSI, mass_kg: mass.si, gravity_m_s2: gravity }, undefined, true);
    }
    if (source.dimension === "volume") for (const area of facts.filter(fact => fact.dimension === "area" && fact.singularLabel && fact.scenarioRole === "area")) {
      const depth = sourceSI / area.si;
      if (depth > 0 && depth <= sceneLimits.maxLayerMetres) add("flood-area", [area], `Enough volume to cover ${area.singularLabel} in a layer about ${natural(depth, "length").text} deep`, `A perfectly flat, uniform layer; ignores terrain, drainage and containment. ${area.assumption}`, depth, "m", "volume_m3 / area_m2", { volume_m3: sourceSI, area_m2: area.si });
    }
    if (source.dimension === "length") for (const speed of facts.filter(fact => fact.dimension === "speed")) {
      const seconds = sourceSI / speed.si;
      add("travel-time", [speed], `About ${natural(seconds, "time").text} of travel at ${speed.referenceLabel}`, `Ideal constant-speed travel; no acceleration, obstacles or endurance assumption. ${speed.assumption}`, seconds, "s", "distance_m / speed_m_s", { distance_m: sourceSI, speed_m_s: speed.si });
    }
    if (source.dimension === "data") {
      // Convert explicitly to bytes: mathjs's internal data base need not be bytes.
      const inputBytes = unit(source.quantity, source.sourceUnit).toNumber("B");
      for (const data of dataFacts) {
        const media = data.kind === "media-rate";
        const value = inputBytes / data.si;
        const headline = media ? `About ${natural(value, "time").text} of ${data.referenceLabel}` : `About ${formatNumber(value)} times the payload of one of these ${data.referenceLabel}`;
        const limits = "Media duration describes accumulated encoded payload, not human attention, battery life, continuous camera operation or elapsed production time. Payload equivalents do not imply fractional files are complete.";
        const basis = `${data.fictionFrame} ${data.assumption} ${limits}`;
        add(media ? "media-duration" : "content-payload-count", [data], headline, basis, value, media ? "s" : "payload-equivalents", media ? "input_bytes / bytes_per_second" : "input_bytes / bytes_per_item", { input_bytes: inputBytes, [media ? "bytes_per_second" : "bytes_per_item"]: data.si }, undefined, false, data.bounds);
        if (data.allowFixedEnsemble) for (const ensemble of scaleFacts.ensembles) {
          const denominator = ensemble.si * data.si;
          if (!Number.isFinite(denominator) || denominator <= 0) continue;
          const allocation = inputBytes / denominator;
          const ensembleHeadline = media
            ? `At each of ${ensemble.referenceLabel}, a separate ${data.referenceLabel} recording lasting about ${natural(allocation, "time").text}`
            : `At each of ${ensemble.referenceLabel}, separate storage equal to about ${formatNumber(allocation)} times one of these ${data.referenceLabel}`;
          const ensembleBasis = `${data.fictionFrame} Imagine a separate stored allocation at each fixed place, not an observed crowd or actual installed equipment. ${ensemble.assumption} ${data.assumption} Each allocation contains independent recordings or separately stored files. Never multiply a single shared file by its audience. This is not a claim about the venue's network or real attendees. ${limits}`;
          add(media ? "ensemble-media-duration" : "ensemble-content-payload-count", [data, ensemble], ensembleHeadline, ensembleBasis, allocation, media ? "s" : "payload-equivalents", media ? "input_bytes / (fixed_count * bytes_per_second)" : "input_bytes / (fixed_count * bytes_per_item)", { input_bytes: inputBytes, fixed_count: ensemble.si, [media ? "bytes_per_second" : "bytes_per_item"]: data.si }, undefined, false, data.bounds);
        }
      }
    }
  }
  return packets.filter(isSalientScenePacket);
  };
}

export function buildScenePackets(measurement: Pick<ModelChoice, "quantity" | "sourceUnit">, catalog: unknown, options: ScenePacketOptions = {}): ScenePacket[] {
  const packets = createScenePoolBuilder(catalog, options)(measurement);
  const max = options.maxPackets ?? 12;
  if (!Number.isInteger(max) || max < 1 || max > 12) throw new Error("invalid_scene_limit");
  const draw = options.draw ?? seededDraw(options.seed ?? 0);
  const routed = routeRecentSceneFamilies(packets.filter(isSalientScenePacket), options.recentFamilies);
  options.onFamilyRouting?.(routed.report);
  const groups = new Map<string, ScenePacket[]>();
  for (const packet of shuffle(routed.packets, draw)) groups.set(packet.mechanism, [...(groups.get(packet.mechanism) ?? []), packet]);
  const mechanisms = shuffle([...groups.keys()], draw);
  const selected: ScenePacket[] = [];
  const families = new Set<string>();
  // First cover mechanisms and distinct object families, then fill remaining slots fairly.
  for (const uniqueFamily of [true, false]) {
    let added: boolean;
    do {
      added = false;
      for (const mechanism of mechanisms) {
        const group = groups.get(mechanism)!;
        const index = group.findIndex(packet => !uniqueFamily || !families.has(packet.family));
        if (index < 0 || selected.length >= max) continue;
        const [packet] = group.splice(index, 1);
        selected.push(packet); families.add(packet.family); added = true;
      }
    } while (added && selected.length < max);
  }
  return selected;
}

export function scenePacketInput(packets: ScenePacket[]): string {
  return JSON.stringify(packets.map(({ id, headline, basis, computed }) => ({ id, headline, basis, computed })));
}
export function scenePacketSchema(packets: ScenePacket[]) {
  return { type: "object", properties: { packetId: { type: "string", enum: packets.map(packet => packet.id) }, quip: { type: "string", minLength: 1, maxLength: 200 } }, required: ["packetId", "quip"], additionalProperties: false };
}
export function selectScenePacket(response: unknown, packets: ScenePacket[]): { packet: ScenePacket; quip: string } | undefined {
  if (!response || typeof response !== "object" || Array.isArray(response)) return undefined;
  const value = response as { packetId?: unknown; quip?: unknown };
  const packet = packets.find(packet => packet.id === value.packetId);
  if (!packet || typeof value.quip !== "string" || !value.quip.trim() || value.quip.length > 200) return undefined;
  return { packet, quip: value.quip.trim() };
}
