import * as THREE from "three";

// Keyed by stops rather than a single slot: the two themes want different
// gradients (emitted light at night, absorbed ink by day) and both scenes may
// be alive across a theme switch.
const fireflyMaps = new Map<string, THREE.Texture>();
export function fireflyTexture(stops: readonly [string, string, string]): THREE.Texture {
  const key = stops.join("|");
  const cached = fireflyMaps.get(key);
  if (cached) return cached;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, stops[0]);
  g.addColorStop(0.25, stops[1]);
  g.addColorStop(1, stops[2]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.userData.shared = true; // module cache: disposeGroup must not free it
  fireflyMaps.set(key, texture);
  return texture;
}

let haloMap: THREE.Texture | null = null;
export function haloTexture(): THREE.Texture {
  if (haloMap) return haloMap;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.4, "rgba(255,255,255,0.28)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  haloMap = new THREE.CanvasTexture(canvas);
  haloMap.userData.shared = true; // module cache: disposeGroup must not free it
  return haloMap;
}

// In-scene directory labels. The face is T3's `--font-sans` restated as a
// canvas font string — mindwalk asked for Schibsted Grotesk, which this app
// does not ship, so these were silently rendering in a generic fallback.
export function labelTexture(
  text: string,
  ink: string,
): { texture: THREE.Texture; aspect: number } {
  const font = '500 30px "DM Sans Variable", "DM Sans", system-ui, sans-serif';
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = font;
  const width = Math.ceil(measure.measureText(text).width) + 24;
  const height = 44;
  const canvas = document.createElement("canvas");
  canvas.width = width * 2;
  canvas.height = height * 2;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(2, 2);
  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillStyle = ink;
  ctx.fillText(text, width / 2, height / 2 + 1);
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  return { texture, aspect: width / height };
}
