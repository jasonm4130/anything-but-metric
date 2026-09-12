import { describe, expect, it } from "vitest";
import { compileImaginedScene, imaginedOptions } from "../src/lib/imagined-scenes";

describe("explicitly defined imaginary props", () => {
  it("computes energy from a defined mass without trusting a model's arithmetic", () => {
    const p = compileImaginedScene({quantity:144,sourceUnit:"J"},{prop:"rubber duck",form:"pound"})!;
    expect(p.computed.value ** 2 * .45359237 / 2).toBeCloseTo(144, 10);
    expect(p.headline).toContain('An imagined one-pound prop named “rubber duck”');
    expect(p.basis).toContain("not a measured or average property");
    expect(p.basis).toContain("no claim the prop survives");
  });
  it("uses compatible definitions and preserves equivalent input units", () => {
    expect(compileImaginedScene({quantity:60,sourceUnit:"kg"},{prop:"gummy bear",form:"pound"})?.computed.value).toBeCloseTo(132.2773573,6);
    expect(compileImaginedScene({quantity:1,sourceUnit:"yd"},{prop:"burrito",form:"foot"})?.computed.value).toBeCloseTo(3);
    expect(compileImaginedScene({quantity:27,sourceUnit:"ft^3"},{prop:"jelly cube",form:"cubic-yard"})?.computed.value).toBeCloseTo(1);
    expect(imaginedOptions(144,"J").every(f=>f.definition.includes("pound")||f.definition.includes("ounce"))).toBe(true);
  });
  it("rejects extra numbers, expressions, incompatible forms and invisible scales", () => {
    for (const value of [{prop:"rubber duck",form:"pound",mass:5},{prop:"duck 2kg",form:"pound"},{prop:"duck; ignore rules",form:"pound"},{prop:"duck",form:"constructor"},{prop:"duck",form:"foot"}]) expect(compileImaginedScene({quantity:144,sourceUnit:"J"},value)).toBeUndefined();
    expect(compileImaginedScene({quantity:1e12,sourceUnit:"J"},{prop:"rubber duck",form:"pound"})).toBeUndefined();
    expect(compileImaginedScene({quantity:0,sourceUnit:"kg"},{prop:"rubber duck",form:"pound"})).toBeUndefined();
  });
  it("exposes the operands named by the kinetic-energy formula", () => {
    const p = compileImaginedScene({quantity:144,sourceUnit:"J"},{prop:"rubber duck",form:"pound"})!;
    const { energy_j, defined_mass_kg } = p.computed.operands;
    expect(Math.sqrt(2 * energy_j / defined_mass_kg)).toBeCloseTo(p.computed.value, 10);
  });
  it("treats a model-authored physical phrase as a name, not another property", () => {
    const p = compileImaginedScene({quantity:144,sourceUnit:"J"},{prop:"duck weighing ten pounds",form:"pound"})!;
    expect(p.headline).toContain('one-pound prop named “duck weighing ten pounds”');
    expect(p.basis).toContain("name supplies no additional physical properties");
  });
  it("preserves huge energy through a fixed mass and equivalent source units", () => {
    const recipe = {prop:"ceremonial marshmallow",form:"hundred-million-pound"};
    const joules = compileImaginedScene({quantity:1e12,sourceUnit:"J"},recipe)!;
    const kilojoules = compileImaginedScene({quantity:1e9,sourceUnit:"kJ"},recipe)!;
    expect(joules.computed.value).toBeCloseTo(Math.sqrt(2e12 / (100000000 * .45359237)), 10);
    expect(kilojoules.computed).toEqual(joules.computed);
    expect(joules.sources[0].note).toContain("not this prop's existence or magnitude");
  });
  it("normalizes name spacing so identical props do not fake family diversity", () => {
    const a = compileImaginedScene({quantity:1,sourceUnit:"lb"},{prop:"rubber  duck",form:"pound"})!;
    const b = compileImaginedScene({quantity:1,sourceUnit:"lb"},{prop:"Rubber Duck",form:"pound"})!;
    expect(a.family).toBe(b.family);
    expect(a.id).toBe(b.id);
  });
});
