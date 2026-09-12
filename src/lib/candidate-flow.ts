import { conversionFromChoice, type Conversion, type ModelChoice } from "./convert";

export type Candidate = {
  family: string;
  referenceQuantity: number;
  referenceUnit: string;
  referenceLabel: string;
  assumption: string;
  quip?: string;
};

export type CandidateResult = { candidate: Candidate; result: Conversion; value: number; temperature: boolean; zero: boolean; family: string; index: number; valid: true };

export const candidateSchema = (limits: { referenceLabel: number; assumption: number; quip: number }) => ({
  type: "object",
  properties: {
    candidates: {
      type: "array", minItems: 3, maxItems: 3,
      items: {
        type: "object",
        properties: {
          referenceQuantity: { type: "number" },
          referenceLabel: { type: "string", minLength: 1, maxLength: limits.referenceLabel },
          assumption: { type: "string", minLength: 1, maxLength: limits.assumption },
          quip: { type: "string", maxLength: limits.quip },
          referenceUnit: { type: "string", minLength: 1, maxLength: 80, description: "The unit for one reference object. referenceQuantity is the amount for one object in this returned unit." },
          family: { type: "string", minLength: 1, maxLength: 80 }
        },
        required: ["referenceQuantity", "referenceLabel", "assumption", "referenceUnit", "family"],
        additionalProperties: false
      }
    }
  },
  required: ["candidates"],
  additionalProperties: false
});

function rawCandidates(value: unknown): unknown[] {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as { candidates?: unknown }).candidates) || (value as { candidates: unknown[] }).candidates.length !== 3) throw new Error("all_invalid");
  return (value as { candidates: unknown[] }).candidates;
}

export function validateCandidates(raw: unknown, measurement: Pick<ModelChoice, "quantity" | "sourceUnit">): CandidateResult[] {
  const candidates: CandidateResult[] = [];
  let firstError: unknown;
  for (const [index, value] of rawCandidates(raw).entries()) {
    try {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const candidate = value as Candidate;
      if (typeof candidate.family !== "string" || !candidate.family.trim() || candidate.family.length > 80) continue;
      const reference: Candidate = {
        family: candidate.family,
        referenceQuantity: candidate.referenceQuantity,
        referenceUnit: candidate.referenceUnit,
        referenceLabel: candidate.referenceLabel,
        assumption: candidate.assumption,
        ...(typeof candidate.quip === "string" ? { quip: candidate.quip } : {})
      };
      const result = conversionFromChoice({ quantity: measurement.quantity, sourceUnit: measurement.sourceUnit, ...reference });
      candidates.push({ candidate: reference, result, value: result.value, temperature: result.dimension === "temperature", zero: measurement.quantity === 0, family: reference.family.trim().toLocaleLowerCase(), index, valid: true });
    } catch (error) { firstError ??= error; /* Invalid model candidates are deliberately discarded. */ }
  }
  if (!candidates.length && firstError instanceof Error) throw firstError;
  return candidates;
}

export function chooseCandidate(candidates: CandidateResult[], draw: () => number): CandidateResult | undefined {
  const readable = candidates.filter(candidate => candidate.temperature || candidate.zero || (candidate.value >= 0.1 && candidate.value <= 1000));
  const pool = readable.length ? readable : candidates;
  const unique = pool.filter((candidate, index) => pool.findIndex(other => other.family === candidate.family) === index);
  if (!unique.length) return undefined;
  const random = draw();
  if (!Number.isFinite(random) || random < 0 || random >= 1) return undefined;
  return unique[Math.floor(random * unique.length)];
}
