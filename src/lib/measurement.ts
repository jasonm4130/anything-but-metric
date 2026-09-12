import { createUnit, unit } from "mathjs";
import { resolveUnitSpelling, type UnitSpellingCandidate } from "./unit-spelling";

createUnit("cal", { definition: "4.184 J", prefixes: "short" });

export type InterpretedMeasurement = { recognized: boolean; quantity: number; sourceUnit: string };
export type MeasurementParser = (input: string) => Promise<InterpretedMeasurement>;

const numberPattern = "[-+]?(?:(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?";
const quantityPattern = `(?:${numberPattern}\\s+${numberPattern}\\s*/\\s*${numberPattern}|${numberPattern}\\s*/\\s*${numberPattern}|${numberPattern})`;
const literalPattern = new RegExp(`^(${quantityPattern})\\s*(.+?)\\s*$`);
const quantityOnlyPattern = new RegExp(`^${quantityPattern}$`);
const fractionPattern = new RegExp(`^(${numberPattern})\\s*/\\s*(${numberPattern})$`);
const mixedNumberPattern = new RegExp(`^(${numberPattern})\\s+(${numberPattern})\\s*/\\s*(${numberPattern})$`);
const mixedUnitPattern = new RegExp(`[A-Za-z°µμ]\\s*${quantityPattern}\\s*[A-Za-z°µμ]`);
const numericStart = /^[+-]?(?:\d|\.)/;
const safeUnit = /^[A-Za-z°µμ²³0-9^*/.·\-\s]+$/;

function numericValue(text: string): number {
  const value = Number(text.replace(/,/g, ""));
  return !Number.isFinite(value) || (value === 0 && /[1-9]/.test(text.split(/[eE]/)[0])) ? NaN : value;
}

/** Evaluate only a complete literal quantity, never model-authored arithmetic. */
function quantityValue(text: string): number {
  const mixed = mixedNumberPattern.exec(text);
  const fraction = mixed ?? fractionPattern.exec(text);
  if (!fraction) return numericValue(text);
  const numerator = numericValue(fraction[mixed ? 2 : 1]);
  const denominator = numericValue(fraction[mixed ? 3 : 2]);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return NaN;
  const ratio = numerator / denominator;
  if (!Number.isFinite(ratio) || (ratio === 0 && numerator !== 0)) return NaN;
  if (!mixed) return ratio;
  const whole = numericValue(mixed[1]);
  if (!Number.isInteger(whole) || numerator < 0 || denominator <= 0 || numerator >= denominator) return NaN;
  const magnitude = Math.abs(whole) + ratio;
  if (!Number.isFinite(magnitude) || (ratio > 0 && magnitude === Math.abs(whole))) return NaN;
  return mixed[1].startsWith("-") ? -magnitude : magnitude;
}

function spelledFraction(input: string): InterpretedMeasurement | null {
  const match = /^(one and a half|three quarters|(?:a |one )?quarter|(?:a |one )?half)\s+(?:of\s+)?(?:(?:a|an)\s+)?(.+)$/i.exec(input);
  if (!match) return null;
  const sourceUnit = normalizeMeasurementUnit(match[2]);
  if (unresolvedUnitNumber(sourceUnit)) return null;
  // Only a complete supported unit earns the local path; keep all prose for the parser.
  if (!supportedUnit(sourceUnit)) return null;
  const phrase = match[1].toLowerCase();
  const quantity = phrase === "one and a half" ? 1.5 : phrase === "three quarters" ? 0.75 : phrase.endsWith("quarter") ? 0.25 : 0.5;
  return { recognized: true, quantity, sourceUnit };
}

function unresolvedUnitNumber(value: string): boolean {
  if (!/\d/.test(value)) return false;
  // Parse the unit by itself: unit(1, "2 L") silently ignores its embedded 2.
  // Unit powers and names such as mmH2O have no numeric value and remain valid.
  try { return unit(value).value !== null; } catch { return true; }
}

const names: Record<string, string> = {
  metre: "m", metres: "m", meter: "m", meters: "m",
  gram: "g", grams: "g", second: "s", seconds: "s",
  litre: "L", litres: "L", liter: "L", liters: "L",
  joule: "J", joules: "J", jouls: "J", watt: "W", watts: "W",
  pascal: "Pa", pascals: "Pa", newton: "N", newtons: "N",
  hertz: "Hz", hz: "Hz", byte: "byte", bytes: "byte", bit: "bit", bits: "bit",
  tonne: "tonne", tonnes: "tonne", year: "year", years: "year", y: "year",
  hour: "h", hours: "h", minute: "min", minutes: "min",
  calorie: "cal", calories: "cal", mph: "mi/h", kph: "km/h"
};

