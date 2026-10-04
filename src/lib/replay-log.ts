import type { ReplayRecord } from "./model-flow";

/**
 * Production replay log: one D1 row per verified conversion, including refusals and
 * failures, so questions and responses can be replayed against later prompts and models.
 * Rows keep the measurement text and model payloads, never the IP address or Turnstile
 * token. Rows older than `replayRetentionDays` are pruned on every write and by a daily cron.
 */

export const replayRetentionDays = 30;
const maxRecordChars = 96_000;

export type ReplayDatabase = {
  prepare(query: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
};

/** Serialise a record within the row budget, dropping raw payloads before anything else. */
export function serialiseRecord(record: ReplayRecord): string {
  const full = JSON.stringify(record);
  if (full.length <= maxRecordChars) return full;
  const slim = { ...record, truncated: true, stages: record.stages.map(({ response, ...stage }) => ({ ...stage, response: response === undefined ? undefined : "[dropped: record too large]" })) };
  const text = JSON.stringify(slim);
  return text.length <= maxRecordChars ? text : JSON.stringify({ ...slim, stages: slim.stages.map(({ request, ...stage }) => ({ ...stage, request: request === undefined ? undefined : "[dropped]" })) });
}

/** Delete rows older than the retention window; never throws. */
export async function pruneReplay(db: ReplayDatabase | undefined, now: number): Promise<void> {
  if (!db) return;
  try {
    const cutoff = new Date(now - replayRetentionDays * 86_400_000).toISOString();
    await db.prepare("DELETE FROM conversions WHERE created_at < ?").bind(cutoff).run();
  } catch (cause) {
    console.error(JSON.stringify({ stage: "replay-prune", reason: cause instanceof Error ? cause.message.slice(0, 200) : "unknown" }));
  }
}

export async function writeReplay(db: ReplayDatabase | undefined, record: ReplayRecord): Promise<void> {
  if (!db) return;
  try {
    await db.prepare("INSERT INTO conversions (request_id, created_at, outcome, status, refused, latency_ms, input, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(record.requestId, record.at, record.outcome, record.status, record.refused ? 1 : 0, record.latencyMs, record.input, serialiseRecord(record)).run();
  } catch (cause) {
    // Logging must never break a conversion; Workers Logs keeps the failure.
    console.error(JSON.stringify({ requestId: record.requestId, stage: "replay-log", reason: cause instanceof Error ? cause.message.slice(0, 200) : "unknown" }));
  }
  await pruneReplay(db, Date.parse(record.at));
}

/** One compact line per conversion for Workers Logs, without the measurement text. */
export function summaryLine(record: ReplayRecord): string {
  return JSON.stringify({
    requestId: record.requestId, outcome: record.outcome, status: record.status, refused: record.refused, latencyMs: record.latencyMs,
    dimension: record.measure?.dimension, stages: record.stages.map(stage => `${stage.stage}:${stage.outcome}:${stage.latencyMs}`)
  });
}
