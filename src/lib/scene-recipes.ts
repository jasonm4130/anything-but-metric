import { validateMeasurement, type ModelChoice } from "./convert";
import { validateGroundedCatalog } from "./grounded-flow";
import { buildScenePackets, type ScenePacket, type SceneRole } from "./scene-packets";

/** Development pilot: choose a source/operation before calculating the user's scene. */
export const sceneRecipeOperations = ["count_equivalent", "energy_motion", "energy_duration", "volume_layer", "data_duration"] as const;
export type SceneRecipeOperation = typeof sceneRecipeOperations[number];
export type SceneRecipe = { operation: SceneRecipeOperation; referenceId: string; context: string };
export type SceneRecipeCard = {
  referenceId: string;
  label: string;
  dimension: string;
  referenceQuantity: number;
  referenceUnit: string;
  assumption: string;
  operations: SceneRecipeOperation[];
  scenarioRole?: SceneRole;
  fictionFrame?: string;
};
export type CompiledSceneRecipe = { packet: ScenePacket; context: string };
export const sceneRecipeContextLimit = 160;
// Deliberately narrower than every dimension that permits a mathematical ratio.
const countDimensions = new Set(["length", "mass", "area", "volume", "energy", "time", "data"]);

/**
 * Reuse the existing packet validators, including their legacy source-role defaults.
 * Zero-sized validation probes contain no user measurement or proposed scene result.
 * Bad catalog configuration throws; it must not look like a model binding failure.
 */
export function sceneRecipeCards(catalog: unknown, dataReferences?: unknown): SceneRecipeCard[] {
  const facts = validateGroundedCatalog(catalog);
  const rows = catalog as Record<string, unknown>[];
  buildScenePackets({ quantity: 0, sourceUnit: "B" }, catalog, { dataReferences });
  const cards: SceneRecipeCard[] = [];
  for (const [index, fact] of facts.entries()) {
    const dimension = validateMeasurement(fact.referenceQuantity, fact.referenceUnit).dimension;
    const probe = buildScenePackets({ quantity: 0, sourceUnit: fact.referenceUnit }, [rows[index]])[0];
    const source = probe?.sources[0];
    if (!source) throw new Error("invalid_recipe_source");
    const operations: SceneRecipeOperation[] = [];
    if (countDimensions.has(dimension)) operations.push("count_equivalent");
    if (source.singularLabel && source.scenarioRole === "object") operations.push("energy_motion");
    if (source.singularLabel && ["power-consumer", "power-generator"].includes(source.scenarioRole ?? "")) operations.push("energy_duration");
    if (source.singularLabel && source.scenarioRole === "area") operations.push("volume_layer");
    if (operations.length) cards.push({ referenceId: fact.id, label: fact.referenceLabel, dimension, referenceQuantity: source.quantity, referenceUnit: source.unit, assumption: source.assumption, operations, ...(source.scenarioRole ? { scenarioRole: source.scenarioRole } : {}) });
  }
  // The shared validator above checked the entire bundle, including exact rate
  // derivations and collisions with the physical catalog. Content-size constructors
  // and population allocations are intentionally outside this first pilot.
  if (dataReferences !== undefined) {
    const data = dataReferences as { references: Record<string, unknown>[] };
    for (const row of data.references.filter(row => row.kind === "media-rate")) {
      cards.push({ referenceId: row.id as string, label: row.referenceLabel as string, dimension: "data-rate", referenceQuantity: row.referenceQuantity as number, referenceUnit: row.referenceUnit as string, assumption: row.assumption as string, operations: ["data_duration"], fictionFrame: row.fictionFrame as string });
    }
  }
  return cards;
}

export function sceneRecipeSchema(cards: SceneRecipeCard[]) {
  return { type: "object", properties: { operation: { type: "string", enum: [...sceneRecipeOperations] }, referenceId: { type: "string", enum: cards.map(card => card.referenceId) }, context: { type: "string", minLength: 1, maxLength: sceneRecipeContextLimit } }, required: ["operation", "referenceId", "context"], additionalProperties: false };
}

/** Structural validation cannot establish the truth of prose; context stays fictional. */
export function parseSceneRecipe(value: unknown): SceneRecipe | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || !["operation", "referenceId", "context"].every(key => Object.hasOwn(value, key))) return undefined;
  const recipe = value as Record<string, unknown>;
  if (typeof recipe.operation !== "string" || !sceneRecipeOperations.includes(recipe.operation as SceneRecipeOperation)) return undefined;
  if (typeof recipe.referenceId !== "string" || !recipe.referenceId.trim()) return undefined;
  if (typeof recipe.context !== "string" || !recipe.context.trim() || recipe.context.length > sceneRecipeContextLimit || /[\u0000-\u001f\u007f]/.test(recipe.context)) return undefined;
  return { operation: recipe.operation as SceneRecipeOperation, referenceId: recipe.referenceId, context: recipe.context.trim() };
}

export function compileSceneRecipe(measurement: Pick<ModelChoice, "quantity" | "sourceUnit">, catalog: unknown, proposed: unknown, options: { dataReferences?: unknown } = {}): CompiledSceneRecipe | undefined {
  const recipe = parseSceneRecipe(proposed);
  if (!recipe) return undefined;
  const cards = sceneRecipeCards(catalog, options.dataReferences);
  const card = cards.find(card => card.referenceId === recipe.referenceId);
  if (!card?.operations.includes(recipe.operation)) return undefined;
  let dimension: string;
  try { dimension = validateMeasurement(measurement.quantity, measurement.sourceUnit).dimension; }
  catch { return undefined; }
  const requiredDimension = { count_equivalent: card.dimension, energy_motion: "energy", energy_duration: "energy", volume_layer: "volume", data_duration: "data" }[recipe.operation];
  if (dimension !== requiredDimension) return undefined;

  const rows = catalog as Record<string, unknown>[];
  const reference = rows.find(row => row.id === recipe.referenceId);
  const media = recipe.operation === "data_duration";
  const data = options.dataReferences as { schemaVersion: number; references: Record<string, unknown>[] } | undefined;
  // A singleton source prevents the candidate limiter, random routing or unrelated
  // references from substituting for the recipe. The physical row in a media call
  // only satisfies the existing catalog validator; it cannot become the result.
  const selectedCatalog = media ? [rows[0]] : [reference!];
  const selectedData = media ? { schemaVersion: 1, references: data!.references.filter(row => row.id === recipe.referenceId) } : undefined;
  const mechanisms: Record<SceneRecipeOperation, string[]> = { count_equivalent: ["direct"], energy_motion: ["launch-object"], energy_duration: ["run-appliance", "generate-energy"], volume_layer: ["flood-area"], data_duration: ["media-duration"] };
  const packet = buildScenePackets(measurement, selectedCatalog, { dataReferences: selectedData }).find(packet => mechanisms[recipe.operation].includes(packet.mechanism) && packet.sources[0].id === recipe.referenceId);
  if (!packet) return undefined; // Includes physical bounds and frozen salience gaps.
  if (recipe.operation === "count_equivalent") packet.basis += " Equivalent quantity only; fractional equivalents do not imply complete objects, practical capacity or physical packing.";
  return { packet, context: recipe.context };
}
