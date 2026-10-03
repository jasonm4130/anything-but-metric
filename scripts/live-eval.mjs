// Opt-in live evaluation harness. Paid model calls happen only with `run --live` (or
// `resend --live`), never in CI. Every request, raw response, failure reason and judge
// verdict is appended to evals/results/live/<run>/records.jsonl so runs can be replayed,
// rescored and resumed. Raw records stay out of Git (evals/results/ is ignored).
//
//   node scripts/live-eval.mjs plan  --suite creative [--models a,b] [--limit 10]
//   node scripts/live-eval.mjs run   --live --suite creative --run bakeoff-1 [--models a,b] [--limit 10]
//   node scripts/live-eval.mjs judge --live --run bakeoff-1            (AI judge over a creative run)
//   node scripts/live-eval.mjs summary --run bakeoff-1 [--write]       (offline)
//   node scripts/live-eval.mjs replay  --run bakeoff-1                 (offline rescoring with current code)
//   node scripts/live-eval.mjs resend  --live --run bakeoff-1 --seq 12 [--model m]
//
// Suites: creative, refusal, estimate, jev-bands, jev-proposals (needs --from <creative run>).
// Options: --every K samples every Kth case; --context with|none|both (refusal suite);
// --rpm 5 and --concurrency 4 pace calls under the research gateway's rate limit;
// --max-usd (per invocation), --daily-usd and --monthly-usd (rolling, from spend-ledger.jsonl)
// stop a run before it would exceed a budget. Defaults sit below the gateway's own caps.
// Workers AI calls go through the AI binding (wrangler login or CLOUDFLARE_API_TOKEN) and the
// named AI Gateway. Jev calls need JEV_DECISIONS_URL plus AI_GATEWAY_TOKEN and/or
// OPENROUTER_API_KEY, normally supplied by `op run --env-file .env.op -- ...`.
import { build } from 'esbuild';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const recordSchema = 'abm-live-eval.v1';
const resultsRoot = resolve('evals/results/live');
const ledgerPath = resolve(resultsRoot, 'spend-ledger.jsonl');

// US$ per million tokens, from the Workers AI pricing page and OpenRouter's model API, checked 2026-10-03.
export const models = {
  '@cf/meta/llama-3.2-3b-instruct': { input: 0.051, output: 0.335, maxTokens: 900 },
  '@cf/meta/llama-3.1-8b-instruct-fp8-fast': { input: 0.045, output: 0.384, maxTokens: 900 },
  '@cf/qwen/qwen3-30b-a3b-fp8': { input: 0.051, output: 0.335, maxTokens: 2500, extra: { chat_template_kwargs: { enable_thinking: false } } },
  '@cf/zai-org/glm-4.7-flash': { input: 0.06, output: 0.4, maxTokens: 2500, extra: { chat_template_kwargs: { enable_thinking: false } } },
  '@cf/google/gemma-4-26b-a4b-it': { input: 0.1, output: 0.3, maxTokens: 2500, extra: { chat_template_kwargs: { enable_thinking: false } } },
  '@cf/zai-org/glm-5.3-flash': { input: 0.15, output: 0.5, maxTokens: 2500, extra: { reasoning_effort: 'low' } },
  '@cf/openai/gpt-oss-20b': { input: 0.2, output: 0.3, maxTokens: 2500, extra: { reasoning_effort: 'low' } },
  '@cf/meta/llama-4-scout-17b-16e-instruct': { input: 0.27, output: 0.85, maxTokens: 900 },
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { input: 0.293, output: 2.253, maxTokens: 900 },
  '@cf/openai/gpt-oss-120b': { input: 0.35, output: 0.75, maxTokens: 2500, extra: { reasoning_effort: 'low' } },
  '@cf/mistralai/mistral-small-3.1-24b-instruct': { input: 0.351, output: 0.555, maxTokens: 900 },
  'typesafe/jev-1.13': { input: 0.042, output: 0, maxTokens: 0, transport: 'jev' }
};
export const defaultCreativeModels = Object.keys(models).filter(model => models[model].transport !== 'jev');
const defaultJudge = '@cf/openai/gpt-oss-120b';

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) options[key] = true;
    else { options[key] = next; index++; }
  }
  return options;
}

