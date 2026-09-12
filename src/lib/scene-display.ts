import { formatNumber } from "./convert";
import type { ScenePacket } from "./scene-packets";

/** Presentation-only noun aliases for specified catalog objects, never average generic facts. */
const objectNouns: Record<string, string> = {
  "mass-iphone-17": "an iPhone 17",
  "mass-iss": "the International Space Station",
  "mass-us-zinc-penny": "a modern US penny",
  "mass-g502-hero": "a gaming mouse",
  "mass-switch-2": "a Switch 2 with both controllers",
  "mass-bowling-ball-16lb": "a 16-pound bowling ball",
  "mass-parmigiano-wheel": "a wheel of Parmesan",
  "mass-cat-797f-rated-gross": "a mining truck at rated gross weight",
  "mass-eiffel-tower-total": "the Eiffel Tower"
};
const liftLandmarks: Record<string, string> = {
  "length-dippy-replica": "the Dippy replica's head-to-tail length",
  "length-eiffel-current-height": "the Eiffel Tower's overall height (including its antenna)"
};
const applianceNouns: Record<string, string> = {
  "power-apple-adapter": "an Apple 70-watt adapter",
  "power-defined-led": "a 10-watt LED bulb",
  "power-breville-smart-kettle": "a kettle",
  "power-dyson-supersonic": "a hairdryer",
  "power-russell-hobbs-adventure-toaster": "a toaster",
  "power-switch-2-mario-kart": "a docked Switch 2 playing Mario Kart World"
};
const ensemblePlaces: Record<string, string> = {
  "ensemble-wembley-seats": "every Wembley seat",
  "ensemble-a380-certified-seats": "each of an A380's 853 maximum certified passenger places",
  "ensemble-opera-house-concert-hall": "every in-the-round seat in the Sydney Opera House Concert Hall",
  "ensemble-buckingham-palace-rooms": "every Buckingham Palace room",
  "ensemble-london-eye-passenger-places": "each of the London Eye's 800 passenger places"
};
const areaNouns: Record<string, string> = {
  "area-fifa-pitch": "a football pitch",
  "area-fiba-court": "a basketball court",
  "area-brunei": "Brunei",
  "area-us-flag-stamp-2023": "a postage stamp",
  "area-doubles-tennis-court": "a doubles tennis court"
};
const mediaLabels: Record<string, string> = {
  // Exact encoding settings stay in the displayed basis for these specific sources.
  "data-podcast-spotify-96k": "podcast audio",
  "data-stereo-pcm-44100-16": "uncompressed stereo audio",
  "data-prores-422hq-uhd-24p": "4K editing footage",
  "data-ursa-cine-12k-raw3to1-24fps": "12K cinema footage"
};
const payloadLabels: Record<string, string> = {
  "data-defined-ascii-page-2000": "defined 2,000-character ASCII page payloads",
  "data-defined-square-rgb24-image": "uncompressed 4096-by-4096 RGB picture payloads"
};
const massCounts: Record<string, [string, string]> = {
  "mass-g502-hero": ["gaming mouse", "gaming mice"],
  "mass-switch-2": ["Nintendo Switch 2 console", "Nintendo Switch 2 consoles"],
  "mass-parmigiano-wheel": ["Parmesan wheel", "Parmesan wheels"],
  "mass-bowling-ball-16lb": ["16-pound bowling ball", "16-pound bowling balls"]
};
const volumeCounts: Record<string, [string, string]> = {
  "volume-coke-can-330ml": ["Coca-Cola can", "Coca-Cola cans"],
  "volume-schaefer-keg-50l": ["beer keg", "beer kegs"],
  "volume-sterling-spectacle-bath": ["bathtub", "bathtubs"]
};
function noun(table: Record<string, string>, id: string | undefined): string | undefined { return id !== undefined && Object.hasOwn(table, id) ? table[id] : undefined; }
function sentence(text: string): string { return text[0].toUpperCase() + text.slice(1); }
function scaled(value: number, scales: [number, string, string][]): string {
  const [factor, singular, plural] = scales.find(([factor]) => value >= factor) ?? scales[scales.length - 1];
  const text = formatNumber(value / factor);
  return `${text} ${text === "1" ? singular : plural}`;
}
function duration(seconds: number): string {
  return scaled(seconds, [[31557600, "year", "years"], [86400, "day", "days"], [3600, "hour", "hours"], [60, "minute", "minutes"], [1, "second", "seconds"]]);
}
function depth(metres: number): string {
  return scaled(metres, [[0.3048, "foot", "feet"], [0.0254, "inch", "inches"]]);
}

