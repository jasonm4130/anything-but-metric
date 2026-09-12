import { unit } from "mathjs";
import { formatNumber, validateMeasurement } from "./convert";
import type { ScenePacket } from "./scene-packets";

/** Evaluation-only: the name is invented; its size is explicitly defined by code. */
const forms = {
  ounce: { unit: "oz", value: 1, label: "one-ounce", dimension: "mass" },
  pound: { unit: "lb", value: 1, label: "one-pound", dimension: "mass" },
  "ten-pound": { unit: "lb", value: 10, label: "ten-pound", dimension: "mass" },
  "hundred-pound": { unit: "lb", value: 100, label: "hundred-pound", dimension: "mass" },
  "million-pound": { unit: "lb", value: 1000000, label: "million-pound", dimension: "mass" },
  "hundred-million-pound": { unit: "lb", value: 100000000, label: "hundred-million-pound", dimension: "mass" },
  foot: { unit: "ft", value: 1, label: "one-foot-long", dimension: "length" },
  "ten-foot": { unit: "ft", value: 10, label: "ten-foot-long", dimension: "length" },
  "cubic-foot": { unit: "ft^3", value: 1, label: "one-cubic-foot", dimension: "volume" },
  "cubic-yard": { unit: "yd^3", value: 1, label: "one-cubic-yard", dimension: "volume" }
} as const;
export type ImaginedRecipe = { prop: string; form: keyof typeof forms };
export function imaginedOptions(quantity: number, sourceUnit: string) {
  const source = validateMeasurement(quantity, sourceUnit);
  return Object.entries(forms).filter(([, f]) => f.dimension === source.dimension || source.dimension === "energy" && f.dimension === "mass").map(([id, f]) => ({ id, definition: f.label }));
}
export function compileImaginedScene(measurement: { quantity: number; sourceUnit: string }, value: unknown): ScenePacket | undefined {
  const source = validateMeasurement(measurement.quantity, measurement.sourceUnit);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "form,prop") return undefined;
  const recipe = value as ImaginedRecipe;
  if (typeof recipe.form !== "string" || !Object.hasOwn(forms, recipe.form) || typeof recipe.prop !== "string" || recipe.prop.length > 48 || !/^[a-zA-Z][a-zA-Z '\-]*[a-zA-Z]$/.test(recipe.prop)) return undefined;
  const form = forms[recipe.form];
  if (!(form.dimension === source.dimension || source.dimension === "energy" && form.dimension === "mass")) return undefined;
  const sourceSi = unit(source.quantity, source.sourceUnit).toSI().value;
  const referenceSi = unit(form.value, form.unit).toSI().value;
  const moving = source.dimension === "energy";
  const result = moving ? Math.sqrt(2 * sourceSi / referenceSi) : sourceSi / referenceSi;
  if (!Number.isFinite(result) || result <= 0 || moving && (result > 1000 || result / .44704 < .1) || !moving && (result < .1 || result > 1000)) return undefined;
  const prop = recipe.prop.trim().replace(/ +/g, " ").toLowerCase();
  // Treat model text as a name, not an extra physical modifier. A later free-form
  // caption still requires semantic review; quoting is not a truth validator.
  const headline = moving ? `An imagined ${form.label} prop named “${prop}” at ${formatNumber(result / .44704)} mph` : `About ${formatNumber(result)} imagined ${form.label} props named “${prop}”`;
  const assumption = `A deliberately invented prop, defined here as ${form.value} ${form.unit}; this is not a measured or average property of a real object. The quoted name supplies no additional physical properties.`;
  const basis = `${assumption} ${moving ? "Ideal kinetic-energy equivalence from rest, with no drag or losses and no claim the prop survives motion." : "Compare the defined physical quantity only; no claim about shape, density, packing or manufacture."}`;
  return { id: `imagined:${moving ? "motion" : "count"}:${recipe.form}:${prop}`, family: `imagined-${prop}`, mechanism: moving ? "imagined-motion" : "imagined-count", headline, basis, quantity: source.quantity, sourceUnit: source.sourceUnit,
    computed: { value: result, unit: moving ? "m/s" : "ratio", formula: moving ? "sqrt(2 * energy_j / defined_mass_kg)" : "source_si / defined_reference_si", operands: moving ? { energy_j: sourceSi, defined_mass_kg: referenceSi } : { source_si: sourceSi, defined_reference_si: referenceSi }, displayValue: formatNumber(result) },
    sources: [{ id: `definition:${recipe.form}`, url: "https://www.nist.gov/pml/special-publication-811", note: "The cited resource supports unit conventions, not this prop's existence or magnitude. Its magnitude is an explicit fictional definition; mathjs calculates the unit conversion.", quantity: form.value, unit: form.unit, assumption }] };
}