/** Live commands need an explicit flag and never run under CI. */
export function assertLiveAllowed(options, env = process.env) {
  if (env.CI) throw new Error('Refusing to make paid model calls under CI.');
  if (options.live !== true) throw new Error('Paid model calls need the explicit --live flag.');
}

export function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function costOf(model, usage) {
  if (typeof usage?.providerCost === 'number') return usage.providerCost;
  const price = models[model];
  if (!price || !usage) return undefined;
  return ((usage.inputTokens ?? 0) * price.input + (usage.outputTokens ?? 0) * price.output) / 1e6;
}

/** Token counts from Workers AI, chat-completions or Decisions API usage blocks. */
export function usageOf(response) {
  const usage = response?.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
  if (typeof inputTokens !== 'number') return undefined;
  return { inputTokens, outputTokens, ...(typeof usage.cost === 'number' ? { providerCost: usage.cost } : {}) };
}

export function classifyError(error) {
  const message = String(error?.message ?? error);
  if (error?.name === 'AbortError' || /timed? ?out|timeout/i.test(message)) return 'timeout';
  if (/JSON Mode couldn'?t be met/i.test(message)) return 'json_mode_error';
  if (/\b429\b|rate.?limit/i.test(message)) return 'rate_limited';
  if (/spend|budget|quota|limit exceeded/i.test(message)) return 'spend_limited';
  if (/refus|content.?filter|moderat|flagged/i.test(message)) return 'refusal';
  return 'transport_error';
}

const sha = text => createHash('sha256').update(text).digest('hex');
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : undefined; };
const round = (value, digits = 4) => value === undefined ? undefined : Number(value.toFixed(digits));

