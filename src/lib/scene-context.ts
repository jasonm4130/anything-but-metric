import type { ScenePacket } from "./scene-packets";

/** Evaluation-only separation of editorial jobs. Packets remain the source of truth. */
export const sceneContextLimits = { minSelectorPackets: 3, maxSelectorPackets: 6, maxPremiseLength: 160, maxQuipLength: 160 } as const;
export type PremiseSelection = { packet: ScenePacket; premise: string };

export const premiseSelectorPrompt = `You are choosing a comic situation, not writing a joke or doing a conversion.
Choose exactly one of the offered scenes. Prefer a concrete, immediately imaginable situation with a surprising consequence over an obscure reference or a strained setup.
Return exactly {"packetId":"offered ID","premise":"one short fictional situation"}.
The premise is a clearly imagined human situation or motive for the chosen scene. Keep it concise; do not supply a punchline, pun, new number, physical claim, new object measurement, or a different conversion.
The scene headline and assumptions are immutable. Respect all stated qualifications, capacities, average/rated power distinctions, and idealized conditions. Do not imply the fictional installation exists or can operate in practice.
Do not explain your selection. Do not add other fields.`;

export const captionWriterPrompt = `Write one short, natural caption for this one supplied scene and fictional premise.
The conversion and setup are already decided. Your only job is wording the caption. Let the situation carry the humor; a dry human consequence or observation is enough. Do not force a pun or repeat the measurement.
Return exactly {"quip":"your caption"}, at most 160 characters.
Keep the premise fictional. Preserve the scene's stated qualifications and idealizations. Do not add numbers, measurements, physical facts, actual installation claims, or claims that an object survives or an appliance can operate continuously. Do not change, select, or rewrite the scene headline.
Do not explain the caption. Do not add other fields.`;

function checkedPacket(packet: ScenePacket): void {
  if (!packet || typeof packet !== "object" || Array.isArray(packet) || typeof packet.id !== "string" || !packet.id.trim() || typeof packet.headline !== "string" || !packet.headline.trim() || typeof packet.basis !== "string" || !packet.basis.trim()) throw new Error("invalid_scene_context_packet");
}
function checkedSelectionPool(packets: ScenePacket[]): void {
  if (!Array.isArray(packets) || packets.length < sceneContextLimits.minSelectorPackets || packets.length > sceneContextLimits.maxSelectorPackets) throw new Error("invalid_scene_context_pool");
  const ids = new Set<string>();
  for (const packet of packets) {
    checkedPacket(packet);
    if (ids.has(packet.id)) throw new Error("duplicate_scene_context_packet");
    ids.add(packet.id);
  }
}
function editorialScene(packet: ScenePacket) {
  checkedPacket(packet);
  // Preserve the full qualification text. Removing only these code-owned formula
  // suffixes cannot change a physical assumption or a catalog-derived qualifier.
  const assumptions = packet.basis
    .replace(/ Duration = energy \/ power\.$/, "")
    .replace(/ Duration = energy \/ \(fixed count × appliance power\)\.$/, "");
  return { packetId: packet.id, headline: packet.headline, assumptions };
}
function exactObject(response: unknown, keys: string[]): Record<string, unknown> | undefined {
  let parsed = response;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return undefined; }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const prototype = Object.getPrototypeOf(parsed);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const own = Reflect.ownKeys(parsed);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) return undefined;
  return parsed as Record<string, unknown>;
}
function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && value.trim().length > 0;
}

export function premiseSelectorContext(packets: ScenePacket[]): string {
  checkedSelectionPool(packets);
  return JSON.stringify({ scenes: packets.map(editorialScene) });
}
export function premiseSelectionSchema(packets: ScenePacket[]) {
  checkedSelectionPool(packets);
  return {
    type: "object",
    properties: {
      packetId: { type: "string", enum: packets.map(packet => packet.id) },
      premise: { type: "string", minLength: 1, maxLength: sceneContextLimits.maxPremiseLength }
    },
    required: ["packetId", "premise"],
    additionalProperties: false
  };
}
export function parsePremiseSelection(response: unknown, packets: ScenePacket[]): PremiseSelection | undefined {
  checkedSelectionPool(packets);
  const parsed = exactObject(response, ["packetId", "premise"]);
  if (!parsed || typeof parsed.packetId !== "string" || !boundedText(parsed.premise, sceneContextLimits.maxPremiseLength)) return undefined;
  const packet = packets.find(packet => packet.id === parsed.packetId);
  return packet ? { packet, premise: parsed.premise.trim() } : undefined;
}
export function captionWriterContext(selection: PremiseSelection): string {
  if (!selection || !boundedText(selection.premise, sceneContextLimits.maxPremiseLength)) throw new Error("invalid_scene_premise");
  return JSON.stringify({ scene: editorialScene(selection.packet), premise: selection.premise.trim() });
}
export function captionSchema() {
  return { type: "object", properties: { quip: { type: "string", minLength: 1, maxLength: sceneContextLimits.maxQuipLength } }, required: ["quip"], additionalProperties: false };
}
export function parseCaption(response: unknown): { quip: string } | undefined {
  const parsed = exactObject(response, ["quip"]);
  return parsed && boundedText(parsed.quip, sceneContextLimits.maxQuipLength) ? { quip: parsed.quip.trim() } : undefined;
}
