import { unit, type Unit } from "mathjs";
import { normalizeMeasurementUnit } from "./measurement";

export type ModelChoice = {
  quantity: number;
  sourceUnit: string;
  referenceQuantity: number;
  referenceUnit: string;
  referenceLabel: string;
  assumption: string;
  quip?: string;
};

export type Conversion = {
  dimension: string;
  quantity: number;
  sourceUnit: string;
  referenceLabel: string;
  value: number;
  displayValue: string;
  assumption: string;
  quip?: string;
  headline: string;
  interpretation: string;
};

export type ValidatedMeasurement = {
  quantity: number;
  sourceUnit: string;
  dimension: string;
  referenceUnit: string;
};

export const referenceTextLimits = { referenceLabel: 160, assumption: 300, quip: 160 } as const;

export type ComparisonValidationReason = "invalid_measurement" | "invalid_reference_quantity" | "invalid_reference_unit" | "invalid_reference_label" | "reference_label_too_long" | "invalid_assumption" | "assumption_too_long" | "invalid_quip" | "quip_too_long" | "incompatible_dimensions" | "non_positive_reference" | "temperature_range" | "numeric_range";

export class InvalidComparisonError extends Error {
  constructor(message = "I couldn't recognise that measurement yet.", readonly reason: ComparisonValidationReason = "invalid_measurement") {
    super(message);
  }
}

const maxLength = (value: unknown, length: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= length;
const temperatureBase = unit(1, "K");
const dimensions = [
  ["length", "m"], ["mass", "kg"], ["area", "m^2"], ["volume", "L"], ["energy", "J"],
  ["power", "W"], ["time", "s"], ["speed", "m/s"], ["data", "byte"], ["pressure", "Pa"],
  ["force", "N"], ["frequency", "Hz"], ["angle", "rad"], ["current", "A"]
] as const;

function invalid(message = "I couldn't recognise that measurement yet.", reason: ComparisonValidationReason = "invalid_measurement"): never {
  throw new InvalidComparisonError(message, reason);
}

function parsedUnit(value: number, unitName: string): Unit {
  try {
    return unit(value, unitName);
  } catch {
    return invalid();
  }
}

function isTemperature(value: Unit): boolean {
  try {
    return value.equalBase(temperatureBase);
  } catch {
    return false;
  }
}

function dimensionFor(value: Unit): string {
  if (isTemperature(value)) return "temperature";
  for (const [name, representative] of dimensions) {
    try {
      if (value.equalBase(unit(1, representative))) return name;
    } catch {
      // Try the next representative dimension.
    }
  }
  return "other";
}

const numberFormatter = new Intl.NumberFormat("en", { maximumSignificantDigits: 3 });
export function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

export function validateMeasurement(quantity: unknown, sourceUnit: unknown): ValidatedMeasurement {
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || !maxLength(sourceUnit, 80)) invalid();
  const normalizedUnit = normalizeMeasurementUnit(sourceUnit);
  const source = parsedUnit(quantity, normalizedUnit);
  const temperature = isTemperature(source);
  if (!temperature && quantity < 0) invalid("Please use a non-negative measurement.");
  if (!temperature) {
    let normalized: number;
    try {
      normalized = source.toSI().value;
    } catch {
      return invalid();
    }
    if (!Number.isFinite(normalized) || (normalized === 0 && quantity !== 0)) invalid("That measurement is beyond my measuring tape.", "numeric_range");
  }
  if (temperature) {
    let kelvin: number;
    try {
      kelvin = source.toNumber("K");
    } catch {
      return invalid();
    }
    if (!Number.isFinite(kelvin) || kelvin < 0) invalid("That temperature is below absolute zero.", "temperature_range");
  }
  return { quantity, sourceUnit: normalizedUnit, dimension: dimensionFor(source), referenceUnit: normalizedUnit };
}