export async function loadEngine() {
  const dir = await mkdtemp(resolve(tmpdir(), 'abm-live-eval-'));
  await build({ stdin: { contents: 'export * from "./src/lib/creative-proposals"; export * from "./src/lib/jev-decisions"; export * from "./src/lib/convert"; export { unit } from "mathjs";', resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile: resolve(dir, 'engine.mjs'), logLevel: 'error' });
  const engine = await import(pathToFileURL(resolve(dir, 'engine.mjs')));
  await rm(dir, { recursive: true, force: true });
  return engine;
}

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const readRecords = async run => {
  const path = resolve(resultsRoot, run, 'records.jsonl');
  if (!existsSync(path)) return [];
  return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
};

/** Builds the request list for a suite without sending anything. */
export async function planSuite(E, suite, options) {
  const selected = options.models ? String(options.models).split(',') : defaultCreativeModels;
  const limit = options.limit ? Number(options.limit) : Infinity;
  const every = options.every ? Number(options.every) : 1;
  const sample = rows => rows.filter((_, index) => index % every === 0).slice(0, limit);
  const jobs = [];
  if (suite === 'creative' || suite === 'refusal') {
    const set = await readJson(suite === 'creative' ? 'evals/sets/creative-inputs.json' : 'evals/sets/refusal.json');
    const themes = (await readJson('evals/sets/creative-inputs.json')).themes;
    const conditions = suite === 'creative' ? ['no-context'] : options.context === 'both' ? ['with-context', 'no-context'] : [options.context === 'none' ? 'no-context' : 'with-context'];
    sample(set.cases).forEach((item, index) => {
      const window = E.magnitudeWindow(item.gold[0], item.gold[1]);
      if (!window) return;
      const theme = item.theme ?? themes[index % themes.length];
      for (const condition of conditions) for (const model of selected) {
        jobs.push({ suite, caseId: item.id, condition, model, measurement: { quantity: item.gold[0], sourceUnit: item.gold[1] },
          request: { messages: [{ role: 'system', content: E.creativeProposalPrompt }, { role: 'user', content: E.creativeProposalInput(window, theme, condition === 'with-context' ? item.input : undefined) }], response_format: { type: 'json_schema', json_schema: E.creativeProposalSchema }, temperature: 0.8 } });
      }
    });
  } else if (suite === 'estimate') {
    const set = await readJson('evals/sets/estimate-entities.json');
    const items = sample(set.items);
    const size = Number(options.batch ?? 10);
    for (let start = 0; start < items.length; start += size) {
      const batch = items.slice(start, start + size);
      for (const model of selected) jobs.push({ suite, caseId: `batch-${start / size + 1}`, condition: 'batch', model, gold: batch.map(item => ({ id: item.id, gold: item.gold })),
        request: { messages: [{ role: 'system', content: E.estimatePrompt }, { role: 'user', content: JSON.stringify({ items: batch.map(item => ({ id: item.id, thing: item.thing, dimension: item.dimension })) }) }], response_format: { type: 'json_schema', json_schema: E.estimateSchema(batch.length) }, temperature: 0 } });
    }
  } else if (suite === 'jev-bands') {
    const entities = new Map((await readJson('evals/sets/estimate-entities.json')).items.map(item => [item.id, item]));
    const checks = sample((await readJson('evals/sets/jev-band-checks.json')).checks);
    const size = Number(options.batch ?? 10);
    for (let start = 0; start < checks.length; start += size) {
      const batch = checks.slice(start, start + size);
      const built = batch.map(check => { const entity = entities.get(check.entityId); return { check, band: E.bandCheckQuestion({ thing: entity.thing, dimension: entity.dimension, value: check.value, unit: check.unit }, check.position) }; });
      jobs.push({ suite, caseId: `bands-${start / size + 1}`, condition: 'batch', model: E.jevModel, bands: built.map(({ check, band }) => ({ id: check.id, kind: check.kind, factor: check.factor, proposedKey: band.proposedKey, bands: band.bands })),
        request: E.decisionsRequest({ task: 'Judge typical physical sizes of everyday and famous things.' }, Object.fromEntries(built.map(({ check, band }) => [check.id.replace(/[^A-Za-z0-9_]/g, '_'), band.question]))) });
    }
  } else if (suite === 'jev-proposals') {
    if (!options.from) throw new Error('jev-proposals needs --from <creative run>');
    const records = (await readRecords(options.from)).filter(record => record.suite === 'creative' && record.status === 'ok');
    const size = Number(options.batch ?? 10);
    const proposals = [];
    for (const record of records) {
      const value = E.responseContent(record.response).value;
      for (const check of record.scored?.checks ?? []) {
        if (!check.ok) continue;
        const proposal = value?.proposals?.[check.index];
        proposals.push({ id: `${record.seq}-${check.index}`, sourceSeq: record.seq, model: record.model, thing: proposal.singular, dimension: E.validateMeasurement(1, record.measurement.sourceUnit).dimension, value: proposal.value, unit: proposal.unit });
      }
    }
    const random = mulberry32(20261003);
    const usable = proposals.slice(0, limit);
    for (let start = 0; start < usable.length; start += size) {
      const batch = usable.slice(start, start + size).map(proposal => ({ proposal, band: E.bandCheckQuestion(proposal, Math.floor(random() * E.bandCount)) }));
      jobs.push({ suite, caseId: `proposals-${start / size + 1}`, condition: 'batch', model: E.jevModel, bands: batch.map(({ proposal, band }) => ({ id: proposal.id, sourceSeq: proposal.sourceSeq, sourceModel: proposal.model, proposedKey: band.proposedKey, bands: band.bands })),
        request: E.decisionsRequest({ task: 'Judge typical physical sizes of things proposed for playful comparisons.' }, Object.fromEntries(batch.map(({ proposal, band }) => [`p_${proposal.id.replace(/[^A-Za-z0-9_]/g, '_')}`, band.question]))) });
    }
  } else throw new Error(`Unknown suite: ${suite}`);
  return jobs;
}

export function projectedCost(job) {
  const price = models[job.model];
  const inputTokens = Math.ceil(JSON.stringify(job.request).length / 3);
  return (inputTokens * price.input + (price.maxTokens ?? 0) * price.output) / 1e6;
}

/** Score a stored response with the current code; used both live and on replay. */
export function scoreRecord(E, record) {
  if (record.status !== 'ok') return { outcome: record.error?.kind ?? 'transport_error' };
  if (record.suite === 'creative' || record.suite === 'refusal') {
    const finish = record.response?.choices?.[0]?.finish_reason;
    const scored = E.scoreCreativeResponse(record.response, record.measurement);
    return finish === 'content_filter' ? { ...scored, outcome: 'refusal' } : scored;
  }
  if (record.suite === 'estimate') {
    const value = E.responseContent(record.response).value;
    const estimates = Array.isArray(value?.estimates) ? value.estimates : [];
    if (!estimates.length) return { outcome: E.looksLikeRefusal(JSON.stringify(record.response)) ? 'refusal' : 'schema_error', items: [] };
    const byId = new Map(estimates.map(estimate => [estimate.id, estimate]));
    const items = record.gold.map(({ id, gold }) => {
      const estimate = byId.get(id);
      if (!estimate) return { id, reason: 'missing' };
      return { id, ...E.estimateError(estimate, { quantity: gold[0], unit: gold[1] }) };
    });
    return { outcome: 'ok', items };
  }
  if (record.suite === 'jev-bands' || record.suite === 'jev-proposals') {
    const items = record.bands.map(entry => {
      const name = record.suite === 'jev-bands' ? entry.id.replace(/[^A-Za-z0-9_]/g, '_') : `p_${entry.id.replace(/[^A-Za-z0-9_]/g, '_')}`;
      const answer = E.choiceAnswer(record.response, name);
      const check = { bands: entry.bands, proposedKey: entry.proposedKey };
      return { id: entry.id, kind: entry.kind, factor: entry.factor, sourceModel: entry.sourceModel, answer, verdicts: Object.fromEntries([0.3, 0.4, 0.5, 0.6].map(threshold => [threshold, E.bandVerdict(check, answer, threshold).accepted])), distance: E.bandVerdict(check, answer, 0).bandDistance };
    });
    return { outcome: items.some(item => item.answer) ? 'ok' : 'schema_error', items };
  }
  if (record.suite === 'judge') {
    const value = E.responseContent(record.response).value;
    const verdicts = Array.isArray(value?.verdicts) ? value.verdicts : [];
    const items = record.targets.map(target => {
      const verdict = verdicts.find(entry => entry.id === target.label);
      return { ...target, ...(verdict ? { picturable: verdict.picturable, delight: verdict.delight, clarity: verdict.clarity, plausible: verdict.plausible } : { missing: true }), best: value?.best === target.label };
    });
    return { outcome: verdicts.length ? 'ok' : 'schema_error', items };
  }
  return { outcome: 'unknown_suite' };
}

class Transport {
  constructor(options) {
    this.gateway = options.gateway ?? 'anything-but-metric-research';
    this.timeoutMs = Number(options['timeout-ms'] ?? 120_000);
  }
  async workersAi(model, request) {
    this.proxyReady ??= import('wrangler').then(({ getPlatformProxy }) => getPlatformProxy({ configPath: 'wrangler.jsonc', remoteBindings: true }));
    this.proxy = await this.proxyReady;
    const price = models[model];
    const body = { ...request, max_tokens: price.maxTokens, ...(price.extra ?? {}) };
    // The binding proxy cannot serialise an AbortSignal, so the timeout races the call instead.
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`Timed out after ${this.timeoutMs} ms`), { name: 'AbortError' })), this.timeoutMs); });
    const response = await Promise.race([this.proxy.env.AI.run(model, body, { gateway: { id: this.gateway, skipCache: true } }), timeout]).finally(() => clearTimeout(timer));
    return { response, gatewayLogId: this.proxy.env.AI.aiGatewayLogId, sentBody: body };
  }
  async jev(request) {
    const url = process.env.JEV_DECISIONS_URL;
    if (!url) throw Object.assign(new Error('JEV_DECISIONS_URL is not set; Jev suites are ready but not configured.'), { kind: 'jev_not_configured' });
    const headers = { 'content-type': 'application/json' };
    if (process.env.AI_GATEWAY_TOKEN) headers['cf-aig-authorization'] = `Bearer ${process.env.AI_GATEWAY_TOKEN}`;
    if (process.env.OPENROUTER_API_KEY) headers.authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`;
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(request), signal: AbortSignal.timeout(this.timeoutMs) });
    const text = await response.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`), { response: json });
    return { response: json, gatewayLogId: response.headers.get('cf-aig-log-id') ?? undefined, sentBody: request };
  }
  async send(job) {
    return models[job.model].transport === 'jev' ? this.jev(job.request) : this.workersAi(job.model, job.request);
  }
  async close() { if (this.proxyReady) await (await this.proxyReady).dispose(); }
}

