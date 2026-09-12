import { unit } from "mathjs";
import { validateMeasurement } from "./convert";
import { sceneLimits, sceneSaliencePolicy } from "./scene-packets";

type PublishedMass = { kind: "range"; min: number; max: number; unit: string };
export type RangeSceneSource = {
  id: string;
  commonName: string;
  scientificName?: string;
  institution: string;
  title: string;
  url: string;
  section: string;
  massExcerpt: string;
  publishedUpdate?: string | null;
  publishedUpdateAsDisplayed?: string;
  publishedMass: PublishedMass;
  biologicalScope: Record<string, string>;
  requiredQualifier: string;
  otherPublishedMassStatement?: string;
};
export type RangeScene = {
  id: string;
  family: string;
  mechanism: "mass-equivalent-range" | "kinetic-motion-range";
  headline: string;
  basis: string;
  quantity: number;
  sourceUnit: string;
  computed: { min: number; max: number; unit: "ratio" | "m/s"; formula: string; operands: Record<string, number> };
  sources: RangeSceneSource[];
};
type RangeFact = { source: RangeSceneSource; minKg: number; maxKg: number };
const speedOfLight = 299792458; // Exact SI constant, metres per second.
const metresPerMph = 0.44704; // International mile and hour definitions.
const displayNumber = new Intl.NumberFormat("en", { minimumSignificantDigits: 2, maximumSignificantDigits: 2, useGrouping: false });
const pluralNames: Record<string, string> = {
  "animal-bare-nosed-wombat-museum-range": "bare-nosed wombats",
  "animal-emperor-penguin-hatching-adult-range": "adult emperor penguins during the hatching period",
  "animal-domestic-rabbit-louisville-range": "domestic rabbits",
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function text(value: unknown, max = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("invalid_range_text");
  return value;
}

/** Validates reviewed source data, not the truth of arbitrary new biological prose. */
function rangeFacts(bundle: unknown): RangeFact[] {
  if (!object(bundle) || bundle.schemaVersion !== 1 || !Array.isArray(bundle.references) || !bundle.references.length) throw new Error("invalid_range_bundle");
  const ids = new Set<string>();
  const facts: RangeFact[] = [];
  for (const row of bundle.references) {
    if (!object(row) || !object(row.source) || !object(row.publishedMass) || !object(row.biologicalScope)) throw new Error("invalid_range_reference");
    const id = text(row.id, 160);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || ids.has(id)) throw new Error("invalid_range_id");
    ids.add(id);
    const mass = row.publishedMass;
    if (mass.kind !== "range" || typeof mass.min !== "number" || typeof mass.max !== "number" || !Number.isFinite(mass.min) || !Number.isFinite(mass.max) || mass.min <= 0 || mass.max <= mass.min || typeof mass.unit !== "string") throw new Error("invalid_mass_range");
    let minKg: number;
    let maxKg: number;
    try {
      const minimum = validateMeasurement(mass.min, mass.unit);
      const maximum = validateMeasurement(mass.max, mass.unit);
      if (minimum.dimension !== "mass" || maximum.dimension !== "mass") throw new Error();
      minKg = unit(mass.min, minimum.sourceUnit).toNumber("kg");
      maxKg = unit(mass.max, maximum.sourceUnit).toNumber("kg");
      if (!Number.isFinite(minKg) || !Number.isFinite(maxKg) || minKg <= 0 || maxKg <= minKg) throw new Error();
    } catch { throw new Error("invalid_mass_range"); }
    const provenance = row.source;
    const source: RangeSceneSource = {
      id, commonName: text(row.commonName, 160), institution: text(provenance.institution), title: text(provenance.title), url: text(provenance.url), section: text(provenance.section), massExcerpt: text(provenance.massExcerpt),
      publishedMass: { kind: "range", min: mass.min, max: mass.max, unit: mass.unit },
      biologicalScope: {}, requiredQualifier: text(row.requiredQualifier),
    };
    try {
      const url = new URL(source.url);
      if (url.protocol !== "https:" || !url.hostname || url.username || url.password) throw new Error();
    } catch { throw new Error("invalid_range_provenance"); }
    for (const required of ["species", "lifeStage", "sex", "setting"]) text(row.biologicalScope[required]);
    for (const [key, value] of Object.entries(row.biologicalScope)) {
      if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key)) throw new Error("invalid_range_scope");
      Object.defineProperty(source.biologicalScope, key, { value: text(value), enumerable: true, writable: true, configurable: true });
    }
    if (row.scientificName !== undefined) source.scientificName = text(row.scientificName, 160);
    if (row.otherPublishedMassStatement !== undefined) source.otherPublishedMassStatement = text(row.otherPublishedMassStatement);
    if (provenance.publishedUpdate !== undefined) source.publishedUpdate = provenance.publishedUpdate === null ? null : text(provenance.publishedUpdate, 160);
    if (provenance.publishedUpdateAsDisplayed !== undefined) source.publishedUpdateAsDisplayed = text(provenance.publishedUpdateAsDisplayed, 160);
    facts.push({ source, minKg, maxKg });
  }
  return facts;
}

