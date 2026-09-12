import { describe, it, expect } from "vitest";
import { comparisonMenu, comparisonPool, comparisonResult, selectedComparison, validRecentFamilies } from "../src/lib/comparison-flow";

describe("production comparison engine", () => {
  it("preserves scalar, range, motion and paper arithmetic in one public answer", () => {
    const energy=comparisonPool({quantity:144,sourceUnit:"J"});
    expect(energy.some(p=>p.mechanism==="launch-object")).toBe(true);
    expect(energy.some(p=>p.mechanism==="kinetic-motion-range")).toBe(true);
    expect(energy.some(p=>p.mechanism==="motion-speed-anchor")).toBe(true);
    const printed=comparisonPool({quantity:2,sourceUnit:"PB"}).find(p=>p.mechanism==="printed-data-stack")!;
    expect(printed.headline).toContain("8.3 Earths");
    const result=comparisonResult(printed,{quantity:2,sourceUnit:"PB"});
    expect(result).toMatchObject({dimension:"data",quantity:2,interpretation:"2 PB"});
    expect(result.basis).toContain("±3");
    expect(result.sources).toHaveLength(3);
    const rabbit=energy.find(p=>p.id.includes("kinetic-motion-range:animal-domestic-rabbit"))!;
    expect(rabbit.headline).toContain("17–40 mph");
    expect(rabbit.basis).toContain("no midpoint");
    expect(rabbit.assumption.length).toBeLessThan(rabbit.basis.length);
  });

  it("returns varied deterministic menus for seeds and avoids recent source families", () => {
    const measurement={quantity:144,sourceUnit:"J"};
    expect(comparisonMenu(measurement,[],1)).toEqual(comparisonMenu(measurement,[],1));
    const first=comparisonMenu(measurement,[],1)[0];
    const next=comparisonMenu(measurement,first.families,2);
    expect(next.length).toBeGreaterThan(0);
    expect(next.every(p=>p.families.every(f=>!first.families.includes(f)))).toBe(true);
    const selections=new Set<string>();let history:string[]=[];
    for(let seed=0;seed<12;seed++) {
      const menu=comparisonMenu(measurement,history,seed);expect(menu.length).toBeLessThanOrEqual(6);
      expect(new Set(menu.map(p=>p.id)).size).toBe(menu.length);
      const chosen=menu[0];selections.add(chosen.id);history=comparisonResult(chosen,measurement,history).recentFamilies;
      expect(history.length).toBeLessThanOrEqual(8);
    }
    expect(selections.size).toBeGreaterThanOrEqual(8);
  });

  it("does not relabel measured appliance averages as rated power", () => {
    const scene=comparisonPool({quantity:1e9,sourceUnit:"J"}).find(p=>p.mechanism==="ensemble-appliance"&&p.id.includes("power-switch-2-mario-kart"))!;
    expect(scene.basis).toContain("19 W");
    expect(scene.assumption).toContain("stated constant power");
    expect(scene.assumption).not.toContain("rated");
  });

  it("uses exact offered IDs and never accepts extra model content", () => {
    const menu=comparisonMenu({quantity:42,sourceUnit:"kg"});
    expect(selectedComparison({packetId:menu[0].id},menu)).toBe(menu[0]);
    for(const output of [{packetId:"invented"},{packetId:menu[0].id,headline:"invented"},{packetId:menu[0].id,quantity:0},null,[],"{}"])expect(selectedComparison(output,menu)).toBeUndefined();
  });

  it("preserves zero and absolute temperature semantics without meaningless ratios", () => {
    const zero=comparisonMenu({quantity:0,sourceUnit:"kg"});expect(zero.length).toBeGreaterThan(0);
    const cold=comparisonMenu({quantity:-10,sourceUnit:"degC"});expect(cold.length).toBeGreaterThan(0);
    expect(cold.every(p=>/temperature|cooler|warmer/.test(p.headline))).toBe(true);
    expect(comparisonMenu({quantity:1e50,sourceUnit:"kg"})).toEqual([]);
    expect(()=>comparisonMenu({quantity:-274,sourceUnit:"degC"})).toThrow();
  });

  it("validates client history and retains full source evidence with safe links", () => {
    expect(validRecentFamilies(undefined)).toEqual([]);
    expect(validRecentFamilies(["paper","space-station"])).toEqual(["paper","space-station"]);
    for(const history of [null,"paper",[123],Array(9).fill("paper"),["x".repeat(81)],["<script>"]])expect(validRecentFamilies(history)).toBeUndefined();
    for(const packet of comparisonPool({quantity:144,sourceUnit:"J"})) {
      expect(packet.headline.length).toBeGreaterThan(0);expect(packet.basis.length).toBeGreaterThan(0);
      for(const source of packet.sources)expect(new URL(source.url).protocol).toBe("https:");
    }
  });
});