async function spentSince(ms) {
  if (!existsSync(ledgerPath)) return 0;
  const cutoff = Date.now() - ms;
  return (await readFile(ledgerPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => Date.parse(entry.at) >= cutoff).reduce((sum, entry) => sum + entry.costUsd, 0);
}

async function writeManifest(run, options, E, jobs) {
  const runDir = resolve(resultsRoot, run);
  await mkdir(runDir, { recursive: true });
  const manifestPath = resolve(runDir, 'manifest.json');
  const manifest = existsSync(manifestPath) ? await readJson(manifestPath) : { schema: recordSchema, run, createdAt: new Date().toISOString(), invocations: [] };
  let gitSha; let dirty;
  try { gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); dirty = execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts', 'evals/sets'], { encoding: 'utf8' }).trim().length > 0; } catch { /* not a checkout */ }
  const setFiles = ['evals/sets/creative-inputs.json', 'evals/sets/refusal.json', 'evals/sets/estimate-entities.json', 'evals/sets/jev-band-checks.json'];
  manifest.invocations.push({ at: new Date().toISOString(), command: options.command, suite: options.suite, models: [...new Set(jobs.map(job => job.model))], jobs: jobs.length, gateway: options.gateway ?? 'anything-but-metric-research', gitSha, dirty,
    promptVersions: { creative: E.creativePromptVersion, jev: E.jevQuestionVersion, creativePromptSha256: sha(E.creativeProposalPrompt), estimatePromptSha256: sha(E.estimatePrompt), judgePromptSha256: sha(judgePrompt) },
    setSha256: Object.fromEntries(await Promise.all(setFiles.map(async file => [file, sha(await readFile(file, 'utf8'))]))), prices: Object.fromEntries([...new Set(jobs.map(job => job.model))].map(model => [model, { input: models[model].input, output: models[model].output }])),
    budget: { maxUsd: Number(options['max-usd'] ?? 0.25), dailyUsd: Number(options['daily-usd'] ?? 0.9), monthlyUsd: Number(options['monthly-usd'] ?? 4.5) } });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

async function execute(E, jobs, options) {
  const run = options.run;
  if (!run || !/^[A-Za-z0-9._-]+$/.test(run)) throw new Error('--run <id> is required (letters, digits, dot, dash, underscore).');
  const maxUsd = Number(options['max-usd'] ?? 0.25);
  const dailyUsd = Number(options['daily-usd'] ?? 0.9);
  const monthlyUsd = Number(options['monthly-usd'] ?? 4.5);
  const rpm = Number(options.rpm ?? 5);
  const existing = await readRecords(run);
  const done = new Set(existing.filter(record => record.status === 'ok' || !['spend_limited', 'rate_limited', 'timeout', 'jev_not_configured'].includes(record.error?.kind)).map(record => `${record.suite}|${record.caseId}|${record.condition}|${record.model}`));
  const pending = jobs.filter(job => !done.has(`${job.suite}|${job.caseId}|${job.condition}|${job.model}`));
  await writeManifest(run, options, E, pending);
  const recordsPath = resolve(resultsRoot, run, 'records.jsonl');
  let seq = existing.reduce((max, record) => Math.max(max, record.seq), 0);
  let runSpend = 0; let reserved = 0; let lastStart = 0; let stopReason;
  const concurrency = Number(options.concurrency ?? 4);
  const transport = new Transport(options);
  const counts = {};
  const inFlight = new Set();
  const sendOne = async (job, startedAt, projected) => {
    const base = { schema: recordSchema, run, seq: ++seq, at: new Date(startedAt).toISOString(), suite: job.suite, caseId: job.caseId, condition: job.condition, model: job.model, transport: { kind: models[job.model].transport ?? 'workers-ai', gateway: transport.gateway },
      ...(job.measurement ? { measurement: job.measurement } : {}), ...(job.gold ? { gold: job.gold } : {}), ...(job.bands ? { bands: job.bands } : {}), ...(job.targets ? { targets: job.targets } : {}) };
    let record;
    try {
      const sent = await transport.send(job);
      const usage = usageOf(sent.response);
      const costUsd = usage ? costOf(job.model, usage) : projected;
      record = { ...base, request: sent.sentBody, latencyMs: Date.now() - startedAt, gatewayLogId: sent.gatewayLogId, status: 'ok', response: sent.response, usage, costUsd, costSource: usage ? 'usage' : 'max-projection' };
    } catch (error) {
      const kind = error.kind ?? classifyError(error);
      // A failed call may still have been billed; record the worst case so budgets stay conservative.
      record = { ...base, request: job.request, latencyMs: Date.now() - startedAt, status: 'error', error: { kind, message: String(error.message ?? error).slice(0, 2000) }, ...(error.response ? { response: error.response } : {}), costUsd: kind === 'jev_not_configured' ? 0 : projected, costSource: 'max-projection' };
      if (kind === 'jev_not_configured') { stopReason = error.message; }
      if (kind === 'spend_limited') stopReason = 'Gateway spend limit reached.';
    }
    record.scored = scoreRecord(E, record);
    reserved -= projected; runSpend += record.costUsd;
    await appendFile(recordsPath, JSON.stringify(record) + '\n');
    await appendFile(ledgerPath, JSON.stringify({ at: record.at, run, seq: record.seq, model: record.model, costUsd: record.costUsd }) + '\n');
    const key = `${record.model} ${record.scored.outcome}`;
    counts[key] = (counts[key] ?? 0) + 1;
  };
  try {
    for (const job of pending) {
      if (stopReason) break;
      while (inFlight.size >= concurrency) await Promise.race(inFlight);
      const projected = projectedCost(job);
      const [day, month] = await Promise.all([spentSince(86_400_000), spentSince(30 * 86_400_000)]);
      if (runSpend + reserved + projected > maxUsd) { stopReason = `run budget US$${maxUsd} would be exceeded (spent ${runSpend.toFixed(4)})`; break; }
      if (day + reserved + projected > dailyUsd) { stopReason = `rolling 24-hour budget US$${dailyUsd} would be exceeded (spent ${day.toFixed(4)}); resume later with the same --run`; break; }
      if (month + reserved + projected > monthlyUsd) { stopReason = `rolling 30-day budget US$${monthlyUsd} would be exceeded (spent ${month.toFixed(4)})`; break; }
      const wait = lastStart + 60_000 / rpm - Date.now();
      if (wait > 0) await new Promise(done => setTimeout(done, wait));
      lastStart = Date.now();
      reserved += projected;
      const task = sendOne(job, lastStart, projected).finally(() => inFlight.delete(task));
      inFlight.add(task);
    }
    await Promise.all(inFlight);
  } finally {
    await transport.close();
  }
  if (stopReason) console.error(`Stopped: ${stopReason}`);
  console.log(JSON.stringify({ run, attempted: Object.values(counts).reduce((a, b) => a + b, 0), pendingBefore: pending.length, runSpendUsd: round(runSpend, 5), outcomes: counts }, null, 2));
}

const judgePrompt = `You judge entries for a toy that turns a measurement into a playful comparison. Each entry is one sentence plus the reference it relies on.
Rate every entry from 1 to 5 on: picturable (can a reader instantly picture it?), delight (is it fun, surprising or charming?), clarity (is the sentence clear and natural?). Also say whether the stated size of ONE reference item is plausible, meaning within about a factor of two of reality.
Then name the single best entry. Judge each entry on its own merits regardless of order or length. Return only JSON.`;

const judgeSchema = { type: 'object', properties: { verdicts: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, picturable: { type: 'integer', minimum: 1, maximum: 5 }, delight: { type: 'integer', minimum: 1, maximum: 5 }, clarity: { type: 'integer', minimum: 1, maximum: 5 }, plausible: { type: 'boolean' } }, required: ['id', 'picturable', 'delight', 'clarity', 'plausible'], additionalProperties: false } }, best: { type: 'string' } }, required: ['verdicts', 'best'], additionalProperties: false };