/** No midpoint, sampled animal mass, fitted population or partial admitted interval. */
export function createRangeSceneBuilder(bundle: unknown) {
  const facts = rangeFacts(bundle);
  return (measurement: { quantity: number; sourceUnit: string }): RangeScene[] => {
  const input = validateMeasurement(measurement.quantity, measurement.sourceUnit);
  if (input.dimension !== "mass" && input.dimension !== "energy") return [];
  if (input.dimension === "energy" && input.quantity === 0) return [];
  const motion = input.dimension === "energy";
  const inputValue = unit(input.quantity, input.sourceUnit).toNumber(motion ? "J" : "kg");
  const scenes: RangeScene[] = [];
  for (const { source, minKg, maxKg } of facts) {
    const min = motion ? Math.sqrt(2 * (inputValue / maxKg)) : inputValue / maxKg;
    const max = motion ? Math.sqrt(2 * (inputValue / minKg)) : inputValue / minKg;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min || (input.quantity !== 0 && min === 0)) continue;
    if (motion) {
      if (min / metresPerMph < sceneSaliencePolicy.minSpeedMph || max > sceneLimits.maxKineticSpeed || max >= speedOfLight * sceneLimits.maxRelativisticFraction) continue;
    } else if (input.quantity !== 0 && (min < sceneSaliencePolicy.minRatio || max > sceneSaliencePolicy.maxRatio)) continue;
    const display = `${displayNumber.format(motion ? min / metresPerMph : min)}–${displayNumber.format(motion ? max / metresPerMph : max)}`;
    const name = source.id === "animal-emperor-penguin-hatching-adult-range" ? "adult emperor penguin during the hatching period" : source.commonName;
    const article = /^[aeiou]/i.test(name) ? "an" : "a";
    const headline = motion ? `Imagine ${article} ${name} moving at about ${display} mph` : pluralNames[source.id] ? `About ${display} ${pluralNames[source.id]} by weight.` : `About ${display} ${name} mass equivalents`;
    const interpretation = motion
      ? "Ideal kinetic-energy equivalence from rest, with no drag or losses and nonrelativistic motion; not a running speed, biological capability or survival claim. Speeds use the maximum and minimum published masses respectively."
      : "Equivalent mass only; fractional equivalents do not imply complete animals or practical capacity. Counts use the maximum and minimum published masses respectively.";
    const basis = `${source.requiredQualifier} ${Object.values(source.biologicalScope).join(" ")} ${source.otherPublishedMassStatement ? `${source.otherPublishedMassStatement} ` : ""}${interpretation} The full published interval is retained; no midpoint, average, probability distribution or individual animal mass is assumed. Display endpoints are rounded to two significant digits.`;
    const mechanism = motion ? "kinetic-motion-range" : "mass-equivalent-range";
    scenes.push({ id: `${mechanism}:${source.id}`, family: source.commonName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), mechanism, headline, basis, quantity: measurement.quantity, sourceUnit: measurement.sourceUnit,
      computed: { min, max, unit: motion ? "m/s" : "ratio", formula: motion ? "[sqrt(2 * energy_j / mass_max_kg), sqrt(2 * energy_j / mass_min_kg)]" : "[input_kg / mass_max_kg, input_kg / mass_min_kg]", operands: { [motion ? "energy_j" : "input_kg"]: inputValue, mass_min_kg: minKg, mass_max_kg: maxKg } }, sources: [source] });
  }
  return scenes;
  };
}

export function buildRangeScenes(measurement: { quantity: number; sourceUnit: string }, bundle: unknown): RangeScene[] {
  return createRangeSceneBuilder(bundle)(measurement);
}
