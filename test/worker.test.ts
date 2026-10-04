import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convert, type Env } from "../src/worker";

const bus = { label: "double-decker buses", singular: "double-decker bus", value: 12, unit: "tonne", basis: "A London bus weighs about 12 t empty.", family: "vehicles", line: "That's {N} double-decker buses parked nose to tail." };
const jevUrl = "https://gateway.ai.cloudflare.com/v1/account/anything-but-metric/custom-openrouter-api/api/alpha/decisions";

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://anythingbutmetric.wtf/api/convert", {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.8", ...headers },
    body: JSON.stringify({ turnstileToken: "verified-token", ...(body as Record<string, unknown>) })
  });
}

const fetchMock = vi.fn();
const turnstileOk = () => Promise.resolve(new Response(JSON.stringify({ success: true, hostname: "anythingbutmetric.wtf", action: "convert" })));

/** Each queued response answers one Workers AI call; an unqueued call fails like a provider error. */
function env(responses: unknown[] = [], allowed = true): Env & { aiRun: ReturnType<typeof vi.fn>; rows: unknown[][] } {
  const aiRun = vi.fn().mockRejectedValue(new Error("no fake response"));
  for (const response of responses) aiRun.mockResolvedValueOnce({ response });
  const rows: unknown[][] = [];
  const REPLAY_LOG = { prepare: vi.fn((query: string) => ({ bind: (...values: unknown[]) => ({ run: async () => { rows.push([query, ...values]); } }) })) };
  return { AI_ENABLED: "true", AI: { run: aiRun }, ASSETS: { fetch: vi.fn() }, RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: allowed }) }, TURNSTILE_SECRET_KEY: "test-secret", REPLAY_LOG, aiRun, rows };
}

