import { unit, type Unit } from "mathjs";
import { validateMeasurement } from "./convert";
import { normalizeMeasurementUnit } from "./measurement";

const gravity = 9.80665;
const numberPattern = "[-+]?(?:(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?";
const literalPattern = new RegExp(`^\\s*(${numberPattern})\\s*([A-Za-z°µμ²³0-9^*/.·\\-\\s]+?)\\s*$`);

export type ReferenceBasis =
  | { kind: "direct"; measure: string }
  | { kind: "cuboid_volume"; length: string; width: string; depth: string }
  | { kind: "lifting_energy"; mass: string; height: string }
  | { kind: "power_duration"; power: string; duration: string }
  | { kind: "work_over_distance"; energy: string; distance: string };

export type ReferenceBasisInput = {
  referenceLabel: string;
  basis: ReferenceBasis;
  context: string;
  quip: string;
};

export type ReferenceBasisResult = {
  referenceQuantity: number;
  referenceUnit: string;
  referenceLabel: string;
  assumption: string;
  quip?: string;
};

export class InvalidReferenceBasisError extends Error {}

/** JSON schema for the bounded model-authored description of a physical reference. */
export const referenceBasisSchema = {
  type: "object",
  required: ["referenceLabel", "basis", "context", "quip"],
  additionalProperties: false,
  properties: {
    referenceLabel: { type: "string", minLength: 1, maxLength: 160 },
    context: { type: "string", minLength: 1, maxLength: 120 },
    quip: { type: "string", minLength: 1, maxLength: 160 },
    basis: {
      type: "object",
      required: ["kind", "first", "second", "third"],
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["direct", "cuboid_volume", "lifting_energy", "power_duration", "work_over_distance"] },
        first: { type: "string", minLength: 1, maxLength: 80, description: "First input: numeric magnitude and physical unit together." },
        second: { type: "string", maxLength: 80, description: "Second input, or empty string for direct." },
        third: { type: "string", maxLength: 80, description: "Depth for cuboid_volume, otherwise empty string." }
      }
    }
  }
} as const;

function invalid(message = "I couldn't use that physical reference."): never {
  throw new InvalidReferenceBasisError(message);
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) invalid();
  return value.trim();
}

function isBase(value: Unit, representative: string): boolean {
  try {
    return value.equalBase(unit(1, representative));
  } catch {
    return false;
  }
}

function hasEmbeddedUnitMagnitude(value: string): boolean {
  const withoutExponents = value.replace(/\^-?\d+/g, "").replace(/^1\//, "");
  return /\d/.test(withoutExponents);
}

function operand(value: unknown, expectedUnit: string): number {
  if (typeof value !== "string" || value.length > 80) invalid();
  const match = literalPattern.exec(value);
  if (!match) invalid();
  const quantity = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(quantity) || quantity <= 0) invalid();
  const normalizedUnit = normalizeMeasurementUnit(match[2]);
  if (hasEmbeddedUnitMagnitude(normalizedUnit)) invalid();
  let parsed: Unit;
  try {
    parsed = unit(quantity, normalizedUnit);
  } catch {
    return invalid();
  }
  if (!isBase(parsed, expectedUnit)) invalid("That operand has the wrong dimension.");
  let converted: number;
  try {
    converted = parsed.toNumber(expectedUnit);
  } catch {
    return invalid();
  }
  if (!Number.isFinite(converted) || converted <= 0) invalid();
  return converted;
}

function finiteDerived(value: number): number {
  if (!Number.isFinite(value) || value <= 0) invalid("That physical reference is outside my measuring tape.");
  return value;
}

function format(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1e9 || (magnitude > 0 && magnitude < 1e-4)) {
    return value.toExponential(4).replace(/\.?(0+)e/, "e");
  }
  return new Intl.NumberFormat("en", { maximumSignificantDigits: 5 }).format(value);
}

function nonzeroLiteral(value: string): boolean {
  return /[1-9]/.test(value.split(/[eE]/, 1)[0]);
}

function renderedAssumption(parts: string[], quantity: number, referenceUnit: string, context: string): string {
  const assumption = `Using ${parts.join(", ")} gives ${format(quantity)} ${referenceUnit}; ${context}`;
  if (assumption.length > 300) invalid("That physical reference needs a shorter explanation.");
  return assumption;
}

function exactBasisKeys(basis: object, keys: string[]): void {
  if (Object.keys(basis).some(key => !keys.includes(key))) invalid();
}

