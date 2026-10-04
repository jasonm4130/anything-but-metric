import { parseTokenUsage, tokenComparisonMenu, tokenComparisonResult } from "./ai-tokens";
import { comparisonMenu, comparisonResult, type ComparisonPacket, type ComparisonResult } from "./comparison-flow";
import { formatNumber, validateMeasurement } from "./convert";
import { checkProposalFor, creativePromptVersion, creativeProposalInput, creativeProposalPrompt, creativeProposalSchema, measureWindow, responseContent, scoreCreativeResponse, type CreativeProposal, type ProposalCheck } from "./creative-proposals";
import { bandCheckQuestion, bandVerdict, choiceAnswer, chosenBandValue, decisionsRequest, jevModel, jevQuestionVersion, pickQuestion, readingQuestion, withinBands, type BandCheck, type DecisionQuestion, type DecisionsRequest } from "./jev-decisions";
import { interpretMeasurement } from "./measurement";
import { ambiguousReadings, describeMeasure, localCurrency, physical, type Measure } from "./measures";
import { readerModel, readerOptions, readerPrompt, readerPromptVersion, readerSchema, readMeasure } from "./reader";
import { recentFamilyLimit } from "./scene-packets";

/**
 * Production conversion flow. A creative model proposes references with estimated values,
 * Jev checks those values and chooses the reference, and code keeps only the arithmetic.
 * The reviewed catalogue is the template fallback when the creative step fails or refuses.
 * Every stage is recorded so questions and responses can be replayed later.
 */

export const creativeModel = "@cf/zai-org/glm-5.3-flash";
// GLM 5.3 Flash cannot disable reasoning; low effort matches the October 2026 bake-off.
export const creativeOptions = { reasoning_effort: "low", max_tokens: 2500, temperature: 0.8 } as const;
export const themes = ["kitchen", "animals", "sport", "space", "vehicles", "music", "garden", "office", "seaside", "history", "toys", "weather", "construction", "fashion", "travel", "school"] as const;
export const flowVersion = "model-flow.v1";
export const budgets = { totalMs: 25_000, readerMs: 6_000, jevMs: 4_000, creativeMaxMs: 15_000, creativeMinMs: 4_000 } as const;

export type FailureReason = "timeout" | "rate_limited" | "provider" | "unavailable";
export class StageFailure extends Error {
  constructor(readonly reason: FailureReason, readonly response?: unknown) {
    super(reason);
  }
}