/** One judge call per case: each model's first valid proposal, anonymised and shuffled. */
export async function planJudge(E, options) {
  const source = options.from ?? options.run;
  const records = (await readRecords(source)).filter(record => record.suite === 'creative' && record.status === 'ok');
  const byCase = new Map();
  for (const record of records) {
    const check = record.scored?.checks?.find(entry => entry.ok);
    if (!check) continue;
    const proposal = E.responseContent(record.response).value.proposals[check.index];
    const entries = byCase.get(record.caseId) ?? [];
    entries.push({ sourceSeq: record.seq, model: record.model, text: check.text, reference: `one ${proposal.singular} ≈ ${proposal.value} ${proposal.unit}`, basis: proposal.basis, measurement: record.measurement });
    byCase.set(record.caseId, entries);
  }
  const judge = options.judge ?? defaultJudge;
  const jobs = [];
  for (const [caseId, entries] of [...byCase.entries()].slice(0, options.limit ? Number(options.limit) : Infinity)) {
    const random = mulberry32(Number.parseInt(sha(caseId).slice(0, 8), 16));
    const shuffled = entries.map(entry => ({ entry, key: random() })).sort((a, b) => a.key - b.key).map(({ entry }, index) => ({ ...entry, label: String.fromCharCode(65 + index) }));
    const { quantity, sourceUnit } = shuffled[0].measurement;
    jobs.push({ suite: 'judge', caseId, condition: `judged-from:${source}`, model: judge, targets: shuffled.map(({ label, sourceSeq, model }) => ({ label, sourceSeq, model })),
      request: { messages: [{ role: 'system', content: judgePrompt }, { role: 'user', content: JSON.stringify({ measurement: `${E.formatNumber(quantity)} ${sourceUnit}`, entries: shuffled.map(({ label, text, reference, basis }) => ({ id: label, text, reference, basis })) }) }], response_format: { type: 'json_schema', json_schema: judgeSchema }, temperature: 0 } });
  }
  return jobs;
}