export function conversionFromChoice(choice: ModelChoice): Conversion {
  if (!choice || typeof choice !== "object") invalid();
  if (!Number.isFinite(choice.quantity) || !maxLength(choice.sourceUnit, 80)) invalid();
  if (!Number.isFinite(choice.referenceQuantity)) invalid(undefined, "invalid_reference_quantity");
  if (!maxLength(choice.referenceUnit, 80)) invalid(undefined, "invalid_reference_unit");
  for (const [field, invalidReason, lengthReason] of [
    ["referenceLabel", "invalid_reference_label", "reference_label_too_long"],
    ["assumption", "invalid_assumption", "assumption_too_long"],
    ["quip", "invalid_quip", "quip_too_long"]
  ] as const) {
    const text = choice[field];
    if (field === "quip" && text === undefined) continue;
    if (typeof text !== "string" || (field !== "quip" && !text.trim())) invalid(undefined, invalidReason);
    if (text.length > referenceTextLimits[field]) invalid(undefined, lengthReason);
  }

  const measurement = validateMeasurement(choice.quantity, choice.sourceUnit);
  const source = parsedUnit(measurement.quantity, measurement.sourceUnit);
  const referenceUnit = normalizeMeasurementUnit(choice.referenceUnit);
  const reference = parsedUnit(choice.referenceQuantity, referenceUnit);
  let compatible: boolean;
  try {
    compatible = source.equalBase(reference);
  } catch {
    compatible = false;
  }
  if (!compatible) invalid("That comparison measures a different kind of thing.", "incompatible_dimensions");

  const temperature = isTemperature(source);
  if (!temperature && choice.referenceQuantity <= 0) invalid("I need a positive size for the comparison object.", "non_positive_reference");

  if (temperature) {
    let sourceKelvin: number;
    let referenceKelvin: number;
    let difference: number;
    try {
      sourceKelvin = source.toNumber("K");
      referenceKelvin = reference.toNumber("K");
      difference = source.toNumber("degF") - reference.toNumber("degF");
    } catch {
      return invalid();
    }
    if (!Number.isFinite(sourceKelvin) || !Number.isFinite(referenceKelvin) || sourceKelvin < 0 || referenceKelvin < 0 || !Number.isFinite(difference)) invalid("That temperature is below absolute zero.", "temperature_range");
    const magnitude = Math.abs(difference);
    const same = magnitude < 0.05;
    const headline = same
      ? `About the same temperature as ${choice.referenceLabel.trim()}`
      : `${formatNumber(magnitude)}°F ${difference > 0 ? "warmer" : "cooler"} than ${choice.referenceLabel.trim()}`;
    return result(choice, "temperature", magnitude, headline);
  }

  let converted: number;
  try {
    converted = source.toNumber(referenceUnit);
  } catch {
    return invalid();
  }
  const value = converted / choice.referenceQuantity;
  if (!Number.isFinite(value) || value < 0 || (value === 0 && choice.quantity !== 0)) invalid("That measurement is beyond my measuring tape.", "numeric_range");
  return result(choice, dimensionFor(source), value, `About ${formatNumber(value)} ${choice.referenceLabel.trim()}`);
}

function result(choice: ModelChoice, dimension: string, value: number, headline: string): Conversion {
  const sourceUnit = normalizeMeasurementUnit(choice.sourceUnit);
  const referenceUnit = normalizeMeasurementUnit(choice.referenceUnit);
  const referenceLabel = choice.referenceLabel.trim();
  // Display rounding never changes the measurement used for arithmetic.
  const displayedQuantity = Number(choice.quantity.toPrecision(15));
  const interpretationQuantity = displayedQuantity === choice.quantity ? `${choice.quantity}` : `≈ ${displayedQuantity}`;
  return {
    dimension,
    quantity: choice.quantity,
    sourceUnit,
    referenceLabel,
    value,
    displayValue: formatNumber(value),
    assumption: `Approximate reference: ${formatNumber(choice.referenceQuantity)} ${referenceUnit}; ${choice.assumption.trim()}`,
    headline,
    interpretation: `${interpretationQuantity} ${sourceUnit}`,
    ...(choice.quip?.trim() ? { quip: choice.quip.trim() } : {})
  };
}