const prefixes: Array<[string, string]> = [
  ["deca", "da"], ["hecto", "h"], ["kilo", "k"], ["mega", "M"], ["giga", "G"],
  ["tera", "T"], ["peta", "P"], ["centi", "c"], ["milli", "m"], ["micro", "u"], ["nano", "n"]
];

function namedUnit(word: string, original: string): string | null {
  const lower = word.toLowerCase();
  if ((lower === "calorie" || lower === "calories") && (original === "Calorie" || original === "Calories")) return "kcal";
  if (names[lower]) return names[lower];
  for (const [prefix, symbol] of prefixes) {
    if (!lower.startsWith(prefix)) continue;
    const base = names[lower.slice(prefix.length)];
    if (base) return `${symbol}${base === "byte" ? "B" : base === "bit" ? "b" : base}`;
  }
  return null;
}

function normalizePart(part: string): string | null {
  const trimmed = part.trim();
  if (!trimmed) return null;
  if (/^°\s*[cC]$/.test(trimmed) || /^degrees?\s+celsius$/i.test(trimmed) || /^celsius$/i.test(trimmed)) return "degC";
  if (/^°\s*[fF]$/.test(trimmed) || /^degrees?\s+fahrenheit$/i.test(trimmed) || /^fahrenheit$/i.test(trimmed)) return "degF";
  const square = /^(?:square|squared)\s+(.+)$/i.exec(trimmed) ?? /^(.+)\s+squared$/i.exec(trimmed);
  if (square) {
    const base = normalizePart(square[1]);
    return base ? `${base}^2` : null;
  }
  const cubic = /^(?:cubic|cubed)\s+(.+)$/i.exec(trimmed) ?? /^(.+)\s+cubed$/i.exec(trimmed);
  if (cubic) {
    const base = normalizePart(cubic[1]);
    return base ? `${base}^3` : null;
  }
  const symbol = trimmed.replace(/²/g, "^2").replace(/³/g, "^3");
  if (symbol !== trimmed) return normalizePart(symbol);
  if (/^[A-Za-z]+$/.test(trimmed)) return namedUnit(trimmed, trimmed) ?? trimmed;
  return trimmed;
}

function matchingUnitAnnotation(value: string): string | null {
  const annotated = /^([A-Za-z ]+)\s+\(([A-Za-z°µμ]+)\)$/.exec(value);
  if (annotated) {
    const name = normalizePart(annotated[1]);
    const symbol = normalizePart(annotated[2]);
    if (name && name !== annotated[1].trim() && name === symbol) return name;
  }
  return null;
}

/** Normalizes a small set of human unit spellings without changing unit-symbol case. */
export function normalizeMeasurementUnit(value: string): string {
  const raw = value.trim().replace(/[.,!?]+$/, "").replace(/\s+/g, " ");
  if (!raw) return raw;
  const annotation = matchingUnitAnnotation(raw);
  if (annotation) return annotation;
  const expression = raw.replace(/\bper\b/gi, "/").replace(/\s*\/\s*/g, "/");
  const normalized = expression.split("/").map(part => normalizePart(part) ?? part.trim()).join("/");
  if (/^1\s*\//.test(normalized)) {
    try { return unit(1, normalized).formatUnits(); } catch { return normalized; }
  }
  if (supportedUnit(normalized)) return normalized;
  return resolveUnitSpelling(normalized, spellingCandidates) ?? normalized;
}

function supportedUnit(value: string): boolean {
  try {
    unit(1, value);
    return true;
  } catch {
    return false;
  }
}

// Derive spelling candidates from existing supported names, rather than adding typo aliases.
const spellingCandidates: UnitSpellingCandidate[] = [
  ...Object.entries(names).map(([word, canonicalUnit]) => ({ word, canonicalUnit })),
  ...prefixes.flatMap(([prefix, symbol]) => Object.entries(names).map(([word, base]) => ({
    word: `${prefix}${word}`, canonicalUnit: `${symbol}${base === "byte" ? "B" : base === "bit" ? "b" : base}`
  }))),
  { word: "Calorie", canonicalUnit: "kcal" }, { word: "Calories", canonicalUnit: "kcal" }
].filter(candidate => supportedUnit(candidate.canonicalUnit));

