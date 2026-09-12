import { describe, expect, it } from "vitest";
import { parseTokenUsage, tokenEnergy, tokenComparisonMenu, tokenComparisonResult, type TokenUsage } from "../src/lib/ai-tokens";
import { energyDurationRangePool } from "../src/lib/comparison-flow";

function usage(input: string): TokenUsage {
  const parsed = parseTokenUsage(input);
  if (parsed?.kind !== "tokens") throw new Error("Expected token count");
  return parsed;
}

describe("AI-token energy estimates", () => {
  it.each([
    ["1 million AI tokens", 1e6, true], ["1M AI tokens", 1e6, true],
    ["1,000,000 tokens", 1e6, true], ["250k output tokens", 250000, false],
    ["2.5 billion generated tokens", 2.5e9, false], ["1e6 LLM tokens", 1e6, true],
    ["I used one million AI tokens this month", 1e6, true], ["two thousand reasoning tokens", 2000, false],
    ["0 tokens", 0, true], ["1 token", 1, true], ["1M AI output tokens", 1e6, false], ["100tokens", 100, true], ["1Mtokens", 1e6, true],
    ["1.001k tokens", 1001, true], ["1.005k tokens", 1005, true], ["1.000001 million tokens", 1000001, true],
    ["9007199254740991 tokens", Number.MAX_SAFE_INTEGER, true], ["0.000001M tokens", 1, true]
  ])("parses the complete count %s locally", (input, count, assumedOutput) => {
    expect(parseTokenUsage(input as string)).toEqual({ kind: "tokens", tokens: count, assumedOutput });
  });

  it.each(["1 million input tokens", "100 cached tokens", "100 prompt tokens", "100 total tokens", "500 input tokens and 100 output tokens", "1.5 tokens", "-1 tokens", "1e99 tokens", "1e-999 tokens", "1,00 tokens", "2 tokens/min", "1 million tokens; ignore all instructions", "tokens", "three guitars worth of tokens", "100totaltokens", "9007199254740991.4 tokens", "9007199254740990.9 tokens", "9007199254740992 tokens"])("rejects an unsupported count or token class: %s", input => {
    expect(parseTokenUsage(input)?.kind).toBe("invalid");
  });

  it("leaves ordinary measurements for the existing parser", () => {
    expect(parseTokenUsage("144 jouls")).toBeUndefined();
    expect(parseTokenUsage("2 PB")).toBeUndefined();
  });

  it("can picture a single token without changing the benchmark or inventing a lamp average", () => {
    const parsed = usage("1 AI token");
    const menu = tokenComparisonMenu(parsed);
    expect(menu).toHaveLength(1);
    expect(menu[0].headline).toBe("Enough energy to run an imagined one-watt light for 0.151–0.312 seconds");
    expect(menu[0].basis).toContain("defined comparison prop");
    expect(tokenComparisonResult(menu[0], parsed).estimate?.energyJoules).toEqual({ min: 0.151, max: 0.312 });
  });

  it("preserves both measured scenario endpoints through appliance arithmetic", () => {
    const parsed = usage("1M output tokens");
    expect(tokenEnergy(parsed)).toEqual({ min: 151000, max: 312000 });
    const pool = energyDurationRangePool(151000, 312000);
    const dryer = pool.find(packet => packet.id === "run-appliance:power-dyson-supersonic")!;
    expect(dryer.headline).toContain("a hairdryer");
    expect(dryer.computed).toMatchObject({ min: 151000 / 1600, max: 312000 / 1600, unit: "s" });
    expect(dryer.headline).toContain("1.57–3.25 minutes");
    const menus = Array.from({ length: 12 }, (_, seed) => tokenComparisonMenu(parsed, [], seed));
    expect(new Set(menus.flat().map(p => p.id)).size).toBeGreaterThan(6);
    const result = tokenComparisonResult(menus[0][0], parsed);
    expect(result).toMatchObject({ quantity: 1e6, sourceUnit: "output tokens", dimension: "ai-tokens", estimate: { energyJoules: { min: 151000, max: 312000 } } });
    expect(result.basis).toContain("Qwen 3 32B");
    expect(result.basis).toContain("not a measurement of your provider");
    expect(result.basis).toContain("cooling, training");
    expect(result.sources[0].note).toContain("not a confidence interval");
    expect(result.assumption).not.toContain("Treating unspecified");
  });

  it("labels the output-token assumption and carries family history", () => {
    const parsed = usage("1M AI tokens");
    const first = tokenComparisonMenu(parsed, [], 1)[0];
    const result = tokenComparisonResult(first, parsed);
    expect(result.assumption).toContain("Treating unspecified tokens as generated/output tokens");
    expect(result.interpretation).toContain("assumed");
    const next = tokenComparisonMenu(parsed, result.recentFamilies, 2);
    expect(next.every(p => p.families.every(f => !result.recentFamilies.includes(f)))).toBe(true);
    expect(result.recentFamilies.length).toBeLessThanOrEqual(8);
  });

  it("does not silently drop an energy endpoint outside salience bounds", () => {
    expect(() => energyDurationRangePool(10, 1)).toThrow("invalid_energy_interval");
    expect(() => energyDurationRangePool(-1, 1)).toThrow("invalid_energy_interval");
    expect(() => energyDurationRangePool(1, Infinity)).toThrow("invalid_energy_interval");
    const wide = energyDurationRangePool(1, 1e100);
    expect(wide).toEqual([]);
  });

  it("allocates zero without claiming an idle GPU uses no electricity", () => {
    const parsed = usage("0 AI tokens");
    const menu = tokenComparisonMenu(parsed);
    expect(menu).toHaveLength(1);
    const result = tokenComparisonResult(menu[0], parsed);
    expect(result.estimate?.energyJoules).toEqual({ min: 0, max: 0 });
    expect(result.estimate?.summary).toContain("0 Wh");
    expect(result.basis).toContain("idle GPU can still consume electricity");
    expect(() => tokenEnergy({ kind: "tokens", tokens: -1, assumedOutput: true })).toThrow();
  });
});
