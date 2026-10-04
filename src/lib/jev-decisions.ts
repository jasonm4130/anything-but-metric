import { formatNumber } from "./convert";

/**
 * Question builders and response readers for Jev, TypeSafe's decision model,
 * served by OpenRouter's alpha Decisions API (POST /api/alpha/decisions).
 * Jev answers only within supplied criteria, so it cannot return a refusal string.
 * The Worker's model-led flow asks these questions in production; the live evaluation
 * harness uses the same builders to calibrate them.
 */

export const jevModel = "typesafe/jev-1.13";
export const jevQuestionVersion = "jev-decisions.v1";
export const bandCount = 7;
/** Each band spans half a decade, so a 3x error moves a value about one band. */
export const bandWidthDecades = 0.5;
/**
 * Production accepts an estimate when Jev's chosen band is within this many bands of the
 * proposal's band (about a factor of three either way). Calibrate with the jev-bands suite.
 */
export const bandTolerance = 1;

export type DecisionQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string; criteria: { true: string; false: string } }
  | { type: "score"; instructions: string; criteria: string[] };
export type DecisionsRequest = { model: string; state: unknown; questions: Record<string, DecisionQuestion> };
export type Band = { key: string; low: number; high: number };
export type BandCheck = { question: DecisionQuestion; bands: Band[]; proposedKey: string };

/**
 * Seven contiguous half-decade bands around a proposed value. `position` places the
 * proposal's band among the seven so it is not always the middle option.
 */
export function bandCheckQuestion(subject: { thing: string; dimension: string; value: number; unit: string; instructions?: string }, position: number): BandCheck {
  if (!Number.isInteger(position) || position < 0 || position >= bandCount) throw new RangeError("band position out of range");
  if (!Number.isFinite(subject.value) || subject.value <= 0) throw new RangeError("value must be positive");
  const centre = Math.log10(subject.value);
  const bands = Array.from({ length: bandCount }, (_, index) => {
    const offset = (index - position) * bandWidthDecades;
    return { key: `band_${index + 1}`, low: 10 ** (centre + offset - bandWidthDecades / 2), high: 10 ** (centre + offset + bandWidthDecades / 2) };
  });
  const criteria = Object.fromEntries(bands.map(band => [band.key, `between ${formatNumber(band.low)} and ${formatNumber(band.high)} ${subject.unit}`]));
  return {
    question: { type: "choice", instructions: subject.instructions ?? `Which range contains the typical ${subject.dimension} of one ${subject.thing}?`, criteria },
    bands,
    proposedKey: bands[position].key
  };
}

export function refusalQuestion(): DecisionQuestion {
  return {
    type: "noul",
    instructions: "Is the supplied text a refusal, apology, warning or policy statement rather than a playful comparison?",
    criteria: { true: "It refuses, apologises, warns or cites a policy instead of making the comparison.", false: "It makes a comparison, however silly." }
  };
}

export function recognisableQuestion(thing: string): DecisionQuestion {
  return {
    type: "noul",
    instructions: `Is "${thing}" a real, recognisable thing that most adults could picture?`,
    criteria: { true: "Real and easy to picture.", false: "Invented, obscure or impossible to picture." }
  };
}

export function pickQuestion(candidates: { id: string; description: string }[]): DecisionQuestion {
  if (!candidates.length || candidates.length > 255) throw new RangeError("Jev choice questions take 1 to 255 options");
  return {
    type: "choice",
    instructions: "Which comparison would make the measurement easiest and most fun to picture?",
    criteria: Object.fromEntries(candidates.map(candidate => [candidate.id, candidate.description]))
  };
}

/** Which reading of an ambiguous unit the person most likely meant. */
export function readingQuestion(readings: { id: string; description: string }[]): DecisionQuestion {
  if (readings.length < 2 || readings.length > 255) throw new RangeError("a reading question needs 2 to 255 readings");
  return {
    type: "choice",
    instructions: "The state holds a measurement someone typed into a playful unit converter. Which reading of its unit did they most likely mean?",
    criteria: Object.fromEntries(readings.map(reading => [reading.id, reading.description]))
  };
}

/** Accept when Jev's chosen band sits within `tolerance` bands of the proposed band. */
export function withinBands(verdict: { bandDistance?: number }, tolerance = bandTolerance): boolean {
  return verdict.bandDistance !== undefined && Math.abs(verdict.bandDistance) <= tolerance;
}

/** Geometric centre of the band Jev chose, used to correct an estimate Jev rejected. */
export function chosenBandValue(check: BandCheck, answer: ChoiceAnswer | undefined): number | undefined {
  const band = check.bands.find(entry => entry.key === answer?.choice);
  return band ? Math.sqrt(band.low * band.high) : undefined;
}

export function decisionsRequest(state: unknown, questions: Record<string, DecisionQuestion>, model = jevModel): DecisionsRequest {
  return { model, state, questions };
}

export type ChoiceAnswer = { choice: string; confidence?: number; probabilities: Record<string, number> };

/** Read a `choice` answer defensively; returns undefined for any unexpected shape. */
export function choiceAnswer(response: unknown, name: string): ChoiceAnswer | undefined {
  const answer = (response as { answers?: Record<string, unknown> } | undefined)?.answers?.[name] as Record<string, unknown> | undefined;
  if (!answer || typeof answer !== "object") return undefined;
  const probabilities = answer.probabilities && typeof answer.probabilities === "object" ? Object.fromEntries(Object.entries(answer.probabilities as Record<string, unknown>).filter(([, value]) => typeof value === "number")) as Record<string, number> : {};
  const choice = typeof answer.choice === "string" ? answer.choice : Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!choice) return undefined;
  return { choice, probabilities, ...(typeof answer.confidence === "number" ? { confidence: answer.confidence } : {}) };
}

/** Probability that a `noul` question is true; undefined for any unexpected shape. */
export function noulProbability(response: unknown, name: string): number | undefined {
  const answer = (response as { answers?: Record<string, unknown> } | undefined)?.answers?.[name];
  if (typeof answer === "number") return answer;
  if (!answer || typeof answer !== "object") return undefined;
  const record = answer as Record<string, unknown>;
  for (const key of ["probability", "p_true", "true"]) if (typeof record[key] === "number") return record[key] as number;
  const probabilities = record.probabilities as Record<string, unknown> | undefined;
  return typeof probabilities?.true === "number" ? probabilities.true : undefined;
}

/** Accept a proposed value when Jev's most likely band is the proposal's band with at least `threshold` probability. */
export function bandVerdict(check: BandCheck, answer: ChoiceAnswer | undefined, threshold: number): { accepted: boolean; chosenKey?: string; probability?: number; bandDistance?: number } {
  if (!answer) return { accepted: false };
  const probability = answer.probabilities[check.proposedKey] ?? (answer.choice === check.proposedKey ? answer.confidence : undefined);
  const chosen = check.bands.findIndex(band => band.key === answer.choice);
  const proposed = check.bands.findIndex(band => band.key === check.proposedKey);
  return {
    accepted: answer.choice === check.proposedKey && (probability ?? 0) >= threshold,
    chosenKey: answer.choice,
    ...(probability === undefined ? {} : { probability }),
    ...(chosen < 0 ? {} : { bandDistance: chosen - proposed })
  };
}