/** Model transports. `jev` is absent when the Worker has no Jev route configured. */
export type Models = {
  workersAi(model: string, body: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
  jev?: (request: DecisionsRequest, timeoutMs: number) => Promise<unknown>;
};

export type StageName = "reader" | "jev-reading" | "jev-estimate" | "creative" | "jev-review" | "jev-template";
export type StageRecord = {
  stage: StageName; model: string; promptVersion: string; latencyMs: number; outcome: string;
  request?: unknown; response?: unknown; detail?: unknown;
};
export type ReplayRecord = {
  schema: "abm-replay.v1"; flowVersion: string; requestId: string; at: string; input: string; recentFamilies: string[];
  outcome: "model" | "template" | "tokens" | "rejected" | "failed"; status: number; refused: boolean; latencyMs: number;
  measure?: Measure; stages: StageRecord[];
  result?: { packetId: string; origin: string; headline: string; family: string }; error?: string;
};
export type ModelResult = ComparisonResult & { origin: "model" | "catalogue" };
export type FlowAnswer = { status: number; body: { result: ModelResult | ComparisonResult } | { error: string }; record: ReplayRecord };

const messages = {
  unrecognised: "I couldn't recognise that measurement yet. Try a number and unit, such as 144 J or $20.",
  readerDown: "The measurement reader is unavailable. Please try again.",
  busy: "The comparison engine is busy. Please try again shortly.",
  gap: "I don't have a useful comparison at that scale yet. Try another measurement.",
  empty: "The imagination engine came back empty-handed. Please try again."
};

const maxStored = 12_000;
/** Keep stored payloads bounded; replay needs the shape and text, not megabytes of padding. */
export function bounded(value: unknown): unknown {
  if (value === undefined) return undefined;
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return "[unserialisable]";
  }
  if (text === undefined) return undefined;
  if (text.length <= maxStored) return typeof value === "string" ? value : JSON.parse(text);
  return { truncated: true, length: text.length, head: text.slice(0, maxStored) };
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const slug = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "model";

/** Turn an accepted proposal into the public result shape the page already renders. */
export function modelResult(measure: Measure, check: ProposalCheck, proposal: CreativeProposal, checkedByJev: boolean, history: string[]): ModelResult {
  const family = slug(proposal.family);
  const interpretation = describeMeasure(measure);
  const unitText = measure.kind === "count" ? (proposal.value === 1 ? measure.item : measure.items) : proposal.unit.trim();
  const estimateNote = measure.estimate ? ` The measurement itself is an estimate: one ${measure.estimate.written} ≈ ${formatNumber(measure.estimate.perUnit)} ${measure.estimate.perUnitUnit === "count" ? measure.items : measure.estimate.perUnitUnit}.` : "";
  return {
    packetId: `model:${family}:${slug(proposal.singular)}`,
    family,
    headline: check.text as string,
    assumption: `One ${proposal.singular.trim()} ≈ ${formatNumber(proposal.value)} ${unitText}: ${proposal.basis.trim()} This is a model's estimate${checkedByJev ? " that Jev sanity-checked" : ""}, not a sourced fact.`,
    basis: `${interpretation} ÷ ${formatNumber(proposal.value)} ${unitText} per ${proposal.singular.trim()} ≈ ${check.displayCount}. Code did the division; the reference size is estimated.${estimateNote}`,
    sources: [],
    dimension: measure.dimension,
    quantity: measure.quantity,
    sourceUnit: measure.unit,
    interpretation,
    recentFamilies: [...history.filter(entry => entry !== family), family].slice(-recentFamilyLimit),
    origin: "model"
  };
}

type Context = { input: string; history: string[]; models: Models; next: () => number; elapsed: () => number; stages: StageRecord[] };

async function timed<T>(context: Context, run: () => Promise<T>): Promise<{ value?: T; failure?: StageFailure; latencyMs: number }> {
  const started = context.elapsed();
  try {
    return { value: await run(), latencyMs: context.elapsed() - started };
  } catch (cause) {
    return { failure: cause instanceof StageFailure ? cause : new StageFailure("provider", String(cause)), latencyMs: context.elapsed() - started };
  }
}

async function askJev(context: Context, stage: StageName, state: unknown, questions: Record<string, DecisionQuestion>): Promise<unknown | undefined> {
  const remaining = budgets.totalMs - context.elapsed();
  if (!context.models.jev) {
    context.stages.push({ stage, model: jevModel, promptVersion: jevQuestionVersion, latencyMs: 0, outcome: "unavailable" });
    return undefined;
  }
  if (remaining < 1_000) {
    context.stages.push({ stage, model: jevModel, promptVersion: jevQuestionVersion, latencyMs: 0, outcome: "skipped_deadline" });
    return undefined;
  }
  const request = decisionsRequest(state, questions);
  const call = await timed(context, () => context.models.jev!(request, Math.min(budgets.jevMs, remaining - 500)));
  context.stages.push({ stage, model: jevModel, promptVersion: jevQuestionVersion, latencyMs: call.latencyMs, outcome: call.failure ? call.failure.reason : "ok", request, response: bounded(call.failure ? call.failure.response : call.value) });
  return call.value;
}

/** Jev picks among catalogue packets; without Jev the seeded menu order decides. */
async function pickPacket(context: Context, menu: ComparisonPacket[], measurement: string): Promise<ComparisonPacket> {
  if (menu.length === 1) return menu[0];
  const ids = menu.map((packet, index) => ({ key: `option_${index + 1}`, packet }));
  const response = await askJev(context, "jev-template", { task: "Choose the comparison that makes a measurement easiest and most fun to picture.", measurement }, { pick: pickQuestion(ids.map(({ key, packet }) => ({ id: key, description: packet.headline }))) });
  const choice = choiceAnswer(response, "pick")?.choice;
  return ids.find(entry => entry.key === choice)?.packet ?? menu[0];
}

async function template(context: Context, measure: Measure, seed: number): Promise<ComparisonResult | undefined> {
  if (measure.kind !== "physical") return undefined;
  let menu: ComparisonPacket[] = [];
  try {
    menu = comparisonMenu({ quantity: measure.quantity, sourceUnit: measure.unit }, context.history, seed);
  } catch {
    return undefined;
  }
  if (!menu.length) return undefined;
  const packet = await pickPacket(context, menu, describeMeasure(measure));
  return { ...comparisonResult(packet, { quantity: measure.quantity, sourceUnit: measure.unit }, context.history), interpretation: describeMeasure(measure) };
}

async function interpret(context: Context): Promise<{ measure?: Measure; status?: number; error?: string }> {
  const { input } = context;
  const money = localCurrency(input);
  if (money) return { measure: money };
  const readings = ambiguousReadings(input);
  if (readings) {
    const response = await askJev(context, "jev-reading", { measurement: input }, { reading: readingQuestion(readings) });
    const choice = choiceAnswer(response, "reading")?.choice;
    return { measure: readings.find(reading => reading.id === choice)?.measure ?? readings[0].measure };
  }
  let needsReader = false;
  const local = await interpretMeasurement(input, async () => {
    needsReader = true;
    return { recognized: false, quantity: 0, sourceUnit: "m" };
  });
  if (!needsReader) {
    if (!local.recognized) return { status: 422, error: messages.unrecognised };
    try {
      validateMeasurement(local.quantity, local.sourceUnit);
    } catch (cause) {
      return { status: 422, error: cause instanceof Error && /negative|absolute zero|measuring tape/.test(cause.message) ? cause.message : messages.unrecognised };
    }
    const measure = physical(local.quantity, local.sourceUnit);
    return measure ? { measure } : { status: 422, error: messages.unrecognised };
  }

  const body = { messages: [{ role: "system", content: readerPrompt }, { role: "user", content: input }], response_format: { type: "json_schema", json_schema: readerSchema }, temperature: 0, ...readerOptions };
  const call = await timed(context, () => context.models.workersAi(readerModel, body, budgets.readerMs));
  if (call.failure) {
    context.stages.push({ stage: "reader", model: readerModel, promptVersion: readerPromptVersion, latencyMs: call.latencyMs, outcome: call.failure.reason, request: input, response: bounded(call.failure.response) });
    return call.failure.reason === "rate_limited" ? { status: 429, error: messages.busy } : { status: 502, error: messages.readerDown };
  }
  const read = readMeasure(call.value, input);
  context.stages.push({ stage: "reader", model: readerModel, promptVersion: readerPromptVersion, latencyMs: call.latencyMs, outcome: read.outcome, request: input, response: bounded(call.value) });
  if (read.outcome !== "ok") return { status: 422, error: messages.unrecognised };
  // Temperatures are not ratios, so a band correction would be meaningless; they keep the reading.
  if (!read.checkEstimate || !read.measure.estimate || read.measure.dimension === "temperature") return { measure: read.measure };

  // Jev checks a model-supplied unit factor or estimate before anything is divided by it.
  const estimate = read.measure.estimate;
  const check = bandCheckQuestion({
    thing: estimate.written, dimension: read.measure.dimension, value: estimate.perUnit, unit: estimate.perUnitUnit === "count" ? read.measure.items ?? "items" : estimate.perUnitUnit,
    instructions: `Which range contains the typical ${read.measure.kind === "count" ? "number of " + (read.measure.items ?? "items") : read.measure.dimension} of ${estimate.subject === estimate.written ? `one ${estimate.written}` : estimate.subject}?`
  }, bandPosition(context));
  const response = await askJev(context, "jev-estimate", { task: "Sanity-check an estimated quantity for a playful unit converter.", measurement: input }, { estimate: check.question });
  const answer = choiceAnswer(response, "estimate");
  const verdict = bandVerdict(check, answer, 0);
  context.stages.at(-1)!.detail = { proposedKey: check.proposedKey, ...verdict };
  if (!answer || withinBands(verdict)) return { measure: read.measure };
  const corrected = chosenBandValue(check, answer);
  if (!corrected) return { measure: read.measure };
  const scale = corrected / estimate.perUnit;
  return { measure: { ...read.measure, quantity: read.measure.quantity * scale, estimate: { ...estimate, perUnit: corrected } } };
}

/** Keep at least two bands (a decade) either side of a proposal so Jev can correct it in both directions. */
const bandPosition = (context: Context) => 2 + Math.floor(context.next() * 3);

type Reviewed = { check: ProposalCheck; proposal: CreativeProposal; checkedByJev: boolean };

async function review(context: Context, measure: Measure, valid: { check: ProposalCheck; proposal: CreativeProposal }[]): Promise<Reviewed | undefined> {
  const questions: Record<string, DecisionQuestion> = {};
  const checks: BandCheck[] = valid.map(({ proposal }, index) => {
    const check = bandCheckQuestion({ thing: proposal.singular, dimension: measure.kind === "count" ? `number of ${measure.items}` : measure.dimension, value: proposal.value, unit: measure.kind === "count" ? measure.items ?? "items" : proposal.unit }, bandPosition(context));
    questions[`band_${index + 1}`] = check.question;
    return check;
  });
  if (valid.length > 1) questions.pick = pickQuestion(valid.map(({ check }, index) => ({ id: `proposal_${index + 1}`, description: check.text as string })));
  const response = await askJev(context, "jev-review", { task: "Sanity-check estimated sizes in playful comparisons, then choose the most fun and picturable one.", measurement: describeMeasure(measure) }, questions);
  if (response === undefined) return { ...valid[0], checkedByJev: false };
  const verdicts = checks.map((check, index) => ({ ...bandVerdict(check, choiceAnswer(response, `band_${index + 1}`), 0), proposedKey: check.proposedKey }));
  const pick = choiceAnswer(response, "pick");
  context.stages.at(-1)!.detail = { verdicts, pick: pick?.choice };
  const accepted = valid.map((entry, index) => ({ ...entry, index, verdict: verdicts[index] })).filter(entry => withinBands(entry.verdict));
  if (!accepted.length) {
    context.stages.at(-1)!.outcome = "rejected_all";
    return undefined;
  }
  const preference = (index: number) => pick?.probabilities[`proposal_${index + 1}`] ?? (pick?.choice === `proposal_${index + 1}` ? 1 : 0);
  const best = accepted.reduce((winner, entry) => preference(entry.index) > preference(winner.index) ? entry : winner);
  return { check: best.check, proposal: best.proposal, checkedByJev: true };
}

/**
 * Answer one verified measurement. Pure apart from the injected model transports, so tests
 * and the replay tooling can drive it with recorded responses.
 */
export async function answer(input: string, history: string[], models: Models, options: { requestId: string; seed: number; now?: () => number; at?: string }): Promise<FlowAnswer> {
  const now = options.now ?? Date.now;
  const started = now();
  const next = random(options.seed);
  const context: Context = { input, history, models, next, elapsed: () => now() - started, stages: [] };
  const record: ReplayRecord = { schema: "abm-replay.v1", flowVersion, requestId: options.requestId, at: options.at ?? new Date(started).toISOString(), input, recentFamilies: history, outcome: "failed", status: 500, refused: false, latencyMs: 0, stages: context.stages };
  const finish = (status: number, body: FlowAnswer["body"], outcome: ReplayRecord["outcome"], measure?: Measure): FlowAnswer => {
    record.status = status;
    record.outcome = outcome;
    record.latencyMs = context.elapsed();
    record.refused = context.stages.some(stage => stage.outcome === "refusal");
    if (measure) record.measure = measure;
    if ("result" in body) record.result = { packetId: body.result.packetId, origin: "origin" in body.result ? body.result.origin : "catalogue", headline: body.result.headline, family: body.result.family };
    else record.error = body.error;
    return { status, body, record };
  };

  const tokens = parseTokenUsage(input);
  if (tokens?.kind === "invalid") return finish(422, { error: tokens.message }, "rejected");
  if (tokens) {
    const menu = tokenComparisonMenu(tokens, history, options.seed);
    if (!menu.length) return finish(422, { error: messages.gap }, "rejected");
    const packet = await pickPacket(context, menu, input);
    return finish(200, { result: tokenComparisonResult(packet, tokens, history) }, "tokens");
  }

  const interpreted = await interpret(context);
  if (!interpreted.measure) return finish(interpreted.status ?? 422, { error: interpreted.error ?? messages.unrecognised }, interpreted.status === 422 ? "rejected" : "failed");
  const measure = interpreted.measure;
  const fallback = async (reason: string): Promise<FlowAnswer> => {
    const result = await template(context, measure, options.seed);
    if (result) return finish(200, { result: { ...result, origin: "catalogue" } }, "template", measure);
    return finish(reason === "coverage" ? 422 : 502, { error: reason === "coverage" ? messages.gap : messages.empty }, reason === "coverage" ? "rejected" : "failed", measure);
  };

  const window = measureWindow(measure);
  if (!window) return fallback("coverage");
  const creativeBudget = Math.min(budgets.creativeMaxMs, budgets.totalMs - context.elapsed() - budgets.jevMs - 500);
  if (creativeBudget < budgets.creativeMinMs) {
    context.stages.push({ stage: "creative", model: creativeModel, promptVersion: creativePromptVersion, latencyMs: 0, outcome: "skipped_deadline" });
    return fallback("deadline");
  }
  const theme = themes[Math.floor(next() * themes.length)];
  const userContent = creativeProposalInput(window, theme, input, history);
  const body = { messages: [{ role: "system", content: creativeProposalPrompt }, { role: "user", content: userContent }], response_format: { type: "json_schema", json_schema: creativeProposalSchema }, ...creativeOptions };
  const call = await timed(context, () => models.workersAi(creativeModel, body, creativeBudget));
  if (call.failure) {
    context.stages.push({ stage: "creative", model: creativeModel, promptVersion: creativePromptVersion, latencyMs: call.latencyMs, outcome: call.failure.reason, request: userContent, response: bounded(call.failure.response) });
    return fallback(call.failure.reason);
  }
  const scored = scoreCreativeResponse(call.value, measure);
  context.stages.push({ stage: "creative", model: creativeModel, promptVersion: creativePromptVersion, latencyMs: call.latencyMs, outcome: scored.outcome, request: userContent, response: bounded(call.value), detail: scored.checks.map(check => ({ index: check.index, ok: check.ok, reasons: check.reasons })) });
  if (scored.outcome !== "ok") return fallback(scored.outcome);

  const proposals = proposalsOf(call.value) as CreativeProposal[];
  const valid = scored.checks.filter(check => check.ok).map(check => ({ check, proposal: proposals[check.index] }));
  const chosen = await review(context, measure, valid);
  if (!chosen) return fallback("rejected_all");
  // Recompute from the proposal itself so the displayed number is exactly the code's division.
  const recheck = checkProposalFor(chosen.proposal, chosen.check.index, measure);
  if (!recheck.ok) return fallback("number_mismatch");
  return finish(200, { result: modelResult(measure, recheck, chosen.proposal, chosen.checkedByJev, history) }, "model", measure);
}

function proposalsOf(response: unknown): unknown[] {
  const value = responseContent(response).value;
  return value && typeof value === "object" && Array.isArray((value as { proposals?: unknown }).proposals) ? (value as { proposals: unknown[] }).proposals : [];
}