describe("/api/convert", () => {
  beforeEach(() => {
    fetchMock.mockImplementation(turnstileOk);
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { fetchMock.mockReset(); vi.unstubAllGlobals(); });

  it("runs the creative model through the gateway for an explicit measurement", async () => {
    const bindings = env([{ proposals: [bus] }]);
    const response = await convert(request({ measurement: "40 tonnes" }), bindings);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ result: { origin: "model", dimension: "mass", interpretation: "40 tonne", headline: "That's 3.33 double-decker buses parked nose to tail." } });
    expect(bindings.aiRun).toHaveBeenCalledTimes(1);
    expect(bindings.aiRun).toHaveBeenCalledWith("@cf/zai-org/glm-5.3-flash", expect.objectContaining({ reasoning_effort: "low", response_format: expect.objectContaining({ type: "json_schema" }) }), expect.objectContaining({ gateway: { id: "anything-but-metric", skipCache: true }, signal: expect.any(AbortSignal) }));
  });

  it("converts AI-token counts locally with explicit estimate metadata and no model call", async () => {
    const bindings = env();
    const response = await convert(request({ measurement: "1M AI tokens" }), bindings);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ result: { dimension: "ai-tokens", quantity: 1e6, sourceUnit: "output tokens", estimate: { energyJoules: { min: 151000, max: 312000 } } } });
    expect(bindings.aiRun).not.toHaveBeenCalled();
  });

  it("keeps compact token counts out of the ordinary measurement reader", async () => {
    const bindings = env();
    const response = await convert(request({ measurement: "100tokens" }), bindings);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ result: { dimension: "ai-tokens", quantity: 100, estimate: expect.any(Object) } });
    expect(bindings.aiRun).not.toHaveBeenCalled();
    const rejected = env();
    expect((await convert(request({ measurement: "100totaltokens" }), rejected)).status).toBe(422);
    expect(rejected.aiRun).not.toHaveBeenCalled();
  });

  it("returns a useful estimate for one AI token", async () => {
    const bindings = env();
    const response = await convert(request({ measurement: "1 AI token" }), bindings);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ result: { quantity: 1, estimate: { energyJoules: { min: 0.151, max: 0.312 } } } });
    expect(bindings.aiRun).not.toHaveBeenCalled();
  });

  it("asks Jev through the gateway's OpenRouter route with only the gateway token", async () => {
    const bindings = { ...env([{ proposals: [bus, { ...bus, label: "blue whales", singular: "blue whale", value: 150, family: "sea life", line: "{N} blue whales." }] }]), JEV_DECISIONS_URL: jevUrl, AI_GATEWAY_TOKEN: "gateway-token" };
    fetchMock.mockImplementationOnce(turnstileOk).mockImplementationOnce(() => Promise.resolve(new Response("rate limited", { status: 429 })));
    const response = await convert(request({ measurement: "40 tonnes" }), bindings);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ result: { origin: "model" } });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(jevUrl);
    expect(init.headers).toEqual({ "content-type": "application/json", "cf-aig-authorization": "Bearer gateway-token" });
    expect(JSON.parse(init.body)).toMatchObject({ model: "typesafe/jev-1.13", questions: { band_1: { type: "choice" }, band_2: { type: "choice" }, pick: { type: "choice" } } });
    const record = JSON.parse(bindings.rows[0][8] as string);
    expect(record.stages.at(-1)).toMatchObject({ stage: "jev-review", outcome: "rate_limited", response: { status: 429 } });
  });

  it("logs every verified question and response for replay, without the IP or Turnstile token", async () => {
    const waitUntil = vi.fn();
    const bindings = env([{ proposals: [bus] }]);
    await convert(request({ measurement: "40 tonnes" }), bindings, { waitUntil });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0][0];
    const [query, requestId, createdAt, outcome, status, refused, , input, record] = bindings.rows[0];
    expect(query).toMatch(/^INSERT INTO conversions/);
    expect({ requestId, outcome, status, refused, input }).toEqual({ requestId: expect.any(String), outcome: "model", status: 200, refused: 0, input: "40 tonnes" });
    expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.parse(record as string)).toMatchObject({ schema: "abm-replay.v1", stages: [{ stage: "creative", outcome: "ok", request: expect.stringContaining("40 tonnes"), response: { response: { proposals: [bus] } } }, { stage: "jev-review", outcome: "unavailable" }] });
    expect(record).not.toMatch(/203\.0\.113\.8|verified-token|test-secret/);
  });

  it("logs refused and rejected questions too", async () => {
    const bindings = env([{ kind: "none", amount: 1, written: "", perUnit: 1, standardUnit: "m", estimated: false, item: "", items: "", subject: "" }]);
    expect((await convert(request({ measurement: "the lab sneezed" }), bindings)).status).toBe(422);
    expect(bindings.rows[0]).toEqual(expect.arrayContaining(["rejected", 422, 0, "the lab sneezed"]));
    const refused = env(["I'm sorry, but I can't help with that."]);
    expect((await convert(request({ measurement: "the weight of a dead body" }), refused)).status).toBe(422);
    expect(refused.rows[0]).toEqual(expect.arrayContaining(["rejected", 422, 1]));
  });

  it("rejects unsupported input/cached token classes without inference and still verifies tokens first", async () => {
    for (const measurement of ["1M input tokens", "1M cached tokens", "1.5 tokens"]) {
      const bindings = env();
      expect((await convert(request({ measurement }), bindings)).status).toBe(422);
      expect(bindings.aiRun).not.toHaveBeenCalled();
    }
    const bindings = env();
    expect((await convert(request({ measurement: "1M AI tokens", turnstileToken: "" }), bindings)).status).toBe(403);
    expect(bindings.aiRun).not.toHaveBeenCalled();
  });

  it("uses the reader for prose at low reasoning effort, and rejects a changed number", async () => {
    const reading = { kind: "physical", amount: 2, written: "metresish", perUnit: 1, standardUnit: "m", estimated: false, item: "", items: "", subject: "" };
    const accepted = env([reading, { proposals: [{ ...bus, value: 0.5, unit: "m", line: "{N} double-decker buses, nose to tail." }] }]);
    expect((await convert(request({ measurement: "2 metresish" }), accepted)).status).toBe(200);
    expect(accepted.aiRun.mock.calls.map(([model]) => model)).toEqual(["@cf/zai-org/glm-5.3-flash", "@cf/zai-org/glm-5.3-flash"]);
    expect(accepted.aiRun.mock.calls[0][1]).toMatchObject({ temperature: 0, reasoning_effort: "low", max_tokens: 600, messages: [{ role: "system" }, { role: "user", content: "2 metresish" }] });
    const changed = env([{ ...reading, amount: 3 }]);
    expect((await convert(request({ measurement: "2 metresish" }), changed)).status).toBe(422);
    expect(changed.aiRun).toHaveBeenCalledTimes(1);
  });

  it("reads strict JSON from standard chat-completion envelopes", async () => {
    const bindings = env();
    bindings.aiRun.mockReset();
    bindings.aiRun.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ kind: "physical", amount: 1, written: "J", perUnit: 1, standardUnit: "J", estimated: false, item: "", items: "", subject: "a sneeze" }) } }] });
    bindings.aiRun.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ proposals: [{ ...bus, value: 0.1, unit: "J", line: "{N} double-decker buses, lifted a hair." }] }) } }] });
    const response = await convert(request({ measurement: "the lab sneezed" }), bindings);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ result: { interpretation: "1 J", headline: "10 double-decker buses, lifted a hair.", origin: "model" } });
    expect(bindings.aiRun).toHaveBeenCalledTimes(2);
  });

  it("preserves scientific notation through the actual entrypoint without a reader call", async () => {
    const bindings = env();
    const response = await convert(request({ measurement: "1e12joules" }), bindings);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ result: { interpretation: "1000000000000 J" } });
    expect(bindings.aiRun).toHaveBeenCalledTimes(1);
    expect(bindings.aiRun.mock.calls[0][0]).toBe("@cf/zai-org/glm-5.3-flash");
  });

  it("rejects a nonzero literal that underflows before any AI call", async () => {
    const bindings = env();
    expect((await convert(request({ measurement: "1e-999 m" }), bindings)).status).toBe(422);
    expect(bindings.aiRun).not.toHaveBeenCalled();
  });

  it("converts reciprocal units through the actual entrypoint", async () => {
    const bindings = env([{ proposals: [{ ...bus, label: "pendulum swings", singular: "pendulum swing", value: 1, unit: "Hz", line: "{N} pendulum swings every second." }] }]);
    const response = await convert(request({ measurement: "2 1/s" }), bindings);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ result: { quantity: 2, sourceUnit: "s^-1", dimension: "frequency", headline: "2 pendulum swings every second." } });
    expect(bindings.aiRun).toHaveBeenCalledTimes(1);
  });

  it("calculates fractional measurements locally and sends only the creative request", async () => {
    for (const [measurement, quantity, sourceUnit] of [["1/2 litre", 0.5, "L"], ["half a litre", 0.5, "L"], ["1/2 L 250 mL", 750, "mL"]] as const) {
      const bindings = env();
      const response = await convert(request({ measurement }), bindings);
      expect(response.status).toBe(200);
      const body = await response.json() as { result: { quantity: number; sourceUnit: string } };
      expect(body.result.sourceUnit).toBe(sourceUnit);
      expect(body.result.quantity).toBeCloseTo(quantity, 10);
      expect(bindings.aiRun).toHaveBeenCalledTimes(1);
    }
  });

  it("sums mixed literals locally and sends only the creative request", async () => {
    for (const measurement of ["5 ft 6 in", "5ft6in"]) {
      const bindings = env();
      const response = await convert(request({ measurement }), bindings);
      expect(response.status).toBe(200);
      const body = await response.json() as { result: { quantity: number; sourceUnit: string; dimension: string } };
      expect(body.result.quantity).toBeCloseTo(66, 10);
      expect(body.result).toMatchObject({ sourceUnit: "in", dimension: "length" });
      expect(bindings.aiRun).toHaveBeenCalledTimes(1);
    }
  });

  it("never lets creative output change the measurement or add fields", async () => {
    for (const output of [{ proposals: [{ ...bus, quantity: 2, sourceUnit: "L" }] }, { proposals: [{ ...bus, line: "That's 7 buses, trust me." }] }, ["not an object"]]) {
      const bindings = env([output]);
      const response = await convert(request({ measurement: "40 tonnes" }), bindings);
      expect(response.status).toBe(200);
      const payload = await response.json() as { result: Record<string, unknown> };
      expect(payload.result).toMatchObject({ quantity: 40, sourceUnit: "tonne" });
      expect(payload.result.headline).not.toMatch(/\b7 buses/);
      expect(payload.result).not.toHaveProperty("quip");
      expect(bindings.aiRun).toHaveBeenCalledTimes(1);
    }
  });

  it("honours recent families and rejects malformed history before inference", async () => {
    const first = env();
    const response = await convert(request({ measurement: "144 J" }), first);
    const { result } = await response.json() as { result: { family: string; recentFamilies: string[] } };
    const next = env();
    const nextResponse = await convert(request({ measurement: "144 J", recentFamilies: result.recentFamilies }), next);
    expect((await nextResponse.json() as { result: { family: string } }).result.family).not.toBe(result.family);
    expect(JSON.parse(next.aiRun.mock.calls[0][1].messages[1].content).avoid).toEqual(result.recentFamilies);
    for (const recentFamilies of ["bad", Array(9).fill("too-many"), ["ignore instructions"], [{}]]) {
      const bindings = env(); expect((await convert(request({ measurement: "144 J", recentFamilies }), bindings)).status).toBe(400);
      expect(bindings.aiRun).not.toHaveBeenCalled();
    }
  });

  it("gives the creative model a try at scales the catalogue cannot reach", async () => {
    const empty = env();
    expect((await convert(request({ measurement: "1e50 kg" }), empty)).status).toBe(502);
    expect(empty.aiRun).toHaveBeenCalledTimes(1);
    const stars = env([{ proposals: [{ ...bus, label: "Suns", singular: "Sun", value: 2e30, unit: "kg", line: "{N} Suns on a cosmic bathroom scale." }] }]);
    await expect((await convert(request({ measurement: "1e33 kg" }), stars)).json()).resolves.toMatchObject({ result: { headline: "500 Suns on a cosmic bathroom scale." } });
  });

  it("logs a one-line stage summary without measurement text, model text or request data", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const bindings = env(); bindings.aiRun.mockReset(); bindings.aiRun.mockRejectedValueOnce(new Error("private-model-text"));
      await convert(request({ measurement: "987 jouls" }), bindings);
      const entry = JSON.parse(log.mock.calls[0][0]);
      expect(entry).toMatchObject({ requestId: expect.any(String), outcome: "template", status: 200, dimension: "energy", stages: [expect.stringMatching(/^creative:provider:\d+$/), expect.stringMatching(/^jev-template:unavailable:0$/)] });
      expect(log.mock.calls[0][0]).not.toMatch(/private-|987 jouls|verified-token|203\.0\.113\.8|test-secret/);
    } finally {
      log.mockRestore();
    }
  });

  it("stops after reader output that is malformed, invalid, negative, or below absolute zero", async () => {
    const reading = (amount: number, standardUnit: string) => ({ kind: "physical", amount, written: "bad measurement", perUnit: 1, standardUnit, estimated: true, item: "", items: "", subject: "" });
    for (const output of ["not json", reading(1, "not-a-unit"), reading(-1, "J"), reading(-274, "degC"), reading(1e308, "km"), reading(Number.MIN_VALUE, "mm"), reading(1, "m^1e309")]) {
      const bindings = env([output]);
      const response = await convert(request({ measurement: "bad measurement" }), bindings);
      expect(response.status).toBe(422);
      expect(bindings.aiRun).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps reader budget failures explicit and answers from the catalogue when the creative model is budget-limited", async () => {
    const readerLimited = env();
    readerLimited.aiRun.mockRejectedValueOnce(Object.assign(new Error("gateway exhausted"), { status: 429 }));
    const readerResponse = await convert(request({ measurement: "the lab sneezed" }), readerLimited);
    expect(readerResponse.status).toBe(429);
    await expect(readerResponse.json()).resolves.toMatchObject({ error: "The comparison engine is busy. Please try again shortly.", requestId: expect.any(String) });
    const creativeLimited = env();
    creativeLimited.aiRun.mockRejectedValueOnce(Object.assign(new Error("budget exhausted"), { status: 429 }));
    const creativeResponse = await convert(request({ measurement: "144 J" }), creativeLimited);
    expect(creativeResponse.status).toBe(200);
    await expect(creativeResponse.json()).resolves.toMatchObject({ result: { packetId: expect.any(String), quantity: 144, origin: "catalogue" } });
    expect(creativeLimited.aiRun).toHaveBeenCalledTimes(1);
  });

  it("classifies upstream timeouts and aborts as timeout stages", async () => {
    for (const failure of [new Error("upstream request timeout"), new DOMException("aborted", "AbortError")]) {
      const bindings = env();
      bindings.aiRun.mockRejectedValueOnce(failure);
      const response = await convert(request({ measurement: "144 J" }), bindings);
      expect(response.status).toBe(200);
      expect(JSON.parse(bindings.rows[0][8] as string).stages[0]).toMatchObject({ stage: "creative", model: "@cf/zai-org/glm-5.3-flash", outcome: failure instanceof DOMException ? "provider" : "timeout" });
    }
  });

  it("rejects too-long input and oversized bodies before inference", async () => {
    const tooLong = env();
    expect((await convert(request({ measurement: "x".repeat(501) }), tooLong)).status).toBe(400);
    expect(tooLong.aiRun).not.toHaveBeenCalled();
    const oversized = env();
    expect((await convert(request({ measurement: "2 km", padding: "x".repeat(9000) }), oversized)).status).toBe(413);
    expect(oversized.aiRun).not.toHaveBeenCalled();
  });

  it("cancels a chunked oversized request before reading further", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(`{"measurement":"${"x".repeat(9000)}`)); }, cancel() { cancelled = true; } });
    const streamed = new Request("https://anythingbutmetric.wtf/api/convert", { method: "POST", headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.8" }, body });
    const bindings = env();
    expect((await convert(streamed, bindings)).status).toBe(413);
    expect(cancelled).toBe(true);
    expect(bindings.aiRun).not.toHaveBeenCalled();
  });

  it("uses the Cloudflare connection IP with its rate-limit binding", async () => {
    const bindings = env(undefined, false);
    expect((await convert(request({ measurement: "2 km" }), bindings)).status).toBe(429);
    expect(bindings.RATE_LIMITER.limit).toHaveBeenCalledWith({ key: "203.0.113.8" });
    expect(bindings.aiRun).not.toHaveBeenCalled();
  });

  it("preserves every Turnstile failure gate before AI", async () => {
    const noToken = new Request("https://anythingbutmetric.wtf/api/convert", { method: "POST", headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.8" }, body: JSON.stringify({ measurement: "2 km" }) });
    const missing = env();
    expect((await convert(noToken, missing)).status).toBe(403);
    expect(missing.aiRun).not.toHaveBeenCalled();
    for (const verification of [{ success: false }, { success: true, hostname: "elsewhere.example", action: "convert" }, { success: true, hostname: "anythingbutmetric.wtf", action: "other" }]) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(verification)));
      const bindings = env();
      expect((await convert(request({ measurement: "2 km" }), bindings)).status).toBe(403);
      expect(bindings.aiRun).not.toHaveBeenCalled();
    }
  });

  it("fails closed when Siteverify times out, errors, returns malformed JSON, lacks a secret, or receives an invalid token", async () => {
    fetchMock.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    fetchMock.mockRejectedValueOnce(new Error("network failure"));
    fetchMock.mockResolvedValueOnce(new Response("not json"));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const bindings = env();
      expect((await convert(request({ measurement: "2 km" }), bindings)).status).toBe(403);
      expect(bindings.aiRun).not.toHaveBeenCalled();
    }
    const missingSecret = env();
    missingSecret.TURNSTILE_SECRET_KEY = undefined;
    expect((await convert(request({ measurement: "2 km" }), missingSecret)).status).toBe(403);
    for (const token of ["", "x".repeat(2049)]) {
      const bindings = env();
      expect((await convert(request({ measurement: "2 km", turnstileToken: token }), bindings)).status).toBe(403);
      expect(bindings.aiRun).not.toHaveBeenCalled();
    }
  });

  it("rejects a mismatched Origin and disabled inference before verification or AI", async () => {
    const foreign = env();
    expect((await convert(request({ measurement: "2 km" }, { origin: "https://elsewhere.example" }), foreign)).status).toBe(403);
    expect(foreign.aiRun).not.toHaveBeenCalled();
    const disabled = env();
    disabled.AI_ENABLED = "false";
    expect((await convert(request({ measurement: "2 km" }), disabled)).status).toBe(503);
    expect(disabled.aiRun).not.toHaveBeenCalled();
  });
});