export function summarise(records) {
  const groups = new Map();
  for (const record of records) {
    const key = `${record.suite}|${record.condition}|${record.model}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const rows = [];
  for (const [key, group] of groups) {
    const [suite, condition, model] = key.split('|');
    const outcomes = {};
    for (const record of group) outcomes[record.scored.outcome] = (outcomes[record.scored.outcome] ?? 0) + 1;
    const latencies = group.filter(record => record.status === 'ok').map(record => record.latencyMs);
    const row = { suite, condition, model, calls: group.length, outcomes, costUsd: round(group.reduce((sum, record) => sum + record.costUsd, 0), 5), latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) } };
    if (suite === 'creative' || suite === 'refusal') {
      const checks = group.flatMap(record => record.scored.checks ?? []);
      const reasons = {};
      for (const check of checks) for (const reason of check.reasons) reasons[reason] = (reasons[reason] ?? 0) + 1;
      Object.assign(row, { answerRate: round((outcomes.ok ?? 0) / group.length, 3), refusalRate: round(((outcomes.refusal ?? 0) + group.filter(record => record.scored.outcome !== 'refusal' && record.error?.kind === 'refusal').length) / group.length, 3), proposals: checks.length, validProposals: checks.filter(check => check.ok).length, rejectReasons: reasons });
    }
    if (suite === 'estimate') {
      const items = group.flatMap(record => record.scored.items ?? []);
      const errors = items.filter(item => typeof item.error === 'number').map(item => item.error);
      Object.assign(row, { items: items.length, scored: errors.length, medianAbsLog10Error: round(percentile(errors, 0.5), 3), within2x: round(errors.filter(error => error <= Math.log10(2)).length / Math.max(1, items.length), 3), within10x: round(errors.filter(error => error <= 1).length / Math.max(1, items.length), 3) });
    }
    if (suite === 'judge') {
      const items = group.flatMap(record => record.scored.items ?? []).filter(item => !item.missing);
      const perModel = {};
      for (const item of items) {
        const entry = perModel[item.model] ??= { judged: 0, picturable: 0, delight: 0, clarity: 0, plausible: 0, best: 0 };
        entry.judged++; entry.picturable += item.picturable; entry.delight += item.delight; entry.clarity += item.clarity; entry.plausible += item.plausible ? 1 : 0; entry.best += item.best ? 1 : 0;
      }
      row.perModel = Object.fromEntries(Object.entries(perModel).map(([name, entry]) => [name, { judged: entry.judged, picturable: round(entry.picturable / entry.judged, 2), delight: round(entry.delight / entry.judged, 2), clarity: round(entry.clarity / entry.judged, 2), mean: round((entry.picturable + entry.delight + entry.clarity) / (3 * entry.judged), 2), plausibleRate: round(entry.plausible / entry.judged, 2), bestCount: entry.best }]));
    }
    if (suite === 'jev-bands' || suite === 'jev-proposals') {
      const items = group.flatMap(record => record.scored.items ?? []).filter(item => item.answer);
      const byThreshold = {};
      for (const threshold of ['0.3', '0.4', '0.5', '0.6']) {
        const rate = filter => { const subset = items.filter(filter); return subset.length ? round(subset.filter(item => item.verdicts[threshold]).length / subset.length, 3) : undefined; };
        byThreshold[threshold] = suite === 'jev-bands'
          ? { acceptTrue: rate(item => item.kind === 'true'), ...Object.fromEntries([0.01, 0.1, 0.3, 3, 10, 100].map(factor => [`accept_x${factor}`, rate(item => item.kind === 'corrupted' && item.factor === factor)])) }
          : { acceptAll: rate(() => true) };
      }
      Object.assign(row, { answered: items.length, byThreshold });
    }
    rows.push(row);
  }
  return rows;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const E = await loadEngine();
  switch (options.command) {
    case 'plan': {
      const jobs = options.suite === 'judge' ? await planJudge(E, options) : await planSuite(E, options.suite, options);
      const projected = jobs.reduce((sum, job) => sum + projectedCost(job), 0);
      console.log(JSON.stringify({ suite: options.suite, jobs: jobs.length, models: [...new Set(jobs.map(job => job.model))], worstCaseUsd: round(projected, 4), rpmMinutes: round(jobs.length / Number(options.rpm ?? 5), 1) }, null, 2));
      break;
    }
    case 'run': {
      assertLiveAllowed(options);
      await execute(E, await planSuite(E, options.suite, options), options);
      break;
    }
    case 'judge': {
      assertLiveAllowed(options);
      await execute(E, await planJudge(E, options), { ...options, suite: 'judge' });
      break;
    }
    case 'resend': {
      assertLiveAllowed(options);
      const records = await readRecords(options.run);
      const record = records.find(entry => entry.seq === Number(options.seq));
      if (!record) throw new Error(`No record ${options.seq} in run ${options.run}`);
      const model = options.model ?? record.model;
      const request = Object.fromEntries(Object.entries(record.request).filter(([key]) => key !== 'max_tokens' && !(key in (models[record.model]?.extra ?? {}))));
      const prior = records.filter(entry => entry.model === model && entry.condition.startsWith(`resend-of-${record.seq}#`)).length;
      await execute(E, [{ suite: record.suite, caseId: record.caseId, condition: `resend-of-${record.seq}#${prior + 1}`, model, request, ...(record.measurement ? { measurement: record.measurement } : {}), ...(record.gold ? { gold: record.gold } : {}), ...(record.bands ? { bands: record.bands } : {}), ...(record.targets ? { targets: record.targets } : {}) }], options);
      break;
    }
    case 'replay': {
      const records = await readRecords(options.run);
      const changes = records.map(record => ({ seq: record.seq, before: record.scored?.outcome, after: scoreRecord(E, record).outcome })).filter(change => change.before !== change.after);
      console.log(JSON.stringify({ run: options.run, records: records.length, changedOutcomes: changes.length, changes: changes.slice(0, 50) }, null, 2));
      break;
    }
    case 'summary': {
      const records = (await readRecords(options.run)).map(record => ({ ...record, scored: scoreRecord(E, record) }));
      const summary = { run: options.run, records: records.length, totalCostUsd: round(records.reduce((sum, record) => sum + record.costUsd, 0), 5), rows: summarise(records) };
      if (options.write) await writeFile(resolve(resultsRoot, options.run, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
      console.log(JSON.stringify(summary, null, 2));
      break;
    }
    default:
      throw new Error('Commands: plan, run, judge, resend, replay, summary. See the header of scripts/live-eval.mjs.');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { console.error(error.message ?? error); process.exitCode = 1; });
}
