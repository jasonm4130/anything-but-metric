import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import finalist from "../evals/delight-selection-finalist-28.json";
import { convert, type Env } from "../src/worker";

const parsed = { recognized: true, quantity: 144, sourceUnit: "J" };
const reference = { referenceQuantity: 1.5, referenceUnit: "J", referenceLabel: "apples lifted onto counters", assumption: "lifting one apple about a metre takes roughly this much energy" };
const chooseFirst = (_model: string, input: { response_format: { json_schema: { properties: { packetId: { enum: string[] } } } } }) => ({ response: { packetId: input.response_format.json_schema.properties.packetId.enum[0] } });

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://anythingbutmetric.wtf/api/convert", {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.8", ...headers },
    body: JSON.stringify({ turnstileToken: "verified-token", ...(body as Record<string, unknown>) })
  });
}

const fetchMock = vi.fn();

function env(responses: unknown[] = [undefined], allowed = true): Env & { aiRun: ReturnType<typeof vi.fn> } {
  const aiRun = vi.fn();
  for (const response of responses) { if (response === undefined) aiRun.mockImplementationOnce(chooseFirst); else aiRun.mockResolvedValueOnce({ response }); }
  return { AI_ENABLED: "true", AI: { run: aiRun }, ASSETS: { fetch: vi.fn() }, RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: allowed }) }, TURNSTILE_SECRET_KEY: "test-secret", aiRun };
}