/** Complete additive literals are arithmetic, not a request for model interpretation. */
function additiveMeasurement(input: string): InterpretedMeasurement | "invalid" | null {
  const component = new RegExp(`\\s*(${quantityPattern})\\s*(degrees?\\s+(?:celsius|fahrenheit)|°\\s*[cCfF]|[A-Za-zµμ]+)`, "iy");
  const components: Array<{ text: string; quantity: number; sourceUnit: string }> = [];
  let end = 0;
  for (;;) {
    component.lastIndex = end;
    const match = component.exec(input);
    if (!match) break;
    components.push({ text: match[1], quantity: quantityValue(match[1]), sourceUnit: normalizeMeasurementUnit(match[2]) });
    end = component.lastIndex;
  }
  const remainder = input.slice(end).trim();
  // A dangling numeric component or explicit sum must not be silently discarded.
  if (components.length && /^(?:[+\-\d]|\.\d)/.test(remainder) && (components.length > 1 || /^[+\-]/.test(remainder))) return "invalid";
  if (components.length < 2 || (remainder && !/^[.!?]+$/.test(remainder))) return null;
  if (components.some(part => /^[+-]/.test(part.text) || !Number.isFinite(part.quantity) || part.quantity < 0)) return "invalid";
  try {
    const units = components.map(part => unit(1, part.sourceUnit));
    // Absolute temperatures (including kelvin) do not form additive measurements.
    if (units[0].equalBase(unit(1, "K")) || units.some(value => !value.equalBase(units[0]))) return "invalid";
    const scales = units.map(value => Number(value.toSI().value));
    if (scales.some(value => !Number.isFinite(value) || value <= 0)) return "invalid";
    const sourceUnit = components[scales.indexOf(Math.min(...scales))].sourceUnit;
    let quantity = 0;
    for (const part of components) {
      const converted = unit(part.quantity, part.sourceUnit).toNumber(sourceUnit);
      const total = quantity + converted;
      if (!Number.isFinite(total) || (part.quantity > 0 && converted === 0) || (quantity > 0 && converted > 0 && (total === quantity || total === converted))) return "invalid";
      quantity = total;
    }
    return { recognized: true, quantity, sourceUnit };
  } catch {
    return "invalid";
  }
}

function literalMeasurement(input: string): { quantity: number; rawUnit: string } | "invalid" | null {
  if (quantityOnlyPattern.test(input)) return "invalid";
  if (/^[+-]?(?:\d[\d,]*(?:\.\d*)?|\.\d+)[eE](?:\s|$)/.test(input)) return "invalid";
  const match = literalPattern.exec(input);
  if (!match) return numericStart.test(input) ? "invalid" : null;
  const quantity = quantityValue(match[1]);
  const rawUnit = match[2].trim().replace(/[.!?]+$/, "");
  if ((/^[\d.,+-]/.test(rawUnit) && !/^1\s*\//.test(rawUnit)) || /^[eE][+-]?(?:\s|$)/.test(rawUnit)) return "invalid";
  // Parentheses are allowed only for a fully matching spelled name + symbol.
  // The annotation contains no numbers or operators, so no quantity can be discarded.
  const annotation = matchingUnitAnnotation(rawUnit);
  if (!Number.isFinite(quantity) || (!safeUnit.test(rawUnit) && !annotation)) return "invalid";
  const normalizedUnit = normalizeMeasurementUnit(annotation ?? rawUnit);
  if (supportedUnit(normalizedUnit) && !unresolvedUnitNumber(normalizedUnit)) return { quantity, rawUnit: annotation ?? rawUnit };
  if (mixedUnitPattern.test(rawUnit)) return null;
  if (/^(?:thousand|million|billion)/i.test(rawUnit)) return null;
  if (unresolvedUnitNumber(normalizedUnit)) return "invalid";
  return { quantity, rawUnit: annotation ?? rawUnit };
}

/**
 * Preserves complete supported literals locally. Unknown but safe literal units may use
 * the parser, but it cannot replace the number the user wrote.
 */
export async function interpretMeasurement(input: string, parser: MeasurementParser): Promise<InterpretedMeasurement> {
  const spelled = spelledFraction(input.trim());
  if (spelled) return spelled;
  const literal = literalMeasurement(input.trim());
  // Complete unit names can contain digits (mmH2O); do not split those as a sum.
  const literalUnit = literal && literal !== "invalid" ? normalizeMeasurementUnit(literal.rawUnit) : null;
  if (literal && literal !== "invalid" && literalUnit && supportedUnit(literalUnit)) return { recognized: true, quantity: literal.quantity, sourceUnit: literalUnit };
  const additive = additiveMeasurement(input.trim());
  if (additive === "invalid") return { recognized: false, quantity: 0, sourceUnit: "m" };
  if (additive) return additive;
  if (literal === "invalid") return { recognized: false, quantity: 0, sourceUnit: "m" };
  if (literal) {
    const parsed = await parser(input);
    const normalizedUnit = normalizeMeasurementUnit(parsed.sourceUnit);
    if (!parsed.recognized || !Number.isFinite(parsed.quantity) || parsed.quantity !== literal.quantity || !supportedUnit(normalizedUnit)) {
      return { recognized: false, quantity: 0, sourceUnit: "m" };
    }
    return { recognized: true, quantity: literal.quantity, sourceUnit: normalizedUnit };
  }
  const parsed = await parser(input);
  const sourceUnit = normalizeMeasurementUnit(parsed.sourceUnit);
  return { ...parsed, sourceUnit };
}
