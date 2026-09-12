import { describe, expect, it } from "vitest";
import catalog from "../evals/grounded-references.json";
import additions from "../evals/scene-reference-additions.json";
import anchors from "../evals/scene-scale-anchors.json";
import { buildScenePackets } from "../src/lib/scene-packets";
import { captionSchema, captionWriterContext, parseCaption, parsePremiseSelection, premiseSelectionSchema, premiseSelectorContext } from "../src/lib/scene-context";
const packets = buildScenePackets({ quantity: 1e12, sourceUnit: "J" }, [...catalog, ...additions], { seed: 15, scaleAnchors: anchors }).slice(0, 6);

describe("narrow scene editorial contexts", () => {
  it("offers 3–6 immutable finished headlines with their necessary caveats, without full math or source URLs", () => {
    const input = JSON.parse(premiseSelectorContext(packets));
    expect(input.scenes).toHaveLength(6);
    expect(input.scenes.map((scene: { headline: string }) => scene.headline)).toEqual(packets.map(packet => packet.headline));
    expect(input.scenes.every((scene: object) => Object.keys(scene).join(",") === "packetId,headline,assumptions")).toBe(true);
    expect(premiseSelectorContext(packets)).not.toContain("https://");
    expect(premiseSelectorContext(packets)).not.toContain("operands");
    const ensembleIndex = packets.findIndex(packet => packet.mechanism === "ensemble-appliance");
    expect(ensembleIndex).toBeGreaterThanOrEqual(0);
    expect(input.scenes[ensembleIndex].assumptions).toContain("not a claim that devices can operate continuously");
    for (const source of packets[ensembleIndex].sources) expect(input.scenes[ensembleIndex].assumptions).toContain(source.assumption);
    expect(input.scenes[ensembleIndex].assumptions).not.toContain("Duration =");
    expect(() => premiseSelectorContext(packets.slice(0, 2))).toThrow("invalid_scene_context_pool");
    expect(() => premiseSelectorContext([...packets, packets[0]])).toThrow("invalid_scene_context_pool");
    expect(() => premiseSelectorContext([packets[0], packets[0], packets[1]])).toThrow("duplicate_scene_context_packet");
    expect(premiseSelectionSchema(packets).properties.packetId.enum).toEqual(packets.map(packet => packet.id));
  });

  it("binds a valid premise to the exact offered packet and gives the writer exactly one scene", () => {
    const response = JSON.stringify({ packetId: packets[2].id, premise: "An imagined committee takes its office equipment far too seriously." });
    const selection = parsePremiseSelection(response, packets)!;
    expect(selection.packet).toBe(packets[2]);
    const context = JSON.parse(captionWriterContext(selection));
    expect(Object.keys(context)).toEqual(["scene", "premise"]);
    expect(context.scene.headline).toBe(packets[2].headline);
    expect(context.scene.packetId).toBe(packets[2].id);
    expect(context.premise).toBe(selection.premise);
    expect(captionWriterContext(selection)).not.toContain("https://");
    expect(captionWriterContext(selection)).not.toContain("operands");
    expect(context.scenes).toBeUndefined();
  });

  it("rejects unoffered IDs, arrays, malformed JSON and every extra selector field", () => {
    const valid = { packetId: packets[0].id, premise: "An imagined opening night with unusual equipment." };
    expect(parsePremiseSelection(valid, packets)?.packet).toBe(packets[0]);
    for (const response of [
      { ...valid, packetId: "invented" }, { ...valid, headline: "A rewritten factual claim" }, { ...valid, computed: { value: 9 } },
      { ...valid, quantity: 123 }, { ...valid, sources: [] }, [valid], JSON.stringify([valid]), "```json\n{}\n```", "{broken", null,
      { ...valid, premise: " " }, { ...valid, premise: "x".repeat(161) }, { ...valid, packetId: undefined }
    ]) expect(parsePremiseSelection(response, packets)).toBeUndefined();
    expect(parsePremiseSelection(Object.assign(Object.create({ fact: "inherited" }), valid), packets)).toBeUndefined();
  });

  it("accepts only one bounded caption field and never rescues an overlong caption by truncation", () => {
    expect(parseCaption('{"quip":"The committee has requested a smaller demonstration."}')).toEqual({ quip: "The committee has requested a smaller demonstration." });
    expect(parseCaption({ quip: "x".repeat(160) })?.quip).toHaveLength(160);
    expect(captionSchema().properties.quip.maxLength).toBe(160);
    for (const response of [{ quip: "x".repeat(161) }, { quip: " ".repeat(161) + "OK" }, { quip: " " }, { quip: "Fine.", packetId: packets[0].id }, { quip: "Fine.", headline: "New facts." }, { quip: "Fine.", value: 2 }, [{ quip: "Fine." }], '{"quip":"Fine."} trailing', { quip: 7 }, null]) expect(parseCaption(response)).toBeUndefined();
    expect(() => captionWriterContext({ packet: packets[0], premise: "x".repeat(161) })).toThrow("invalid_scene_premise");
  });
});
