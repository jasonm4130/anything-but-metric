import { conversionFromChoice, type Conversion, type ModelChoice } from "./convert";

export type GroundedReference = Pick<ModelChoice, "referenceQuantity" | "referenceUnit" | "referenceLabel" | "assumption"> & { id: string };
export type OfferedReference = GroundedReference & { result: Conversion; ratio: number };

export const groundedPrompt = `Select one offered referenceId and write one concise, required dry joke. Return only referenceId and quip. Do not add factual, numeric, medical, or scientific claims. Do not alter or restate the object's physical basis.`;

export function validateGroundedCatalog(catalog: unknown): GroundedReference[] {
  if (!Array.isArray(catalog) || !catalog.length) throw new Error("invalid_grounded_catalog");
  const ids = new Set<string>();
  return catalog.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid_grounded_catalog");
    const reference = entry as GroundedReference;
    if (typeof reference.id !== "string" || !reference.id.trim() || ids.has(reference.id.trim())) throw new Error("invalid_grounded_catalog");
    ids.add(reference.id.trim());
    try {
      conversionFromChoice({ quantity: 1, sourceUnit: reference.referenceUnit, referenceQuantity: reference.referenceQuantity, referenceUnit: reference.referenceUnit, referenceLabel: reference.referenceLabel, assumption: reference.assumption });
    } catch { throw new Error("invalid_grounded_catalog"); }
    return { id: reference.id.trim(), referenceQuantity: reference.referenceQuantity, referenceUnit: reference.referenceUnit, referenceLabel: reference.referenceLabel, assumption: reference.assumption };
  });
}

export function offeredReferences(catalog: unknown, measurement: Pick<ModelChoice, "quantity" | "sourceUnit">): OfferedReference[] {
  if (!Array.isArray(catalog)) return [];
  const offered: OfferedReference[] = [];
  for (const entry of catalog) {
    try {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const reference = entry as GroundedReference;
      if (typeof reference.id !== "string" || !reference.id.trim()) continue;
      const result = conversionFromChoice({ quantity: measurement.quantity, sourceUnit: measurement.sourceUnit, referenceQuantity: reference.referenceQuantity, referenceUnit: reference.referenceUnit, referenceLabel: reference.referenceLabel, assumption: reference.assumption });
      offered.push({ ...reference, id: reference.id.trim(), result, ratio: result.value });
    } catch { /* A catalog row must be compatible and complete before it can be offered. */ }
  }
  if (!offered.length) return [];
  if (offered[0].result.dimension === "temperature" || measurement.quantity === 0) return offered.sort((a, b) => a.id.localeCompare(b.id)).slice(0, 5);
  const readable = offered.filter(reference => reference.ratio >= 0.1 && reference.ratio <= 1000);
  const pool = readable.length ? readable : offered;
  return pool.sort((a, b) => {
    const distance = (value: number) => value > 0 && Number.isFinite(value) ? Math.abs(Math.log10(value)) : Infinity;
    return distance(a.ratio) - distance(b.ratio) || a.id.localeCompare(b.id);
  }).slice(0, 5);
}

export function groundedSchema(offered: OfferedReference[]) {
  return {
    type: "object",
    properties: {
      referenceId: { type: "string", enum: offered.map(reference => reference.id) },
      quip: { type: "string", minLength: 1, maxLength: 160 }
    },
    required: ["referenceId", "quip"],
    additionalProperties: false
  };
}

export function groundedInput(offered: OfferedReference[]): string {
  return offered.map(reference => `ID: ${reference.id}\nLABEL: ${reference.referenceLabel}\nBASIS: ${reference.assumption}`).join("\n\n");
}

export function selectGroundedReference(response: unknown, offered: OfferedReference[]): { reference: OfferedReference; quip?: string; fallback: boolean } {
  const first = offered[0];
  if (!first) throw new Error("unsupported_dimension");
  if (!response || typeof response !== "object" || Array.isArray(response)) return { reference: first, fallback: true };
  const value = response as { referenceId?: unknown; quip?: unknown };
  const reference = typeof value.referenceId === "string" ? offered.find(item => item.id === value.referenceId) : undefined;
  if (!reference || typeof value.quip !== "string" || !value.quip.trim() || value.quip.length > 160) return { reference: first, fallback: true };
  return { reference, quip: value.quip.trim(), fallback: false };
}

export function groundedResult(selection: { reference: OfferedReference; quip?: string }): Conversion {
  const result = selection.reference.result;
  const headline = ["pressure", "speed", "frequency"].includes(result.dimension)
    ? `About ${result.displayValue} times ${result.referenceLabel}`
    : result.headline;
  return { ...result, headline, ...(selection.quip ? { quip: selection.quip } : {}) };
}
