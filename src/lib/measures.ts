import { unit, type Unit } from "mathjs";
import { formatNumber, validateMeasurement } from "./convert";
import { normalizeMeasurementUnit } from "./measurement";

/**
 * A measurement the model-led flow can divide: a physical quantity with a Math.js unit,
 * an amount of one currency, or a count of a named item (food portions are counts too).
 * Code owns only arithmetic here: unit factors and division. Interpretation and estimates
 * come from models and Jev; these helpers keep them dimensionally honest.
 */
export type MeasureKind = "physical" | "currency" | "count";
export type Measure = {
  kind: MeasureKind;
  quantity: number;
  /** Math.js unit for physical measures, ISO 4217 code for currency, "count" for counts. */
  unit: string;
  /** Physical dimension name, "money" or "count". */
  dimension: string;
  /** Singular noun phrase for counts, such as "slice of pizza". */
  item?: string;
  /** Plural noun phrase for counts, such as "slices of pizza". */
  items?: string;
  /** Present when a model estimated the amount rather than reading it from the input. */
  estimate?: { subject: string; perUnit: number; perUnitUnit: string; written: string };
};

export const maxCount = 1e18;
export const currencyCodes = ["USD", "AUD", "CAD", "NZD", "GBP", "EUR", "JPY", "CNY", "INR", "KRW", "CHF", "SEK", "NOK", "DKK", "SGD", "HKD", "MXN", "BRL", "ZAR", "RUB", "TRY", "ILS", "NGN", "THB", "PLN", "BTC"] as const;
const codes = new Set<string>(currencyCodes);

const symbols: [RegExp, string][] = [
  [/^(?:US\$|USD\$)/i, "USD"], [/^(?:A\$|AU\$|AUD\$)/i, "AUD"], [/^(?:C\$|CA\$|CAD\$)/i, "CAD"], [/^NZ\$/i, "NZD"],
  [/^HK\$/i, "HKD"], [/^S\$/i, "SGD"], [/^R\$/, "BRL"], [/^\$/, "USD"], [/^£/, "GBP"], [/^€/, "EUR"], [/^¥/, "JPY"],
  [/^₹/, "INR"], [/^₩/, "KRW"], [/^₽/, "RUB"], [/^₺/, "TRY"], [/^₪/, "ILS"], [/^₦/, "NGN"], [/^฿/, "THB"], [/^₿/, "BTC"]
];
const words: [RegExp, string, number][] = [
  [/^(?:us |american )?dollars?$|^bucks?$/i, "USD", 1], [/^(?:australian|aussie) dollars?$/i, "AUD", 1], [/^canadian dollars?$/i, "CAD", 1],
  [/^euros?$/i, "EUR", 1], [/^(?:pounds? sterling|british pounds?|quid)$/i, "GBP", 1], [/^yen$/i, "JPY", 1], [/^(?:indian )?rupees?$/i, "INR", 1],
  [/^yuan$|^renminbi$/i, "CNY", 1], [/^bitcoins?$/i, "BTC", 1], [/^cents?$/i, "USD", 0.01], [/^pence$/i, "GBP", 0.01]
];
const scales: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, tn: 1e12, trillion: 1e12 };
const amountPattern = "(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?|\\.\\d+)";
const scalePattern = "(k|thousand|mn?|million|bn?|billion|tn?|trillion)?";

function scaled(amount: string, scale: string | undefined): number {
  const value = Number(amount.replace(/,/g, ""));
  return value * (scale ? scales[scale.toLowerCase()] : 1);
}

/** Recognise money written with a symbol, ISO code or common currency word. */
export function localCurrency(input: string): Measure | undefined {
  const text = input.trim().replace(/[.!?]+$/, "");
  for (const [pattern, code] of symbols) {
    const symbol = pattern.exec(text);
    if (!symbol) continue;
    const rest = new RegExp(`^\\s*${amountPattern}\\s*${scalePattern}$`, "i").exec(text.slice(symbol[0].length));
    return rest ? currency(scaled(rest[1], rest[2]), code) : undefined;
  }
  const prefixed = new RegExp(`^([A-Za-z]{3})\\s*${amountPattern}\\s*${scalePattern}$`, "i").exec(text);
  if (prefixed && codes.has(prefixed[1].toUpperCase())) return currency(scaled(prefixed[2], prefixed[3]), prefixed[1].toUpperCase());
  const suffixed = new RegExp(`^${amountPattern}\\s*${scalePattern}\\s+([A-Za-z ]+)$`, "i").exec(text) ?? new RegExp(`^${amountPattern}\\s*(k|bn|mn|tn)?\\s*([A-Za-z]{3})$`, "i").exec(text);
  if (!suffixed) return undefined;
  const name = suffixed[3].trim();
  if (codes.has(name.toUpperCase()) && /^[A-Za-z]{3}$/.test(name)) return currency(scaled(suffixed[1], suffixed[2]), name.toUpperCase());
  for (const [pattern, code, factor] of words) if (pattern.test(name)) return currency(scaled(suffixed[1], suffixed[2]) * factor, code);
  return undefined;
}

