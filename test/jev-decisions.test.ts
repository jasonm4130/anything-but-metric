import { describe, expect, it } from "vitest";
import { bandCheckQuestion, bandCount, bandVerdict, choiceAnswer, decisionsRequest, noulProbability, pickQuestion, refusalQuestion } from "../src/lib/jev-decisions";

const subject = { thing: "double-decker bus", dimension: "mass", value: 12, unit: "tonne" };

describe("Jev decisions", () => {
  it("builds seven contiguous half-decade bands with the proposal at the requested position", () => {
    for (let position = 0; position < bandCount; position++) {
      const check = bandCheckQuestion(subject, position);
      expect(check.bands).toHaveLength(bandCount);
      expect(check.proposedKey).toBe(`band_${position + 1}`);
      const proposed = check.bands[position];
      expect(proposed.low).toBeLessThanOrEqual(12);
      expect(proposed.high).toBeGreaterThan(12);
      for (let index = 1; index < bandCount; index++) expect(check.bands[index].low).toBeCloseTo(check.bands[index - 1].high, 9);
      expect(Object.keys(check.question.criteria as Record<string, string>)).toHaveLength(bandCount);
    }
    expect(() => bandCheckQuestion(subject, 7)).toThrow(RangeError);
    expect(() => bandCheckQuestion({ ...subject, value: 0 }, 3)).toThrow(RangeError);
  });

  it("accepts a value only when Jev's band is the proposal's band with enough probability", () => {
    const check = bandCheckQuestion(subject, 2);
    const response = { answers: { size: { choice: "band_3", confidence: 0.7, probabilities: { band_2: 0.2, band_3: 0.7, band_4: 0.1 } } } };
    expect(bandVerdict(check, choiceAnswer(response, "size"), 0.5)).toMatchObject({ accepted: true, probability: 0.7, bandDistance: 0 });
    expect(bandVerdict(check, choiceAnswer(response, "size"), 0.8).accepted).toBe(false);
    const elsewhere = { answers: { size: { choice: "band_5", probabilities: { band_5: 0.9, band_3: 0.05 } } } };
    expect(bandVerdict(check, choiceAnswer(elsewhere, "size"), 0.3)).toMatchObject({ accepted: false, bandDistance: 2 });
    expect(bandVerdict(check, undefined, 0.3).accepted).toBe(false);
  });

  it("reads answers defensively", () => {
    expect(choiceAnswer({ answers: { pick: { probabilities: { a: 0.2, b: 0.8 } } } }, "pick")?.choice).toBe("b");
    expect(choiceAnswer({ answers: {} }, "pick")).toBeUndefined();
    expect(choiceAnswer("nonsense", "pick")).toBeUndefined();
    expect(noulProbability({ answers: { refusal: { probability: 0.12 } } }, "refusal")).toBe(0.12);
    expect(noulProbability({ answers: { refusal: 0.3 } }, "refusal")).toBe(0.3);
    expect(noulProbability({ answers: { refusal: { probabilities: { true: 0.4, false: 0.6 } } } }, "refusal")).toBe(0.4);
    expect(noulProbability({}, "refusal")).toBeUndefined();
  });

  it("builds typed questions and requests within the API's limits", () => {
    expect(refusalQuestion().type).toBe("noul");
    expect(() => pickQuestion([])).toThrow(RangeError);
    expect(() => pickQuestion(Array.from({ length: 256 }, (_, index) => ({ id: `c${index}`, description: "x" })))).toThrow(RangeError);
    expect(decisionsRequest({ measurement: "40 t" }, { pick: pickQuestion([{ id: "bus", description: "buses" }]) })).toMatchObject({ model: "typesafe/jev-1.13", questions: { pick: { type: "choice" } } });
  });
});
