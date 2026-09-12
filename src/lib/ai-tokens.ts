import benchmark from "../data/ai-token-energy.json";
import { energyDurationRangePool, menuFromComparisons, type ComparisonPacket, type ComparisonResult } from "./comparison-flow";
import { formatNumber } from "./convert";
import { recentFamilyLimit } from "./scene-packets";

export type TokenUsage = { kind: "tokens"; tokens: number; assumedOutput: boolean };
type InvalidTokens = { kind: "invalid"; message: string };
const countPattern = "(?:[+-]?(?:(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)";
const tokenLiteral = new RegExp(`^(?:i (?:used|generated)|my (?:ai )?usage was|i've used)?\\s*(${countPattern})\\s*(k|m|b|thousand|million|billion)?\\s*(?:(?:ai|llm)\\s+)?(?:(generated|output|reasoning)\\s+)?tokens?(?:\\s+(?:today|this week|this month))?[.!]?$`, "i");
const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const magnitudePowers: Record<string, number> = { k: 3, thousand: 3, m: 6, million: 6, b: 9, billion: 9 };

/** Expand a bounded decimal exactly before converting the whole count to Number. */
function exactTokenCount(raw: string, magnitude: number): number | undefined {
  if (Object.hasOwn(words, raw)) return words[raw] * 10 ** magnitude;
  if (raw.startsWith("-")) return undefined;
  const [mantissa, exponentText = "0"] = raw.replace(/^\+/, "").split("e");
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent)) return undefined;
  const fractionLength = mantissa.split(".")[1]?.length ?? 0;
  let digits = mantissa.replace(".", "").replace(/^0+/, "");
  if (!digits) return 0;
  const shift = exponent + magnitude - fractionLength;
  if (shift < 0) {
    const trim = -shift;
    if (trim > digits.length || !digits.endsWith("0".repeat(trim))) return undefined;
    digits = digits.slice(0, -trim);
  } else {
    if (digits.length + shift > 16) return undefined;
    digits += "0".repeat(shift);
  }
  const count = BigInt(digits || "0");
  return count <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(count) : undefined;
}
const invalidCount = (): InvalidTokens => ({ kind: "invalid", message: "Try a whole, non-negative count such as 1 million AI tokens or 250k output tokens." });

/** A complete local count, never a partial extraction from instructions or mixed usage. */
export function parseTokenUsage(input: string): TokenUsage | InvalidTokens | undefined {
  if (!/tokens?\b/i.test(input)) return undefined;
  if (/\b(?:input|prompt|cached?|total)\b/i.test(input)) return { kind: "invalid", message: "This estimate uses generated/output tokens. Input, cached and combined totals need different evidence; try your output-token count." };
  const match = tokenLiteral.exec(input.trim());
  if (!match) return invalidCount();
  const raw = match[1].toLowerCase().replaceAll(",", "");
  const tokens = exactTokenCount(raw, magnitudePowers[match[2]?.toLowerCase()] ?? 0);
  if (tokens === undefined) return invalidCount();
  return { kind: "tokens", tokens, assumedOutput: !/^(generated|output|reasoning)$/i.test(match[3] ?? "") };
}

export function tokenEnergy(usage: TokenUsage) {
  if (!Number.isSafeInteger(usage.tokens) || usage.tokens < 0) throw new Error("invalid_token_count");
  return { min: usage.tokens * benchmark.joulesPerGeneratedToken.min, max: usage.tokens * benchmark.joulesPerGeneratedToken.max };
}

export function tokenComparisonMenu(usage: TokenUsage, history: string[] = [], seed = 0): ComparisonPacket[] {
  const energy = tokenEnergy(usage);
  const qualifier = `${usage.assumedOutput ? "Treating unspecified tokens as generated/output tokens. " : ""}Illustrative GPU-only estimate from two benchmark configurations; your model may use more or less.`;
  const basis = `${formatNumber(usage.tokens)} generated tokens × ${benchmark.joulesPerGeneratedToken.min}–${benchmark.joulesPerGeneratedToken.max} J/token = approximately ${formatNumber(energy.min)}–${formatNumber(energy.max)} J. ${benchmark.model}, ${benchmark.hardware}: ${benchmark.lowerScenario} versus ${benchmark.upperScenario}. ${benchmark.measurementBoundary} ${benchmark.exclusions}`;
  const candidates: ComparisonPacket[] = usage.tokens === 0 ? [{ id: "zero", family: "ai-token-zero", families: ["ai-token-zero"], mechanism: "zero-token-allocation", headline: "Zero output tokens: zero energy allocated by this estimate.", assumption: "", basis: "A running but idle GPU can still consume electricity. This is a token-based allocation, not a meter reading.", sources: [], computed: { min: 0, max: 0, unit: "J" } }] : energyDurationRangePool(energy.min, energy.max);
  const pool = candidates.map(packet => ({ ...packet,
    id: `ai-tokens:${packet.id}`, assumption: qualifier,
    basis: `${basis} ${packet.basis}`,
    sources: [{ title: benchmark.sourceTitle, url: benchmark.sourceUrl, note: benchmark.sourceNote }, ...packet.sources]
  }));
  return menuFromComparisons(pool, history, seed);
}

export function tokenComparisonResult(packet: ComparisonPacket, usage: TokenUsage, history: string[] = []): ComparisonResult {
  const energy = tokenEnergy(usage);
  const wattHours = energy.max === 0 ? "0 Wh" : `${formatNumber(energy.min / 3600)}–${formatNumber(energy.max / 3600)} Wh`;
  return { packetId: packet.id, family: packet.family, headline: packet.headline, assumption: packet.assumption, basis: packet.basis, sources: packet.sources,
    dimension: "ai-tokens", quantity: usage.tokens, sourceUnit: "output tokens", interpretation: `${usage.tokens} ${usage.assumedOutput ? "tokens, assumed to be generated/output tokens" : "generated/output tokens"}`,
    recentFamilies: [...history.filter(f => !packet.families.includes(f)), ...packet.families].slice(-recentFamilyLimit),
    estimate: { label: benchmark.label, summary: `About ${wattHours} of GPU energy in the benchmark scenarios.`, energyJoules: energy, profileId: benchmark.id }
  };
}
