import { describe, expect, it } from "vitest";
import { resolveUnitSpelling } from "../src/lib/unit-spelling";

const units = [
  { word: "kilograms", canonicalUnit: "kg" },
  { word: "milligrams", canonicalUnit: "mg" },
  { word: "megagrams", canonicalUnit: "Mg" },
  { word: "megabytes", canonicalUnit: "MB" },
  { word: "megabits", canonicalUnit: "Mb" }
];

describe("cautious long-word unit spelling", () => {
  it("repairs one insertion, deletion, substitution or adjacent transposition", () => {
    for (const input of ["killograms", "kilgrams", "kilogxams", "kliograms", "KILLOGRAMS"]) expect(resolveUnitSpelling(input, units)).toBe("kg");
    expect(resolveUnitSpelling("megabytez", units)).toBe("MB");
    expect(resolveUnitSpelling("megabitz", units)).toBe("Mb");
    expect(resolveUnitSpelling("milligrans", units)).toBe("mg");
    expect(resolveUnitSpelling("megagrans", units)).toBe("Mg");
  });

  it("accepts agreement among nearest spellings but rejects incompatible or conflicting units", () => {
    expect(resolveUnitSpelling("metere", [{ word: "meter", canonicalUnit: "m" }, { word: "metre", canonicalUnit: "m" }])).toBe("m");
    expect(resolveUnitSpelling("miters", [{ word: "meters", canonicalUnit: "m" }, { word: "liters", canonicalUnit: "L" }])).toBeUndefined();
    expect(resolveUnitSpelling("megabites", units)).toBeUndefined(); // Equally near megabits and megabytes.
    expect(resolveUnitSpelling("caloriez", [{ word: "calories", canonicalUnit: "cal" }, { word: "Calories", canonicalUnit: "kcal" }])).toBeUndefined();
    expect(resolveUnitSpelling("metres", [{ word: "metres", canonicalUnit: "m" }, { word: "metres", canonicalUnit: "ft" }])).toBeUndefined();
  });

  it("uses only nearest matches and preserves exact canonical spelling", () => {
    expect(resolveUnitSpelling("meters", [{ word: "meters", canonicalUnit: "m" }, { word: "liters", canonicalUnit: "L" }])).toBe("m");
    expect(resolveUnitSpelling("meters", [{ word: "meters", canonicalUnit: "m" }, { word: "metres", canonicalUnit: "other-unit" }])).toBe("m");
    expect(resolveUnitSpelling("megagrans", [{ word: "megagrams", canonicalUnit: "Mg" }])).toBe("Mg");
  });

  it("never fuzzy-matches short symbols, numbers, expressions or multiple words", () => {
    for (const input of ["mg", "Mg", "MB", "Mb", "kg", "kG", "mgs", "watts", "27.4 killograms", "killograms2", "kilograms/s", "square meters", " kilograms", "kilograms ", "kilograms(kg)", "kilograms;exit", "", "x".repeat(65)]) expect(resolveUnitSpelling(input, units)).toBeUndefined();
  });

  it("refuses multiple edits and distant words rather than choosing the closest available unit", () => {
    for (const input of ["killogrmms", "kilogarmz", "kilog", "kilogramssss", "pineapples"]) expect(resolveUnitSpelling(input, units)).toBeUndefined();
    expect(resolveUnitSpelling("killograms", [])).toBeUndefined();
  });

  it("requires caller dictionaries to contain words and explicit canonical units", () => {
    for (const candidates of [[{ word: "kilo grams", canonicalUnit: "kg" }], [{ word: "kilograms", canonicalUnit: "" }], [{ word: "kilograms", canonicalUnit: " kg" }]]) expect(() => resolveUnitSpelling("killograms", candidates)).toThrow("invalid_unit_spelling_candidates");
  });
});