/** Converts a narrowly typed physical basis into a deterministic comparison reference. */
export function referenceFromBasis(value: unknown): ReferenceBasisResult {
  if (!value || typeof value !== "object") invalid();
  const input = value as Partial<ReferenceBasisInput>;
  const referenceLabel = boundedText(input.referenceLabel, 160);
  const context = boundedText(input.context, 120);
  if (/\d/.test(context)) invalid("Context must describe the setup without numbers.");
  const quip = boundedText(input.quip, 160);
  let basis = input.basis;
  if (basis && typeof basis === "object" && "first" in basis) {
    const flat = basis as unknown as { kind: string; first: unknown; second: unknown; third: unknown };
    exactBasisKeys(flat, ["kind", "first", "second", "third"]);
    if (typeof flat.first !== "string" || typeof flat.second !== "string" || typeof flat.third !== "string") invalid();
    if (flat.kind !== "cuboid_volume" && flat.third !== "") invalid();
    if (flat.kind === "direct" && flat.second !== "") invalid();
    switch (flat.kind) {
      case "direct": basis = { kind: "direct", measure: flat.first }; break;
      case "cuboid_volume": basis = { kind: "cuboid_volume", length: flat.first, width: flat.second, depth: flat.third }; break;
      case "lifting_energy": basis = { kind: "lifting_energy", mass: flat.first, height: flat.second }; break;
      case "power_duration": basis = { kind: "power_duration", power: flat.first, duration: flat.second }; break;
      case "work_over_distance": basis = { kind: "work_over_distance", energy: flat.first, distance: flat.second }; break;
      default: invalid();
    }
  }
  if (!basis || typeof basis !== "object" || typeof (basis as ReferenceBasis).kind !== "string") invalid();

  if (basis.kind === "direct") {
    exactBasisKeys(basis, ["kind", "measure"]);
    const measure = boundedText(basis.measure, 80);
    const match = literalPattern.exec(measure);
    if (!match) invalid();
    const quantity = Number(match[1].replace(/,/g, ""));
    if (!Number.isFinite(quantity) || (quantity === 0 && nonzeroLiteral(match[1]))) invalid();
    if (hasEmbeddedUnitMagnitude(normalizeMeasurementUnit(match[2]))) invalid();
    let measurement;
    try {
      measurement = validateMeasurement(quantity, match[2]);
    } catch {
      return invalid();
    }
    if (measurement.dimension !== "temperature" && measurement.quantity <= 0) invalid();
    const assumption = renderedAssumption([`${format(measurement.quantity)} ${measurement.sourceUnit}`], measurement.quantity, measurement.sourceUnit, context);
    return { referenceQuantity: measurement.quantity, referenceUnit: measurement.sourceUnit, referenceLabel, assumption, quip };
  }

  let referenceQuantity: number;
  let referenceUnit: string;
  let parts: string[];
  switch (basis.kind) {
    case "cuboid_volume": {
      exactBasisKeys(basis, ["kind", "length", "width", "depth"]);
      const length = operand(basis.length, "m");
      const width = operand(basis.width, "m");
      const depth = operand(basis.depth, "m");
      referenceQuantity = finiteDerived(length * width * depth);
      referenceUnit = "m^3";
      parts = [`${format(length)} m long`, `${format(width)} m wide`, `${format(depth)} m deep`];
      break;
    }
    case "lifting_energy": {
      exactBasisKeys(basis, ["kind", "mass", "height"]);
      const mass = operand(basis.mass, "kg");
      const height = operand(basis.height, "m");
      referenceQuantity = finiteDerived(mass * height * gravity);
      referenceUnit = "J";
      parts = [`${format(mass)} kg`, `${format(height)} m lift`, `gravity ${gravity} m/s²`];
      break;
    }
    case "power_duration": {
      exactBasisKeys(basis, ["kind", "power", "duration"]);
      const power = operand(basis.power, "W");
      const duration = operand(basis.duration, "s");
      referenceQuantity = finiteDerived(power * duration);
      referenceUnit = "J";
      parts = [`${format(power)} W`, `${format(duration)} s`];
      break;
    }
    case "work_over_distance": {
      exactBasisKeys(basis, ["kind", "energy", "distance"]);
      const energy = operand(basis.energy, "J");
      const distance = operand(basis.distance, "m");
      referenceQuantity = finiteDerived(energy / distance);
      referenceUnit = "N";
      parts = [`${format(energy)} J`, `${format(distance)} m`];
      break;
    }
    default:
      return invalid();
  }
  return { referenceQuantity, referenceUnit, referenceLabel, assumption: renderedAssumption(parts, referenceQuantity, referenceUnit, context), quip };
}
