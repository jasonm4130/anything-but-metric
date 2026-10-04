// Production replay log tooling. The Worker writes one `abm-replay.v1` row per verified
// conversion (answers, template fallbacks, rejections and refusals) to the D1 database
// `anything-but-metric-replay`. This script pulls rows into evals/results/replay/ (ignored by
// Git, because rows hold people's measurement text) and replays them offline.
//
//   node scripts/replay-log.mjs pull    --days 7 [--outcome failed] [--refused] [--limit 500] --out week-41
//   node scripts/replay-log.mjs summary --file week-41
//   node scripts/replay-log.mjs rescore --file week-41      (current code against stored responses)
//   node scripts/replay-log.mjs inputs  --file week-41 [--refused]   (one input per line, to retry by hand)
//
// `pull` reads production data through `wrangler d1 execute --remote` and needs wrangler login or
// CLOUDFLARE_API_TOKEN with D1 read access. Everything else is offline.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const database = 'anything-but-metric-replay';
const root = resolve('evals/results/replay');
const outcomes = new Set(['model', 'template', 'tokens', 'rejected', 'failed']);

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index].replace(/^--/, '');
    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) options[key] = true;
    else { options[key] = next; index++; }
  }
  return options;
}

/** SQL for `pull`; options are validated rather than interpolated as free text. */
export function pullQuery(options, now = Date.now()) {
  const days = Number(options.days ?? 7);
  const limit = Number(options.limit ?? 500);
  if (!Number.isFinite(days) || days <= 0 || days > 90) throw new Error('--days must be between 0 and 90');
  if (!Number.isInteger(limit) || limit <= 0 || limit > 5000) throw new Error('--limit must be an integer from 1 to 5000');
  if (options.outcome !== undefined && !outcomes.has(options.outcome)) throw new Error(`--outcome must be one of ${[...outcomes].join(', ')}`);
  const since = new Date(now - days * 86_400_000).toISOString();
  const where = [`created_at >= '${since}'`, ...(options.outcome ? [`outcome = '${options.outcome}'`] : []), ...(options.refused ? ['refused = 1'] : [])];
  return `SELECT record FROM conversions WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${limit}`;
}

const fileFor = name => {
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('--file/--out must be a name (letters, digits, dot, dash, underscore)');
  return resolve(root, `${name}.jsonl`);
};
const readRecords = async name => (await readFile(fileFor(name), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : undefined; };
const tally = (items, key) => items.reduce((counts, item) => { const name = key(item); counts[name] = (counts[name] ?? 0) + 1; return counts; }, {});

export function summarise(records) {
  const stages = records.flatMap(record => record.stages ?? []);
  const byStage = {};
  for (const stage of stages) (byStage[stage.stage] ??= []).push(stage);
  const reviews = stages.filter(stage => stage.stage === 'jev-review' && Array.isArray(stage.detail?.verdicts));
  const verdicts = reviews.flatMap(stage => stage.detail.verdicts);
  const creativeChecks = (byStage.creative ?? []).flatMap(stage => Array.isArray(stage.detail) ? stage.detail : []);
  return {
    records: records.length,
    outcomes: tally(records, record => record.outcome),
    refused: records.filter(record => record.refused).length,
    dimensions: tally(records.filter(record => record.measure), record => record.measure.dimension),
    latencyMs: { p50: percentile(records.map(record => record.latencyMs), 0.5), p95: percentile(records.map(record => record.latencyMs), 0.95) },
    stages: Object.fromEntries(Object.entries(byStage).map(([name, list]) => [name, { calls: list.length, outcomes: tally(list, stage => stage.outcome), latencyMs: { p50: percentile(list.map(stage => stage.latencyMs), 0.5), p95: percentile(list.map(stage => stage.latencyMs), 0.95) } }])),
    jev: { proposalsChecked: verdicts.length, bandDistance: tally(verdicts, verdict => verdict.bandDistance ?? 'none') },
    creativeRejectReasons: tally(creativeChecks.flatMap(check => check.reasons ?? []), reason => reason)
  };
}

async function loadEngine() {
  const dir = await mkdtemp(resolve(tmpdir(), 'abm-replay-'));
  try {
    await build({ stdin: { contents: 'export * from "./src/lib/creative-proposals"; export * from "./src/lib/reader";', resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile: resolve(dir, 'engine.mjs'), logLevel: 'error' });
    return await import(pathToFileURL(resolve(dir, 'engine.mjs')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Re-run today's checks on stored reader and creative responses; report outcomes that change. */
export function rescore(E, records) {
  const changes = [];
  let compared = 0;
  for (const record of records) {
    for (const stage of record.stages ?? []) {
      if (stage.response === undefined || stage.response?.truncated || typeof stage.response === 'string' && stage.response.startsWith('[dropped')) continue;
      let after;
      if (stage.stage === 'reader' && ['ok', 'none', 'refusal', 'unparseable', 'schema_error', 'number_mismatch', 'invalid_unit', 'out_of_range'].includes(stage.outcome)) after = E.readMeasure(stage.response, record.input).outcome;
      else if (stage.stage === 'creative' && record.measure && ['ok', 'no_valid_proposal', 'refusal', 'schema_error', 'unparseable'].includes(stage.outcome)) after = E.scoreCreativeResponse(stage.response, record.measure).outcome;
      else continue;
      compared++;
      if (after !== stage.outcome) changes.push({ requestId: record.requestId, stage: stage.stage, input: record.input, before: stage.outcome, after });
    }
  }
  return { compared, changed: changes.length, changes };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  switch (options.command) {
    case 'pull': {
      const sql = pullQuery(options);
      const output = execFileSync('npx', ['wrangler', 'd1', 'execute', database, '--remote', '--json', '--command', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 256 * 1024 * 1024 });
      const rows = JSON.parse(output).flatMap(result => result.results ?? []);
      await mkdir(root, { recursive: true });
      await writeFile(fileFor(options.out), rows.map(row => row.record).join('\n') + (rows.length ? '\n' : ''), { flag: options.force ? 'w' : 'wx' });
      console.log(JSON.stringify({ file: fileFor(options.out), records: rows.length }));
      break;
    }
    case 'summary':
      console.log(JSON.stringify(summarise(await readRecords(options.file)), null, 2));
      break;
    case 'rescore': {
      const result = rescore(await loadEngine(), await readRecords(options.file));
      console.log(JSON.stringify({ ...result, changes: result.changes.slice(0, 50) }, null, 2));
      break;
    }
    case 'inputs': {
      const records = (await readRecords(options.file)).filter(record => !options.refused || record.refused);
      console.log([...new Set(records.map(record => record.input))].join('\n'));
      break;
    }
    default:
      throw new Error('Commands: pull, summary, rescore, inputs. See the header of scripts/replay-log.mjs.');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { console.error(error.message ?? error); process.exitCode = 1; });
}