export function currency(quantity: number, code: string): Measure | undefined {
  const upper = code.trim().toUpperCase();
  if (!codes.has(upper) || !Number.isFinite(quantity) || quantity < 0) return undefined;
  return { kind: "currency", quantity, unit: upper, dimension: "money" };
}

export function count(quantity: number, item: string, items?: string): Measure | undefined {
  const singular = item.trim().replace(/\s+/g, " ");
  if (!Number.isFinite(quantity) || quantity < 0 || quantity > maxCount || !singular || singular.length > 80 || /[<>{}]|https?:/i.test(singular)) return undefined;
  const plural = (items ?? "").trim().replace(/\s+/g, " ");
  return { kind: "count", quantity, unit: "count", dimension: "count", item: singular, items: plural && plural.length <= 80 && !/[<>{}]|https?:/i.test(plural) ? plural : singular };
}

const derivedDimensions: [string, string][] = [
  ["voltage", "V"], ["electrical resistance", "ohm"], ["electric charge", "C"], ["capacitance", "F"], ["inductance", "H"],
  ["magnetic flux", "Wb"], ["magnetic field", "T"], ["amount of substance", "mol"], ["luminous intensity", "cd"],
  ["acceleration", "m/s^2"], ["density", "kg/m^3"], ["flow rate", "m^3/s"], ["data rate", "b/s"], ["mass flow", "kg/s"]
];

/** A physical measure for any Math.js unit, not only the fourteen catalogue dimensions. */
export function physical(quantity: number, sourceUnit: string): Measure | undefined {
  try {
    const validated = validateMeasurement(quantity, sourceUnit);
    let dimension = validated.dimension;
    if (dimension === "other") {
      const source = unit(1, validated.sourceUnit);
      dimension = derivedDimensions.find(([, representative]) => { try { return source.equalBase(unit(1, representative)); } catch { return false; } })?.[0] ?? "quantity";
    }
    return { kind: "physical", quantity: validated.quantity, unit: validated.sourceUnit, dimension };
  } catch {
    return undefined;
  }
}

/**
 * Units whose everyday reading depends on who is asking. Jev chooses among the readings;
 * the first is Math.js's default and the answer when Jev is unavailable.
 */
const ambiguous: [RegExp, { description: string; reading: (quantity: number) => Measure | undefined }[]][] = [
  [/^pounds?$/i, [
    { description: "pounds of weight (avoirdupois mass)", reading: q => physical(q, "lb") },
    { description: "British pounds sterling (money)", reading: q => currency(q, "GBP") }
  ]],
  [/^(?:ounces?|oz)$/i, [
    { description: "ounces of weight (mass)", reading: q => physical(q, "oz") },
    { description: "US fluid ounces (volume)", reading: q => physical(q, "floz") }
  ]],
  [/^tons?$/i, [
    { description: "US short tons (2,000 lb)", reading: q => physical(q, "ton") },
    { description: "metric tonnes (1,000 kg)", reading: q => physical(q, "tonne") },
    { description: "British long tons (2,240 lb)", reading: q => physical(q * 1016.0469088, "kg") }
  ]],
  [/^(?:gallons?|gal)$/i, [
    { description: "US gallons", reading: q => physical(q, "gal") },
    { description: "imperial (UK) gallons", reading: q => physical(q * 4.54609, "L") }
  ]],
  [/^pints?$/i, [
    { description: "US pints", reading: q => physical(q, "pint") },
    { description: "imperial (UK) pints", reading: q => physical(q * 568.26125, "mL") }
  ]],
  [/^cups?$/i, [
    { description: "US customary cups", reading: q => physical(q, "cup") },
    { description: "metric cups (250 mL)", reading: q => physical(q * 250, "mL") }
  ]]
];