describe("/api/convert", () => {
  beforeEach(() => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ success: true, hostname: "anythingbutmetric.wtf", action: "convert" }))));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { fetchMock.mockReset(); vi.unstubAllGlobals(); });

  it("bypasses the parser for an explicit measurement and runs the creative reference call through the gateway", async () => {
    const bindings = env();
    const response = await convert(request({ measurement: "144 jouls" }), bindings);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ result: { dimension: "energy", packetId: expect.any(String), interpretation: "144 J" } });
    expect(bindings.aiRun).toHaveBeenCalledTimes(1);
    expect(bindings.aiRun).toHaveBeenCalledWith("@cf/meta/llama-3.2-3b-instruct", expect.objectContaining({ temperature: 0.2, max_tokens: 256, response_format: expect.objectContaining({ type: "json_schema" }) }), expect.objectContaining({ gateway: { id: "anything-but-metric", skipCache: true } }));
  });

  it("uses the frozen selector prompt and offers only immutable packet IDs", async () => {
    const bindings = env();
    const response = await convert(request({ measurement: "144 jouls" }), bindings);
    const [model, input, options] = bindings.aiRun.mock.calls[0];
    expect(model).toBe(finalist.model);
    expect(input.messages[0]).toEqual({role:"system",content:finalist.systemPrompt});
    const context = JSON.parse(input.messages[1].content);
    expect(context.originalMeasurement).toBe("144 jouls");
    expect(context.packets.length).toBeGreaterThan(0);
    expect(input.response_format.json_schema.required).toEqual(["packetId"]);
    expect(input.response_format.json_schema.additionalProperties).toBe(false);
    expect(options.gateway.id).toBe("anything-but-metric");
    const payload = await response.json() as {result:{headline:string;packetId:string}};
    const chosen = context.packets.find((p:{id:string})=>p.id===payload.result.packetId);
    expect(payload.result.headline).toBe(chosen.headline);
  });

  it("rejects selector output that tries to replace facts and returns an offered fallback", async () => {
    const bindings = env();
    bindings.aiRun.mockReset();
    bindings.aiRun.mockImplementationOnce((model,input)=>({response:{...chooseFirst(model,input).response,quantity:2,sourceUnit:"L",headline:"model invention"}}));
    const response = await convert(request({measurement:"144 jouls"}),bindings);
    const payload = await response.json() as {result:{quantity:number;sourceUnit:string;headline:string;packetId:string}};
    expect(payload.result).toMatchObject({quantity:144,sourceUnit:"J"});
    expect(payload.result.headline).not.toBe("model invention");
    const offered = JSON.parse(bindings.aiRun.mock.calls[0][1].messages[1].content).packets;
    expect(offered.some((p:{id:string})=>p.id===payload.result.packetId)).toBe(true);
    expect(bindings.aiRun).toHaveBeenCalledTimes(1);
  });

  it("uses the parser for an unknown literal but rejects a changed quantity", async () => {
    const accepted = env([{ recognized: true, quantity: 2, sourceUnit: "m" }, { ...reference, referenceUnit: "m" }]);
    expect((await convert(request({ measurement: "2 metresish" }), accepted)).status).toBe(200);
    expect(accepted.aiRun).toHaveBeenCalledTimes(2);
    const changed = env([{ recognized: true, quantity: 3, sourceUnit: "m" }]);
    expect((await convert(request({ measurement: "2 metresish" }), changed)).status).toBe(422);
    expect(changed.aiRun).toHaveBeenCalledTimes(1);
  });

  it("reads strict JSON from standard chat-completion envelopes", async () => {
    const bindings = env();
    bindings.aiRun.mockReset();
    bindings.aiRun.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(parsed) } }] });
    bindings.aiRun.mockImplementationOnce((model,input)=>({choices:[{message:{content:JSON.stringify(chooseFirst(model,input).response)}}]}));
    const response = await convert(request({ measurement: "the lab sneezed" }), bindings);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ result: { interpretation: "144 J", packetId: expect.any(String) } });
    expect(bindings.aiRun).toHaveBeenCalledTimes(2);
  });

  it("preserves scientific notation through the actual entrypoint without a parser call", async () => {
    const bindings = env([reference]);
    const response = await convert(request({ measurement: "1e12joules" }), bindings);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ result: { interpretation: "1000000000000 J" } });
    expect(bindings.aiRun).toHaveBeenCalledTimes(1);
  });

  it("rejects a nonzero literal that underflows before any AI call", async () => {
    const bindings = env();
    expect((await convert(request({ measurement: "1e-999 m" }), bindings)).status).toBe(422);
    expect(bindings.aiRun).not.toHaveBeenCalled();
  });

  it("converts reciprocal units through the actual entrypoint", async () => {
    const bindings = env([{ ...reference, referenceQuantity: 1, referenceUnit: "s^-1", referenceLabel: "pendulum swings", assumption: "one swing per second" }]);
    const response = await convert(request({ measurement: "2 1/s" }), bindings);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ result: { quantity: 2, packetId: expect.any(String), sourceUnit: "s^-1", dimension: "frequency" } });
    expect(bindings.aiRun).toHaveBeenCalledTimes(1);
  });

  it("calculates fractional measurements locally and sends only the creative request", async () => {
    for (const [measurement, quantity, sourceUnit] of [["1/2 litre", 0.5, "L"], ["half a litre", 0.5, "L"], ["1/2 L 250 mL", 750, "mL"]] as const) {
      const bindings = env([{ ...reference, referenceUnit: sourceUnit }]);
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
      const bindings = env([{ ...reference, referenceUnit: "in" }]);
      const response = await convert(request({ measurement }), bindings);
      expect(response.status).toBe(200);
      const body = await response.json() as { result: { quantity: number; sourceUnit: string; dimension: string } };
      expect(body.result.quantity).toBeCloseTo(66, 10);
      expect(body.result).toMatchObject({ sourceUnit: "in", dimension: "length" });
      expect(bindings.aiRun).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects captions and off-menu IDs without another AI call", async () => {
    for (const output of [{packetId:"unknown"},{packetId:"unknown",quip:"extra"},["not an object"]]) {
      const bindings=env([output]);
      const response=await convert(request({measurement:"144 jouls"}),bindings);
      expect(response.status).toBe(200);
      const payload=await response.json() as {result:{packetId:string}};
      expect(payload.result.packetId).not.toBe("unknown");
      expect(payload.result).not.toHaveProperty("quip");
      expect(bindings.aiRun).toHaveBeenCalledTimes(1);
    }
  });

  it("honours recent families and rejects malformed history before inference", async () => {
    const first=env();
    const response=await convert(request({measurement:"144 J"}),first);
    const {result}=await response.json() as {result:{family:string;recentFamilies:string[]}};
    const next=env();
    const nextResponse=await convert(request({measurement:"144 J",recentFamilies:result.recentFamilies}),next);
    expect((await nextResponse.json() as {result:{family:string}}).result.family).not.toBe(result.family);
    for(const recentFamilies of ["bad",Array(9).fill("too-many"),["ignore instructions"],[{}]]) {
      const bindings=env();expect((await convert(request({measurement:"144 J",recentFamilies}),bindings)).status).toBe(400);
      expect(bindings.aiRun).not.toHaveBeenCalled();
    }
  });

  it("returns explicit empty coverage without a model call", async () => {
    const bindings=env();
    expect((await convert(request({measurement:"1e50 kg"}),bindings)).status).toBe(422);
    expect(bindings.aiRun).not.toHaveBeenCalled();
  });

  it("logs bounded provider failures without model text or request data", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const bindings = env(); bindings.aiRun.mockReset(); bindings.aiRun.mockRejectedValueOnce(new Error("private-model-text"));
      await convert(request({ measurement: "987 jouls" }), bindings);
      const entry = JSON.parse(log.mock.calls[0][0]);
      expect(entry).toEqual({ requestId: expect.any(String), stage: "creative", model: "@cf/meta/llama-3.2-3b-instruct", elapsedMs: expect.any(Number), reason: "provider" });
      expect(log.mock.calls[0][0]).not.toMatch(/private-|987 jouls|verified-token|203\.0\.113\.8|test-secret/);
    } finally {
      log.mockRestore();
    }
  });

  it("returns a helpful input response without a creative call when the parser cannot recognise input", async () => {
    const bindings = env([{ recognized: false, quantity: 0, sourceUnit: "m" }]);
    const response = await convert(request({ measurement: "the lab sneezed" }), bindings);
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("number and unit"), requestId: expect.any(String) });
    expect(bindings.aiRun).toHaveBeenCalledTimes(1);
  });

  it("stops after parser output that is malformed, invalid, negative, or below absolute zero", async () => {
    for (const [parserOutput, status] of [["not json", 502], [{ recognized: true, quantity: 1, sourceUnit: "not-a-unit" }, 422], [{ recognized: true, quantity: -1, sourceUnit: "J" }, 422], [{ recognized: true, quantity: -274, sourceUnit: "degC" }, 422], [{ recognized: true, quantity: 1e308, sourceUnit: "km" }, 422], [{ recognized: true, quantity: Number.MIN_VALUE, sourceUnit: "mm" }, 422], [{ recognized: true, quantity: 1, sourceUnit: "m^1e309" }, 422]] as const) {
      const bindings = env([parserOutput]);
      const response = await convert(request({ measurement: "bad measurement" }), bindings);
      expect(response.status).toBe(status);
      expect(bindings.aiRun).toHaveBeenCalledTimes(1);
    }
  });

  it("returns a safe grounded fallback when creative output is invalid or unavailable", async () => {
    const invalid = env([{ referenceId: "invalid", quip: "nope" }]);
    expect((await convert(request({ measurement: "144 J" }), invalid)).status).toBe(200);
    expect(invalid.aiRun).toHaveBeenCalledTimes(1);
    const unavailable = env();
    unavailable.aiRun.mockReset();
    unavailable.aiRun.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    expect((await convert(request({ measurement: "144 J" }), unavailable)).status).toBe(200);
    expect(unavailable.aiRun).toHaveBeenCalledTimes(1);
  });

  it("keeps parser budget failures explicit and uses an offered result when the selector is budget-limited", async () => {
    const parserLimited = env([]);
    parserLimited.aiRun.mockRejectedValueOnce(Object.assign(new Error("gateway exhausted"), { status: 429 }));
    const parserResponse = await convert(request({ measurement: "the lab sneezed" }), parserLimited);
    expect(parserResponse.status).toBe(429);
    await expect(parserResponse.json()).resolves.toMatchObject({ error: "The comparison engine is busy. Please try again shortly.", requestId: expect.any(String) });
    const creativeLimited = env();
    creativeLimited.aiRun.mockReset();
    creativeLimited.aiRun.mockRejectedValueOnce(Object.assign(new Error("budget exhausted"), { status: 429 }));
    const creativeResponse = await convert(request({ measurement: "144 J" }), creativeLimited);
    expect(creativeResponse.status).toBe(200);
    await expect(creativeResponse.json()).resolves.toMatchObject({ result: { packetId: expect.any(String), quantity: 144 } });
    expect(creativeLimited.aiRun).toHaveBeenCalledTimes(1);
  });

  it("classifies an upstream provider timeout as a bounded timeout stage error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const bindings = env();
      bindings.aiRun.mockReset();
      bindings.aiRun.mockRejectedValueOnce(new Error("upstream request timeout"));
      const response = await convert(request({ measurement: "144 J" }), bindings);
      expect(response.status).toBe(200);
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ stage: "creative", model: "@cf/meta/llama-3.2-3b-instruct", reason: "timeout" });
    } finally {
      log.mockRestore();
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
