// Offline evaluation sweeps: no network, no credentials, deterministic.
// Hard invariants fail the run; everything else is a recorded baseline.
import { build } from 'esbuild';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const read = async path => JSON.parse(await readFile(path, 'utf8'));
const dir = await mkdtemp(resolve(tmpdir(), 'abm-offline-sweeps-'));
try {
  await build({ stdin: { contents: 'export * from "./src/lib/comparison-flow"; export * from "./src/lib/measurement"; export * from "./src/lib/convert"; export * from "./src/lib/creative-proposals"; export * from "./src/lib/jev-decisions"; export { unit, evaluate } from "mathjs";', resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile: resolve(dir, 'engine.mjs'), logLevel: 'error' });
  const E = await import(pathToFileURL(resolve(dir, 'engine.mjs')));
  const failures = [];
  const noParser = async () => ({ recognized: false, quantity: 0, sourceUnit: 'm' });

  const siOf = (quantity, unitName) => {
    const value = E.unit(quantity, unitName);
    return { value, si: value.toSI().value };
  };
  const matches = (parsed, gold, toleranceDecades) => {
    if (gold[1] === 'ratio') return false;
    try {
      const actual = siOf(parsed.quantity, parsed.sourceUnit);
      const expected = siOf(gold[0], gold[1]);
      if (!actual.value.equalBase(expected.value)) return 'dimension';
      if (expected.si === 0) return actual.si === 0;
      return Math.abs(Math.log10(actual.si / expected.si)) <= (toleranceDecades ?? 1e-6);
    } catch {
      return false;
    }
  };

  // 1. Interpretation with only local code (the model parser stubbed to "unrecognised").
  const interpretation = await read('evals/sets/interpretation.json');
  const interpretationRows = [];
  for (const item of interpretation.cases) {
    let parserCalls = 0;
    let parsed;
    try {
      parsed = await E.interpretMeasurement(item.input, async input => { parserCalls++; return noParser(input); });
      if (parsed.recognized) E.validateMeasurement(parsed.quantity, parsed.sourceUnit);
    } catch {
      parsed = { recognized: false };
    }
    let result;
    if (item.reject) result = parsed.recognized ? 'false_accept' : 'correct_reject';
    else if (!parsed.recognized) result = 'missed';
    else {
      const verdicts = [item.gold, ...(item.alternatives ?? [])].map(gold => matches(parsed, gold, item.toleranceDecades));
      result = verdicts.includes(true) ? 'correct' : verdicts.every(verdict => verdict === 'dimension') ? 'wrong_dimension' : 'wrong_value';
    }
    interpretationRows.push({ id: item.id, input: item.input, result, parserWouldSeeRawText: parserCalls > 0, ...(parsed.recognized ? { read: `${parsed.quantity} ${parsed.sourceUnit}` } : {}) });
  }
  const tally = rows => rows.reduce((counts, row) => ({ ...counts, [row.result]: (counts[row.result] ?? 0) + 1 }), {});
  const interpretationSummary = { cases: interpretationRows.length, ...tally(interpretationRows), parserWouldSeeRawText: interpretationRows.filter(row => row.parserWouldSeeRawText).length, wrong: interpretationRows.filter(row => row.result.startsWith('wrong') || row.result === 'false_accept') };

  // 2. Coverage grid: 14 non-temperature dimensions x integer decades 1e-6..1e12.
  const gridUnits = { length: 'm', mass: 'kg', area: 'm^2', volume: 'm^3', energy: 'J', power: 'W', time: 's', speed: 'm/s', data: 'B', pressure: 'Pa', force: 'N', frequency: 'Hz', angle: 'rad', current: 'A' };
  const grid = { cells: 0, empty: 0, oneOrTwo: 0, threePlus: 0, perDimension: {} };
  for (const [dimension, sourceUnit] of Object.entries(gridUnits)) {
    const row = { empty: 0, threePlus: 0, cells: 0 };
    for (let exponent = -6; exponent <= 12; exponent++) {
      const size = E.comparisonPool({ quantity: 10 ** exponent, sourceUnit }).length;
      grid.cells++; row.cells++;
      if (!size) { grid.empty++; row.empty++; } else if (size < 3) grid.oneOrTwo++; else { grid.threePlus++; row.threePlus++; }
    }
    grid.perDimension[dimension] = row;
  }

  // 3. Arithmetic invariant: recompute every packet's value from its formula and operands.
  const arithmetic = { checked: 0, mismatched: 0, skippedNoFormula: 0, samples: [] };
  for (const sourceUnit of ['m', 'kg', 'm^2', 'm^3', 'J', 'W', 's', 'm/s', 'B', 'Pa', 'N', 'Hz']) {
    for (let exponent = -6; exponent <= 18; exponent += 0.25) {
      let pool;
      try { pool = E.comparisonPool({ quantity: 10 ** exponent, sourceUnit }); } catch { continue; }
      for (const packet of pool) {
        const computed = packet.computed;
        if (!computed?.formula || !computed.operands || computed.value === undefined) { arithmetic.skippedNoFormula++; continue; }
        let value;
        try { value = E.evaluate(computed.formula, computed.operands); } catch { arithmetic.skippedNoFormula++; continue; }
        arithmetic.checked++;
        if (Math.abs(value - computed.value) > 1e-9 * Math.abs(computed.value)) {
          arithmetic.mismatched++;
          if (arithmetic.samples.length < 5) arithmetic.samples.push({ id: packet.id, formula: computed.formula, recomputed: value, shown: computed.value });
        }
      }
    }
  }
  if (arithmetic.mismatched) failures.push(`arithmetic: ${arithmetic.mismatched} packets disagree with their formula`);

  // 4. Repeated-session variety with the deterministic menu fallback.
  const variety = await read('evals/sets/variety.json');
  const varietyRows = [];
  for (const input of variety.inputs) {
    const parsed = await E.interpretMeasurement(input, noParser);
    if (!parsed.recognized) { varietyRows.push({ input, distinctHeadlines: 0, note: 'not parsed locally' }); continue; }
    let history = []; const headlines = new Set(); const families = new Set();
    for (let session = 0; session < variety.sessions; session++) {
      const menu = E.comparisonMenu(parsed, history, session);
      if (!menu.length) break;
      const result = E.comparisonResult(menu[0], parsed, history);
      history = result.recentFamilies; headlines.add(result.headline); families.add(menu[0].family);
    }
    varietyRows.push({ input, distinctHeadlines: headlines.size, distinctFamilies: families.size });
  }

  // 5. Which stage would see an edgy person's raw words today.
  const refusal = await read('evals/sets/refusal.json');
  const pathCounts = { parserModel: 0, selectorModel: 0, rejectedLocally: 0, coverageGap: 0 };
  for (const item of refusal.cases.filter(row => row.topic !== 'control')) {
    let parserCalls = 0;
    const parsed = await E.interpretMeasurement(item.input, async input => { parserCalls++; return noParser(input); });
    if (parserCalls) pathCounts.parserModel++;
    else if (!parsed.recognized) pathCounts.rejectedLocally++;
    else {
      let menu = [];
      try { menu = E.comparisonMenu(E.validateMeasurement(parsed.quantity, parsed.sourceUnit), [], 1); } catch { /* invalid measurement */ }
      if (menu.length) pathCounts.selectorModel++; else pathCounts.coverageGap++;
    }
  }

  // 6. Number-match gate against frozen adversarial lines (hard invariant).
  const gateSet = await read('evals/sets/gate-adversarial.json');
  const gateMismatches = gateSet.cases.filter(item => {
    const reasons = E.lineGateReasons(item.line, item.label, item.singular);
    return item.expect === 'accept' ? reasons.length > 0 : !reasons.includes(item.reason);
  }).map(item => item.id);
  if (gateMismatches.length) failures.push(`gate: ${gateMismatches.join(', ')}`);

  // 7. Creative windows keep any in-window reference inside the readable count range (hard invariant).
  const creative = await read('evals/sets/creative-inputs.json');
  const windowFailures = [];
  for (const item of creative.cases) {
    const window = E.magnitudeWindow(item.gold[0], item.gold[1]);
    if (!window) { windowFailures.push(`${item.id}: no window`); continue; }
    for (const reference of [window.referenceLow, window.referenceHigh]) {
      const count = E.unit(item.gold[0], item.gold[1]).toNumber(window.displayUnit) / reference;
      if (count < E.proposalRatioRange.min * 0.999 || count > E.proposalRatioRange.max * 1.001) windowFailures.push(`${item.id}: ${count}`);
    }
  }
  if (windowFailures.length) failures.push(`creative windows: ${windowFailures.join('; ')}`);

  // 8. Jev band questions always contain the proposed value in the proposed band (hard invariant).
  const entities = await read('evals/sets/estimate-entities.json');
  const bandSet = await read('evals/sets/jev-band-checks.json');
  const byId = new Map(entities.items.map(item => [item.id, item]));
  const bandFailures = bandSet.checks.filter(check => {
    const entity = byId.get(check.entityId);
    const built = E.bandCheckQuestion({ thing: entity.thing, dimension: entity.dimension, value: check.value, unit: check.unit }, check.position);
    const band = built.bands.find(candidate => candidate.key === built.proposedKey);
    return !(band.low <= check.value && check.value < band.high) || Object.keys(built.question.criteria).length !== E.bandCount;
  }).map(check => check.id);
  if (bandFailures.length) failures.push(`jev bands: ${bandFailures.join(', ')}`);

  // 9. Frozen-set integrity: unique ids, readable gold units, catalogue drift.
  const integrity = {};
  for (const [name, rows] of [['interpretation', interpretation.cases], ['refusal', refusal.cases], ['creative-inputs', creative.cases], ['estimate-entities', entities.items], ['gate-adversarial', gateSet.cases]]) {
    const ids = rows.map(row => row.id);
    const unreadable = rows.flatMap(row => [row.gold, ...(row.alternatives ?? [])].filter(gold => gold && gold[1] !== 'ratio').filter(gold => { try { E.unit(gold[0], gold[1]); return false; } catch { return true; } }).map(() => row.id));
    integrity[name] = { rows: rows.length, duplicateIds: ids.length - new Set(ids).size, unreadableGold: unreadable };
    if (ids.length !== new Set(ids).size || unreadable.length) failures.push(`set ${name}: duplicate ids or unreadable gold`);
  }
  const corpusFiles = ['src/data/references.json', 'src/data/reference-additions.json', 'src/data/corpus-additions.json'];
  const corpusRows = (await Promise.all(corpusFiles.map(read))).flat();
  integrity['estimate-entities'].catalogueChangedSinceFrozen = createHash('sha256').update(JSON.stringify(corpusRows)).digest('hex') !== entities.corpusSha256;

  // 10. Live-harness self-check: guards, scoring and summaries on synthetic records (no network).
  const harness = await import(pathToFileURL(resolve('scripts/live-eval.mjs')));
  const harnessFailures = [];
  const expectThrow = (label, fn) => { try { fn(); harnessFailures.push(`${label} did not throw`); } catch { /* expected */ } };
  expectThrow('missing --live', () => harness.assertLiveAllowed({}, {}));
  expectThrow('CI', () => harness.assertLiveAllowed({ live: true }, { CI: 'true' }));
  try { harness.assertLiveAllowed({ live: true }, {}); } catch { harnessFailures.push('explicit --live refused outside CI'); }
  const proposal = { label: 'double-decker buses', singular: 'double-decker bus', value: 12, unit: 'tonne', basis: 'Empty London bus.', family: 'vehicles', line: "That's {N} double-decker buses." };
  const synthetic = [
    { suite: 'creative', condition: 'no-context', model: 'm', status: 'ok', latencyMs: 10, costUsd: 0.001, measurement: { quantity: 40, sourceUnit: 'tonne' }, response: { response: { proposals: [proposal] } } },
    { suite: 'refusal', condition: 'with-context', model: 'm', status: 'ok', latencyMs: 10, costUsd: 0.001, measurement: { quantity: 3, sourceUnit: 'g' }, response: { choices: [{ message: { content: null, refusal: "I can't help with that." } }] } },
    { suite: 'refusal', condition: 'with-context', model: 'm', status: 'ok', latencyMs: 10, costUsd: 0.001, measurement: { quantity: 3, sourceUnit: 'g' }, response: { choices: [{ message: { content: '{}' }, finish_reason: 'content_filter' }] } },
    { suite: 'refusal', condition: 'with-context', model: 'm', status: 'error', latencyMs: 10, costUsd: 0.001, error: { kind: 'json_mode_error' } },
    { suite: 'estimate', condition: 'batch', model: 'm', status: 'ok', latencyMs: 10, costUsd: 0.001, gold: [{ id: 'a', gold: [1, 'tonne'] }, { id: 'b', gold: [2, 'm'] }], response: { response: { estimates: [{ id: 'a', value: 1000, unit: 'kg', basis: 'x' }, { id: 'b', value: 20, unit: 'm', basis: 'x' }] } } }
  ];
  const scored = synthetic.map(record => ({ ...record, scored: harness.scoreRecord(E, record) }));
  const outcomes = scored.map(record => record.scored.outcome).join(',');
  if (outcomes !== 'ok,refusal,refusal,json_mode_error,ok') harnessFailures.push(`scoreRecord outcomes ${outcomes}`);
  const rows = harness.summarise(scored);
  const refusalRow = rows.find(row => row.suite === 'refusal');
  const estimateRow = rows.find(row => row.suite === 'estimate');
  if (refusalRow?.refusalRate !== 0.667) harnessFailures.push(`refusalRate ${refusalRow?.refusalRate}`);
  if (estimateRow?.within2x !== 0.5 || estimateRow?.medianAbsLog10Error !== 0) harnessFailures.push(`estimate summary ${JSON.stringify(estimateRow)}`);
  if (harness.classifyError(new Error("AiError: JSON Mode couldn't be met")) !== 'json_mode_error') harnessFailures.push('classifyError json mode');
  if (harness.costOf('@cf/meta/llama-3.2-3b-instruct', { inputTokens: 1e6, outputTokens: 1e6 }) !== 0.386) harnessFailures.push('costOf');
  if (harnessFailures.length) failures.push(`harness: ${harnessFailures.join('; ')}`);

  const result = {
    recordedAt: new Date().toISOString(),
    interpretation: interpretationSummary,
    coverageGrid: grid,
    arithmetic,
    variety: { sessions: variety.sessions, inputs: varietyRows },
    edgyInputPaths: pathCounts,
    gate: { cases: gateSet.cases.length, mismatches: gateMismatches },
    creativeWindows: { cases: creative.cases.length, failures: windowFailures },
    jevBands: { checks: bandSet.checks.length, failures: bandFailures },
    integrity,
    harnessSelfCheck: { failures: harnessFailures },
    failures
  };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