export type Reading = { id: string; description: string; measure: Measure };

/** Every defensible reading of "<number> <ambiguous unit>", or undefined when the input is not that shape. */
export function ambiguousReadings(input: string): Reading[] | undefined {
  const literal = new RegExp(`^${amountPattern}\\s*([A-Za-z]+)\\.?$`).exec(input.trim());
  if (!literal) return undefined;
  const quantity = Number(literal[1].replace(/,/g, ""));
  const word = literal[2];
  const match = ambiguous.find(([pattern]) => pattern.test(word));
  if (!match) return undefined;
  const readings = match[1].flatMap((option, index) => {
    const measure = option.reading(quantity);
    return measure ? [{ id: `reading_${index + 1}`, description: option.description, measure }] : [];
  });
  return readings.length > 1 ? readings : undefined;
}

/** Display form of a measure, preserving the quantity used for arithmetic. */
export function describeMeasure(measure: Measure): string {
  const rounded = Number(measure.quantity.toPrecision(15));
  const prefix = measure.estimate || rounded !== measure.quantity ? "≈ " : "";
  const amount = measure.estimate ? formatNumber(measure.quantity) : `${rounded}`;
  if (measure.kind === "currency") return `${prefix}${amount} ${measure.unit}`;
  if (measure.kind === "count") return `${prefix}${amount} ${measure.quantity === 1 ? measure.item : measure.items}`;
  return `${prefix}${amount} ${measure.unit}`;
}

function parsed(value: number, name: string): Unit | undefined {
  try {
    return unit(value, name);
  } catch {
    return undefined;
  }
}

const unitAliases: [RegExp, string][] = [[/[µμ]/g, "u"], [/^microns?$/i, "um"], [/^(?:°|degrees? of arc)$/i, "deg"], [/^yrs?$/i, "year"], [/^metric tons?$/i, "tonne"]];
/** Normalise unit spellings models commonly emit that the measurement normaliser does not cover. */
export function modelUnit(name: string): string {
  const aliased = unitAliases.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), name.trim());
  return normalizeMeasurementUnit(aliased);
}

export type RatioCheck = { count: number } | { reason: "unit_unparsed" | "dimension_mismatch" | "invalid_value" | "invalid_measurement" };

/** How many references fit in the measure. The only arithmetic in the model-led flow. */
export function referenceRatio(measure: Measure, value: unknown, referenceUnit: unknown): RatioCheck {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return { reason: "invalid_value" };
  if (typeof referenceUnit !== "string" || !referenceUnit.trim()) return { reason: "unit_unparsed" };
  if (measure.kind === "currency") {
    const code = referenceUnit.trim().toUpperCase();
    const symbol = symbols.find(([pattern]) => pattern.test(referenceUnit.trim()))?.[1];
    return code === measure.unit || symbol === measure.unit ? { count: measure.quantity / value } : { reason: codes.has(code) || symbol ? "dimension_mismatch" : "unit_unparsed" };
  }
  if (measure.kind === "count") {
    // Count references are stated in the counted item: "count", "items" or the item's own name.
    const name = referenceUnit.trim().toLowerCase();
    const head = (measure.item ?? "").toLowerCase().split(/\s+of\s+/)[0].split(/\s+/).at(-1) ?? "";
    const plainCount = /^(?:count|counts|items?|units?|pieces?|each|x)$/.test(name);
    const namesItem = head.length >= 3 && name.includes(head.replace(/(?:es|s)$/, ""));
    if (plainCount || namesItem) return { count: measure.quantity / value };
    return { reason: parsed(1, modelUnit(referenceUnit)) ? "dimension_mismatch" : "unit_unparsed" };
  }
  const source = parsed(measure.quantity, measure.unit);
  if (!source) return { reason: "invalid_measurement" };
  const reference = parsed(value, modelUnit(referenceUnit));
  if (!reference) return { reason: "unit_unparsed" };
  try {
    if (!source.equalBase(reference) || source.equalBase(unit(1, "K"))) return { reason: "dimension_mismatch" };
    return { count: (source.toSI().value as number) / (reference.toSI().value as number) };
  } catch {
    return { reason: "dimension_mismatch" };
  }
}
