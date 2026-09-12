/** Callers must validate canonical units and try exact supported-unit parsing first. */
export type UnitSpellingCandidate = { word: string; canonicalUnit: string };
export const unitSpellingLimits = { minInputLength: 6, maxWordLength: 64 } as const;
const alphabeticWord = /^[A-Za-z]+$/;

/** Returns 0, 1, or 2 (meaning more than one permitted edit). */
function oneEditDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > 1) return 2;
  let first = 0;
  while (first < Math.min(left.length, right.length) && left[first] === right[first]) first++;
  if (left.length === right.length) {
    if (left.slice(first + 1) === right.slice(first + 1)) return 1; // Substitution.
    if (left[first] === right[first + 1] && left[first + 1] === right[first] && left.slice(first + 2) === right.slice(first + 2)) return 1; // Adjacent transposition.
    return 2;
  }
  const longer = left.length > right.length ? left : right;
  const shorter = left.length > right.length ? right : left;
  return longer.slice(first + 1) === shorter.slice(first) ? 1 : 2; // Insertion/deletion.
}

/**
 * Resolve only a single long ASCII unit word, never a measurement or expression.
 * Word matching ignores case; canonical-unit case is preserved. If case folding
 * exposes candidates such as calorie/Calorie with different units, fail closed.
 * The source number is deliberately absent from this API and cannot be rewritten.
 */
export function resolveUnitSpelling(input: string, candidates: readonly UnitSpellingCandidate[]): string | undefined {
  if (typeof input !== "string" || input.length < unitSpellingLimits.minInputLength || input.length > unitSpellingLimits.maxWordLength || !alphabeticWord.test(input)) return undefined;
  if (!Array.isArray(candidates) || candidates.some(candidate => !candidate || typeof candidate !== "object" || Array.isArray(candidate) || typeof candidate.word !== "string" || !alphabeticWord.test(candidate.word) || candidate.word.length > unitSpellingLimits.maxWordLength || typeof candidate.canonicalUnit !== "string" || !candidate.canonicalUnit.trim() || candidate.canonicalUnit !== candidate.canonicalUnit.trim())) throw new Error("invalid_unit_spelling_candidates");
  const word = input.toLowerCase();
  let nearest = 2;
  const units = new Set<string>();
  for (const candidate of candidates) {
    const distance = oneEditDistance(word, candidate.word.toLowerCase());
    if (distance > 1 || distance > nearest) continue;
    if (distance < nearest) {
      nearest = distance;
      units.clear();
    }
    units.add(candidate.canonicalUnit);
  }
  return units.size === 1 ? units.values().next().value : undefined;
}
