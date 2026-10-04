import { validRecentFamilies } from "./lib/comparison-flow";
import type { DecisionsRequest } from "./lib/jev-decisions";
import { answer, StageFailure, type Models } from "./lib/model-flow";
import { pruneReplay, summaryLine, writeReplay, type ReplayDatabase } from "./lib/replay-log";

export { interpretMeasurement } from "./lib/measurement";

export interface Env {
  AI: { run(model: string, input: unknown, options: unknown): Promise<unknown> };
  ASSETS: { fetch(request: Request): Promise<Response> };
  RATE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
  AI_ENABLED?: string;
  TURNSTILE_SECRET_KEY?: string;
  /** Jev's Decisions API through the AI Gateway's custom OpenRouter route. */
  JEV_DECISIONS_URL?: string;
  /** Gateway token; the gateway adds the stored OpenRouter key. */
  AI_GATEWAY_TOKEN?: string;
  REPLAY_LOG?: ReplayDatabase;
}

type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

const MAX_INPUT = 500;
const MAX_BODY = 8192;
const TURNSTILE_TIMEOUT_MS = 5_000;
const TURNSTILE_HOSTNAME = "anythingbutmetric.wtf";
const TURNSTILE_ACTION = "convert";
const GATEWAY_ID = "anything-but-metric";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const error = (message: string, requestId: string, status: number) => json({ error: message, requestId }, status);

function validMeasurement(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const measurement = value.trim();
  return measurement && measurement.length <= MAX_INPUT ? measurement : null;
}

function validTurnstileToken(value: unknown): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= 2048 ? value : null;
}

class BodyTooLargeError extends Error {}

async function readBoundedBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(output);
}

function providerRateLimited(value: unknown): boolean {
  if (value && typeof value === "object" && "status" in value && (value as { status?: unknown }).status === 429) return true;
  return value instanceof Error && /\b429\b|rate.?limit|budget/i.test(value.message);
}

function providerTimedOut(value: unknown): boolean {
  if (value && typeof value === "object" && "status" in value && (value as { status?: unknown }).status === 504) return true;
  if (value && typeof value === "object" && "code" in value && ["ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(String((value as { code?: unknown }).code))) return true;
  return value instanceof Error && (value.name === "TimeoutError" || /\b(?:upstream )?(?:request )?timeout\b|\btimed out\b/i.test(value.message));
}

async function verifyTurnstile(token: string, remoteip: string, secret: string | undefined): Promise<boolean> {
  if (!secret) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TURNSTILE_TIMEOUT_MS);
  try {
    const body = new URLSearchParams({ secret, response: token, remoteip });
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal
    });
    if (!response.ok) return false;
    const result: unknown = await response.json();
    return Boolean(result && typeof result === "object" && (result as { success?: unknown }).success === true && (result as { hostname?: unknown }).hostname === TURNSTILE_HOSTNAME && (result as { action?: unknown }).action === TURNSTILE_ACTION);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function failureOf(cause: unknown, aborted: boolean): StageFailure {
  const reason = aborted || providerTimedOut(cause) ? "timeout" : providerRateLimited(cause) ? "rate_limited" : "provider";
  return new StageFailure(reason, cause instanceof Error ? cause.message.slice(0, 500) : undefined);
}

/** Workers AI through the authenticated gateway, with caching bypassed. */
function workersAi(env: Env): Models["workersAi"] {
  return async (model, body, timeoutMs) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await env.AI.run(model, body, { gateway: { id: GATEWAY_ID, skipCache: true }, signal: controller.signal });
    } catch (cause) {
      throw failureOf(cause, controller.signal.aborted);
    } finally {
      clearTimeout(timeout);
    }
  };
}

/** Jev's Decisions API through the gateway's custom OpenRouter route; absent until configured. */
function jev(env: Env): Models["jev"] {
  const url = env.JEV_DECISIONS_URL;
  const token = env.AI_GATEWAY_TOKEN;
  if (!url || !token) return undefined;
  return async (request: DecisionsRequest, timeoutMs: number) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "cf-aig-authorization": `Bearer ${token}` }, body: JSON.stringify(request), signal: controller.signal });
      const text = await response.text();
      if (!response.ok) throw new StageFailure(response.status === 429 ? "rate_limited" : response.status === 504 ? "timeout" : "provider", { status: response.status, body: text.slice(0, 2000) });
      try {
        return JSON.parse(text);
      } catch {
        throw new StageFailure("provider", { status: response.status, body: text.slice(0, 2000) });
      }
    } catch (cause) {
      throw cause instanceof StageFailure ? cause : failureOf(cause, controller.signal.aborted);
    } finally {
      clearTimeout(timeout);
    }
  };
}

export async function convert(request: Request, env: Env, context?: WaitUntil): Promise<Response> {
  const requestId = crypto.randomUUID();
  if (request.method !== "POST") return error("Use POST for a measurement.", requestId, 405);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return error("Send this measurement from Anything But Metric.", requestId, 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return error("Send a JSON request.", requestId, 415);
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length > MAX_BODY) return error("That message is too large.", requestId, 413);
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) return error("I need Cloudflare's connection header to keep this fair.", requestId, 400);
  const allowed = await env.RATE_LIMITER.limit({ key: ip });
  if (!allowed.success) return error("You've used this minute's measuring tape. Try again shortly.", requestId, 429);
  let body: unknown;
  try {
    body = JSON.parse(await readBoundedBody(request));
  } catch (cause) {
    return cause instanceof BodyTooLargeError ? error("That message is too large.", requestId, 413) : error("That wasn't valid JSON.", requestId, 400);
  }
  const recentFamilies = validRecentFamilies((body as Record<string, unknown>)?.recentFamilies);
  if (!recentFamilies) return error("That comparison history is invalid. Refresh and try again.", requestId, 400);
  const measurement = validMeasurement((body as Record<string, unknown>)?.measurement);
  if (!measurement) return error("Enter one measurement of up to 500 characters.", requestId, 400);
  if (env.AI_ENABLED !== "true") return error("The comparison engine is warming up. Please try again soon.", requestId, 503);
  const turnstileToken = validTurnstileToken((body as Record<string, unknown>)?.turnstileToken);
  if (!turnstileToken) return error("Please complete verification before converting.", requestId, 403);
  if (!await verifyTurnstile(turnstileToken, ip, env.TURNSTILE_SECRET_KEY)) return error("Verification expired or failed. Please try again.", requestId, 403);

  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const outcome = await answer(measurement, recentFamilies, { workersAi: workersAi(env), jev: jev(env) }, { requestId, seed });
  console.log(summaryLine(outcome.record));
  const write = writeReplay(env.REPLAY_LOG, outcome.record);
  if (context) context.waitUntil(write);
  else await write;
  return "error" in outcome.body ? error(outcome.body.error, requestId, outcome.status) : json(outcome.body, outcome.status);
}

export default {
  async fetch(request: Request, env: Env, context: WaitUntil): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/convert") return convert(request, env, context);
    return env.ASSETS.fetch(request);
  },
  async scheduled(controller: { scheduledTime: number }, env: Env, context: WaitUntil): Promise<void> {
    context.waitUntil(pruneReplay(env.REPLAY_LOG, controller.scheduledTime));
  }
};