/** Always keep packet.basis available beside this shorter display in product/editorial use. */
export function displayHeadlineForScene(packet: ScenePacket): string {
  const value = packet.computed.value;
  if (!Number.isFinite(value) || value <= 0) return packet.headline;
  const primaryId = packet.sources[0]?.id;
  if (packet.mechanism === "direct" && packet.computed.unit === "ratio") {
    // These aliases name particular catalog variants; their complete configuration
    // stays in the accompanying basis. Round only the text, never the calculation.
    const rounded = Number(value.toPrecision(2));
    const count = formatNumber(rounded);
    const mass = primaryId && Object.hasOwn(massCounts, primaryId) ? massCounts[primaryId] : undefined;
    if (mass) return `About ${count} ${mass[rounded === 1 ? 0 : 1]} by weight`;
    const volume = primaryId && Object.hasOwn(volumeCounts, primaryId) ? volumeCounts[primaryId] : undefined;
    if (volume) return `About ${count} ${volume[rounded === 1 ? 0 : 1]}${rounded === 1 ? "'s" : "'"} worth by volume`;
  }
  if (packet.mechanism === "launch-object" && packet.computed.unit === "m/s") {
    const object = noun(objectNouns, primaryId) ?? packet.sources[0]?.singularLabel;
    if (object) return `Imagine ${object} moving at about ${formatNumber(value / 0.44704)} mph`;
  }
  if (packet.mechanism === "lift-object" && packet.computed.unit === "m") {
    const object = noun(objectNouns, primaryId);
    const landmark = noun(liftLandmarks, packet.sources[1]?.id);
    const ratio = packet.computed.comparisonRatio;
    if (object && landmark && ratio !== undefined && Number.isFinite(ratio) && ratio > 0) {
      return `Lift ${object} straight up by about ${formatNumber(ratio)} times ${landmark}`;
    }
  }
  if (packet.mechanism === "ensemble-appliance" && packet.computed.unit === "s") {
    const place = noun(ensemblePlaces, primaryId);
    const appliance = noun(applianceNouns, packet.sources[1]?.id);
    if (place && appliance) return `${sentence(appliance)} at ${place} for ${duration(value)}`;
  }
  if (packet.mechanism === "flood-area" && packet.computed.unit === "m") {
    const area = noun(areaNouns, primaryId);
    // A volume has no material identity. Do not silently turn arbitrary volume into water.
    if (area) return `A layer ${depth(value)} deep over ${area}`;
  }
  if (packet.mechanism === "media-duration" && packet.computed.unit === "s") {
    const media = noun(mediaLabels, primaryId);
    if (media) return `Storage for about ${duration(value)} of ${media}`;
  }
  if (packet.mechanism === "ensemble-media-duration" && packet.computed.unit === "s") {
    const media = noun(mediaLabels, primaryId);
    const place = noun(ensemblePlaces, packet.sources[1]?.id);
    if (media && place) return `Imagine ${place} with its own ${duration(value)} of ${media}`;
  }
  if (["content-payload-count", "ensemble-content-payload-count"].includes(packet.mechanism) && packet.computed.unit === "payload-equivalents") {
    const payload = noun(payloadLabels, primaryId);
    if (packet.mechanism === "content-payload-count" && payload) return `About ${formatNumber(value)} ${payload}`;
    const place = noun(ensemblePlaces, packet.sources[1]?.id);
    if (payload && place) return `Separate storage for about ${formatNumber(value)} ${payload} at ${place}`;
  }
  return packet.headline;
}

export function withSceneDisplay(packet: ScenePacket): ScenePacket & { displayHeadline: string } {
  return { ...packet, displayHeadline: displayHeadlineForScene(packet) };
}
