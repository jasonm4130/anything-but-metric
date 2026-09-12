import { unit } from "mathjs";
import { formatNumber, validateMeasurement } from "./convert";
import { validateGroundedCatalog } from "./grounded-flow";
import { sceneLimits, sceneSaliencePolicy, type ScenePacket, type SceneSource } from "./scene-packets";

const speedLabels: Record<string, string> = {
  "speed-bolt-100m": "Usain Bolt's average speed over his record 100 m race",
  "speed-iss": "the International Space Station's orbital speed",
  "speed-light-vacuum": "the speed of light in vacuum"
};
const objectLabels: Record<string, string> = { "mass-g502-hero": "a gaming mouse" };
const sameNumber = (left: number, right: number) => Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 1e-12 * Math.max(Math.abs(left), Math.abs(right));

function speedFacts(catalog: unknown): Array<{ source: SceneSource; speed: number; label: string }> {
  const validated = validateGroundedCatalog(catalog);
  return validated.flatMap((fact, index) => {
    const raw = (catalog as Record<string, unknown>[])[index];
    const measurement = validateMeasurement(fact.referenceQuantity, fact.referenceUnit);
    if (measurement.dimension !== "speed") {
      if (raw.dimension === "speed" || Object.hasOwn(speedLabels, fact.id)) throw new Error("invalid_motion_anchor_dimension");
      return [];
    }
    const speed = unit(fact.referenceQuantity, measurement.sourceUnit).toNumber("m/s");
    if (!Number.isFinite(speed) || speed <= 0) throw new Error("invalid_motion_anchor_speed");
    if (typeof raw.sourceUrl !== "string" || typeof raw.sourceNote !== "string" || !raw.sourceNote.trim()) throw new Error("missing_motion_anchor_provenance");
    try { if (new URL(raw.sourceUrl).protocol !== "https:") throw new Error(); }
    catch { throw new Error("missing_motion_anchor_provenance"); }
    return [{
      speed, label: Object.hasOwn(speedLabels, fact.id) ? speedLabels[fact.id] : fact.referenceLabel,
      source: { id: fact.id, quantity: fact.referenceQuantity, unit: measurement.sourceUnit, assumption: fact.assumption, url: raw.sourceUrl, note: raw.sourceNote }
    }];
  });
}

/** An existing launch packet must still agree with its energy, mass and speed. */
function validMotion(packet: ScenePacket): boolean {
  if (!packet || packet.mechanism !== "launch-object" || packet.computed?.unit !== "m/s") return false;
  const speed = packet.computed.value;
  if (!Number.isFinite(speed) || speed <= 0 || speed > sceneLimits.maxKineticSpeed || speed / 0.44704 < sceneSaliencePolicy.minSpeedMph) return false;
  if (packet.computed.formula !== "sqrt(2 * energy_j / mass_kg)" || typeof packet.basis !== "string" || !packet.basis.trim()) return false;
  if (!Array.isArray(packet.sources) || !packet.sources.length || packet.sources.some(source => !source || typeof source.id !== "string" || !source.id.trim()) || new Set(packet.sources.map(source => source.id)).size !== packet.sources.length) return false;
  const mass = packet.sources[0];
  if (typeof mass.singularLabel !== "string" || !mass.singularLabel.trim() || mass.singularLabel.length > 160) return false;
  try {
    if (validateMeasurement(packet.quantity, packet.sourceUnit).dimension !== "energy" || validateMeasurement(mass.quantity, mass.unit).dimension !== "mass") return false;
    const energy = unit(packet.quantity, packet.sourceUnit).toNumber("J");
    const massKg = unit(mass.quantity, mass.unit).toNumber("kg");
    return energy > 0 && massKg > 0
      && sameNumber(energy, packet.computed.operands.energy_j)
      && sameNumber(massKg, packet.computed.operands.mass_kg)
      && sameNumber(speed, Math.sqrt(2 * (energy / massKg)));
  } catch { return false; }
}

/**
 * Return new two-reference scenes, never replacements or fallbacks.
 * Supply trusted buildScenePackets output, not model-authored or reconstructed packets.
 * Existing mass provenance and basis are preserved, not independently revalidated.
 * Anchor facts have their arithmetic and provenance checked, not their web-page truth.
 * Original motion qualifications remain in every basis.
 */
export function createMotionSceneBuilder(catalog: unknown) {
  const anchors = speedFacts(catalog);
  return (packets: ScenePacket[]): ScenePacket[] => {
  if (!Array.isArray(packets)) throw new Error("invalid_motion_packets");
  const scenes: ScenePacket[] = [];
  const ids = new Set<string>();
  for (const packet of packets) {
    if (!validMotion(packet)) continue;
    for (const anchor of anchors) {
      if (packet.sources.some(source => source.id === anchor.source.id)) continue;
      const ratio = packet.computed.value / anchor.speed;
      if (!Number.isFinite(ratio) || ratio < sceneSaliencePolicy.minRatio || ratio > sceneSaliencePolicy.maxRatio) continue;
      const id = `motion-speed-anchor:${packet.id}+${anchor.source.id}`;
      if (ids.has(id)) throw new Error("duplicate_motion_scene");
      ids.add(id);
      // A caller may supply withSceneDisplay output; its old speed headline is stale here.
      const { displayHeadline: _displayHeadline, ...original } = structuredClone(packet) as ScenePacket & { displayHeadline?: string };
      const object = Object.hasOwn(objectLabels, packet.sources[0].id) ? objectLabels[packet.sources[0].id] : packet.sources[0].singularLabel!.trim();
      const qualification = anchor.source.id === "speed-bolt-100m"
        ? " The reference is Bolt's average over his record 100 m race, not his top speed or an endurance speed. This compares speeds, not numbers of runners or an actual race."
        : " This compares speeds only, not an actual race.";
      scenes.push({
        ...original, id, mechanism: "motion-speed-anchor",
        headline: `Imagine ${object} moving at about ${formatNumber(ratio)} times ${anchor.label}`,
        basis: `${packet.basis} ${anchor.source.assumption}${qualification}`,
        computed: {
          ...original.computed,
          formula: `${packet.computed.formula}; comparison_ratio = moving_speed_m_s / reference_speed_m_s`,
          operands: { ...original.computed.operands, moving_speed_m_s: packet.computed.value, reference_speed_m_s: anchor.speed },
          comparisonRatio: ratio
        },
        sources: [...original.sources, structuredClone(anchor.source)]
      });
    }
  }
  return scenes;
  };
}

export function anchorMotionScenes(packets: ScenePacket[], catalog: unknown): ScenePacket[] {
  return createMotionSceneBuilder(catalog)(packets);
}
