// Regenerates the derived evaluation sets from the sourced catalogue.
// Run deliberately (`node scripts/build-eval-sets.mjs`); the outputs are frozen and committed.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const read = async path => JSON.parse(await readFile(path, 'utf8'));
const corpusFiles = ['src/data/references.json', 'src/data/reference-additions.json', 'src/data/corpus-additions.json'];
const rows = (await Promise.all(corpusFiles.map(read))).flat();

// Deterministic PRNG so the frozen sets can be rebuilt byte for byte.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A label that states a number would leak the answer, so those rows are excluded.
const numberWords = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|million|billion|half|quarter)\b/i;
const leaks = row => [row.referenceLabel, row.singularLabel ?? ''].some(label => /\d/.test(label) || numberWords.test(label)) || /imagined/i.test(row.referenceLabel);
const entities = rows.filter(row => !leaks(row) && row.dimension !== 'temperature').map(row => ({
  id: row.id,
  thing: row.singularLabel ?? row.referenceLabel,
  dimension: row.dimension,
  gold: [row.referenceQuantity, row.referenceUnit],
  sourceUrl: row.sourceUrl
}));

const corpusHash = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
await writeFile('evals/sets/estimate-entities.json', JSON.stringify({
  schemaVersion: 1,
  frozenAt: '2026-10-03',
  purpose: 'Sourced catalogue values used as gold for creative-model estimates. Rows whose label states a number are excluded so the label cannot leak the answer.',
  derivedFrom: corpusFiles,
  corpusSha256: corpusHash,
  excluded: rows.length - entities.length,
  items: entities
}, null, 2) + '\n');

// Each entity is checked twice: once at its sourced value and once corrupted.
const factors = [0.01, 0.1, 0.3, 3, 10, 100];
const random = mulberry32(20261003);
const checks = [];
entities.forEach((entity, index) => {
  const factor = factors[index % factors.length];
  for (const [kind, multiplier] of [['true', 1], ['corrupted', factor]]) {
    checks.push({ id: `${entity.id}--${kind}`, entityId: entity.id, kind, factor: multiplier, value: entity.gold[0] * multiplier, unit: entity.gold[1], position: Math.floor(random() * 7) });
  }
});
await writeFile('evals/sets/jev-band-checks.json', JSON.stringify({
  schemaVersion: 1,
  frozenAt: '2026-10-03',
  purpose: 'Calibration set for the Jev value check: each sourced entity appears at its true value and at one corrupted value (factor cycles through 0.01, 0.1, 0.3, 3, 10, 100). `position` places the proposed value among seven half-decade bands.',
  derivedFrom: 'evals/sets/estimate-entities.json',
  checks
}, null, 2) + '\n');
console.log(JSON.stringify({ entities: entities.length, excluded: rows.length - entities.length, checks: checks.length, dimensions: [...new Set(entities.map(e => e.dimension))] }));
