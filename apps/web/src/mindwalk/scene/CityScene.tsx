import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { touchWord, type CityFile, type CityMap, type Touch } from "../types";
import type { FilePlayback } from "../playback/reducer";
import type { ScenePalette } from "../palette";
import { DirLabelSet } from "./dirLabels";
import {
  disposeGroup,
  ensureVisible,
  fitDistance,
  prefersReducedMotion,
  SceneTip,
  touchColorsFor,
} from "./sceneUtils";
import { ATTRACT_DRIFT_MS, FrameLoop } from "./frameLoop";
import { fireflyTexture } from "./textures";
import { TrailRenderer } from "./trail";

interface CitySceneProps {
  city?: CityMap;
  playback: FilePlayback;
  selectedPath?: string;
  onSelect: (path?: string) => void;
  onCanvasReady?: (canvas: HTMLCanvasElement | null) => void;
  // static map mode: with no session to drive attention height, raise terrain
  // columns by file size (lines of code) instead of leaving the plain flat
  locHeights?: boolean;
  // the scrubber is playing: the one state that earns a continuous frame loop
  playing?: boolean;
  /** Colours the stage renders in. Resolved by the surface, not derived
   * here, so both scenes and the chrome around them agree — including the
   * sky, which is read from T3's own `--background`. */
  palette: ScenePalette;
}

// Attention terrain: the map is a flat plain (fog of war); height is earned by
// attention — touch depth × revisits — so mountains grow where the walker
// lingered. One channel carries the state: at night only touched terrain gets
// bright color, by day only touched terrain gets saturated ink.
type SceneColors = Record<Touch | "unvisited" | "ghost" | "selected", THREE.Color>;

function sceneColors(palette: ScenePalette): SceneColors {
  return {
    unvisited: new THREE.Color(palette.city.unvisited),
    ghost: new THREE.Color(palette.city.ghost),
    ...touchColorsFor(palette),
  };
}

const TILE_H = 0.14;
const LABEL_Y = 2.4;
// the inspector docks on the right; selection pans the camera clear of it
const INSPECTOR_RESERVED_PX = 348;

function attentionHeight(touch: Touch, visits: number): number {
  const base = touch === "edit" ? 7.2 : touch === "read" ? 4.2 : 1.6;
  return base * (1 + 0.35 * Math.log2(Math.max(visits, 1)));
}

// static map height: normalized lines of code, log-scaled so a few huge files
// don't flatten everything else. maxLog is log2(largest file's lines).
const LOC_MIN_H = 0.3;
const LOC_MAX_H = 16;
// gamma > 1 exaggerates the top end: small files stay low, big files spike, so
// the skyline reads as a city (towers vs shacks) instead of a uniform plateau
const LOC_HEIGHT_GAMMA = 2.2;
// normalized 0..1 position of a file by lines of code (log-scaled)
function locFraction(lines: number, maxLog: number): number {
  if (maxLog <= 0) return 0;
  return Math.min(1, Math.log2(Math.max(lines, 1)) / maxLog);
}
function locHeight(t: number): number {
  return LOC_MIN_H + Math.pow(t, LOC_HEIGHT_GAMMA) * (LOC_MAX_H - LOC_MIN_H);
}

// LOC tier ramp: small files stay grey, then warm up through orange and purple
// to red for the largest files. Stops are interpolated so the terrain reads as
// a continuous gradient rather than hard bands. Positions are fixed; the four
// colors come from the palette (grey stop always matches `unvisited`).
const LOC_RAMP_STOPS = [0.0, 0.35, 0.7, 1.0] as const;
type LocRamp = { at: number; color: THREE.Color }[];

function locRampFor(palette: ScenePalette): LocRamp {
  return LOC_RAMP_STOPS.map((at, i) => ({ at, color: new THREE.Color(palette.city.locRamp[i]!) }));
}

function locColor(t: number, ramp: LocRamp): THREE.Color {
  for (let i = 1; i < ramp.length; i++) {
    if (t <= ramp[i]!.at) {
      const lo = ramp[i - 1]!;
      const hi = ramp[i]!;
      const span = hi.at - lo.at;
      const k = span > 0 ? (t - lo.at) / span : 0;
      return lo.color.clone().lerp(hi.color, k);
    }
  }
  return ramp[ramp.length - 1]!.color.clone();
}

interface TerrainSlot {
  fileId: number;
  target: number;
  color: THREE.Color;
}

export function CityScene({
  city,
  playback,
  selectedPath,
  onSelect,
  onCanvasReady,
  locHeights,
  playing = false,
  palette,
}: CitySceneProps) {
  // A palette switch rebuilds the stage rather than mutating every material in
  // place: it happens once in a blue moon, and the alternative is a second
  // code path that has to stay in step with scene construction forever.
  const colors = useMemo(() => sceneColors(palette), [palette]);
  const locRamp = useMemo(() => locRampFor(palette), [palette]);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const tileMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const terrainMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const filesRef = useRef<CityFile[]>([]);
  const slotsRef = useRef<TerrainSlot[]>([]);
  const heightsRef = useRef<Map<number, number>>(new Map());
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cityGroupRef = useRef<THREE.Group | null>(null);
  const trailRef = useRef<TrailRenderer | null>(null);
  const fireflyRef = useRef<THREE.Sprite | null>(null);
  const labelSetRef = useRef<DirLabelSet | null>(null);
  const loopRef = useRef<FrameLoop | null>(null);
  const reducedRef = useRef(false);
  const boundsRef = useRef({ cx: 0, cz: 0, size: 120 });
  // the render loop no longer rewrites every column matrix each frame, so a
  // slot table swap that lands with every height already settled has to say so
  const terrainDirtyRef = useRef(false);
  // handlers live in the mount effect; they read playback through this ref
  const playbackRef = useRef(playback);
  playbackRef.current = playback;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  // camera fit deferred while the viewport reports no size (hidden pane,
  // background tab); resize retries it instead of leaving the camera at NaN
  const fitPendingRef = useRef<(() => boolean) | null>(null);
  /** the live fit, so the resize handler in the other effect can re-run it */
  const fitViewRef = useRef<(() => boolean) | null>(null);

  const bounds = useMemo(() => {
    if (!city || city.files.length === 0) return { cx: 0, cz: 0, size: 120, halfW: 60, halfD: 60 };
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const file of city.files) {
      minX = Math.min(minX, file.rect.x);
      maxX = Math.max(maxX, file.rect.x + file.rect.w);
      minZ = Math.min(minZ, file.rect.z);
      maxZ = Math.max(maxZ, file.rect.z + file.rect.d);
    }
    return {
      cx: (minX + maxX) / 2,
      cz: (minZ + maxZ) / 2,
      size: Math.max(maxX - minX, maxZ - minZ, 60),
      halfW: (maxX - minX) / 2,
      halfD: (maxZ - minZ) / 2,
    };
  }, [city]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const reduced = prefersReducedMotion();
    reducedRef.current = reduced;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(palette.sky);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      38,
      host.clientWidth / host.clientHeight || 0,
      0.1,
      2400,
    );
    camera.position.set(70, 130, 100);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    rendererRef.current = renderer;
    host.appendChild(renderer.domElement);
    onCanvasReady?.(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !reduced;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.44;
    // mindwalk drifts the god view slowly around the terrain until the user takes
    // over. Perpetual drift on a parked, visible view is the case AGENTS.md
    // names, so it is bounded rather than dropped: the arrival motion still
    // plays, and stops at whichever comes first — the first interaction, which
    // is mindwalk's own rule, or ATTRACT_DRIFT_MS. Reduced-motion users get no
    // drift at all, as upstream.
    controls.autoRotate = !reduced;
    controls.autoRotateSpeed = -0.5;
    let driftTimer: ReturnType<typeof setTimeout> | null = null;
    const stopDrift = () => {
      controls.autoRotate = false;
      if (driftTimer !== null) {
        clearTimeout(driftTimer);
        driftTimer = null;
      }
    };
    if (!reduced) driftTimer = setTimeout(stopDrift, ATTRACT_DRIFT_MS);
    const tip = new SceneTip(host);
    let userTookCamera = false;
    controls.addEventListener("start", () => {
      userTookCamera = true;
      stopDrift();
      tip.hide();
    });
    controlsRef.current = controls;

    const sky = new THREE.HemisphereLight(
      palette.light.hemiSky,
      palette.light.hemiGround,
      palette.light.hemiIntensity,
    );
    scene.add(sky);
    const moon = new THREE.DirectionalLight(palette.light.sunColor, palette.light.sunIntensity);
    moon.position.set(-60, 120, -40);
    scene.add(moon);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const pickFile = (event: PointerEvent): CityFile | undefined => {
      if (!cameraRef.current || !rendererRef.current) return undefined;
      const rect = rendererRef.current.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, cameraRef.current);
      const targets = [terrainMeshRef.current, tileMeshRef.current].filter(
        Boolean,
      ) as THREE.Object3D[];
      const hit = raycaster.intersectObjects(targets, false)[0];
      if (!hit || hit.instanceId === undefined) return undefined;
      if (hit.object === terrainMeshRef.current) {
        const slot = slotsRef.current[hit.instanceId];
        return slot ? filesRef.current[slot.fileId] : undefined;
      }
      return filesRef.current[hit.instanceId];
    };

    let downAt: { x: number; y: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      downAt = { x: event.clientX, y: event.clientY };
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!downAt) return;
      const moved = Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y);
      downAt = null;
      if (moved > 5) return;
      onSelect(pickFile(event)?.path);
    };
    // hover: cursor + one-line readout, throttled to one raycast per frame
    let hoverRaf = 0;
    const onPointerMove = (event: PointerEvent) => {
      if (downAt) {
        tip.hide();
        return;
      }
      if (hoverRaf) return;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        const file = pickFile(event);
        renderer.domElement.style.cursor = file ? "pointer" : "";
        if (!file) {
          tip.hide();
          return;
        }
        const snapshot = playbackRef.current;
        const touch = snapshot.touchByPath.get(file.path);
        const visits = snapshot.visitsByFile.get(file.id) ?? 0;
        const meta = touch
          ? `${touchWord(touch)} · ${visits} visit${visits === 1 ? "" : "s"}`
          : touchWord(undefined);
        tip.show(file.path, file.ghost ? `${meta} · ghost` : meta, event.clientX, event.clientY);
      });
    };
    const onPointerLeave = () => {
      tip.hide();
      renderer.domElement.style.cursor = "";
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerleave", onPointerLeave);

    const resize = () => {
      if (!hostRef.current) return;
      const w = hostRef.current.clientWidth;
      const h = hostRef.current.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (fitPendingRef.current?.()) fitPendingRef.current = null;
      // A fit is only correct for the size it was computed at. The scene can
      // mount at a transient size — an inactive surface tab is zero-sized, and
      // `|| 0` above defers that case — but any later reflow invalidates the
      // framing just as much. Refit until the user takes the camera, after
      // which it is theirs and a resize must not yank it back.
      else if (!userTookCamera) fitViewRef.current?.();
      loopRef.current?.invalidate();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    const clock = new THREE.Clock();
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    // one frame; returns whether an animation is still in flight, which is the
    // only thing that books the next one (see FrameLoop)
    const drawFrame = (): boolean => {
      const cameraMoved = controls.update();
      labelSetRef.current?.updateTargets(
        camera,
        renderer.domElement.clientWidth,
        renderer.domElement.clientHeight,
      );
      const labelsEasing = labelSetRef.current?.ease(reducedRef.current) ?? false;

      // grow / shrink terrain columns toward their attention targets
      const terrain = terrainMeshRef.current;
      const slots = slotsRef.current;
      const heights = heightsRef.current;
      let terrainMoving = false;
      if (terrain && slots.length > 0) {
        let moving = false;
        for (let i = 0; i < slots.length; i++) {
          const slot = slots[i]!;
          const file = filesRef.current[slot.fileId];
          if (!file) continue;
          let cur = heights.get(slot.fileId) ?? 0;
          const diff = slot.target - cur;
          if (Math.abs(diff) > 0.015) {
            cur = reducedRef.current ? slot.target : cur + diff * 0.13;
            heights.set(slot.fileId, cur);
            moving = true;
          } else if (cur !== slot.target) {
            heights.set(slot.fileId, slot.target);
            cur = slot.target;
            moving = true;
          }
          const sx = Math.max(file.rect.w, 0.45) + 0.04;
          const sz = Math.max(file.rect.d, 0.45) + 0.04;
          matrix.compose(
            new THREE.Vector3(
              file.rect.x + file.rect.w / 2 - boundsRef.current.cx,
              Math.max(cur, 0.02) / 2 + TILE_H,
              file.rect.z + file.rect.d / 2 - boundsRef.current.cz,
            ),
            quaternion,
            new THREE.Vector3(sx, Math.max(cur, 0.02), sz),
          );
          terrain.setMatrixAt(i, matrix);
        }
        if (moving || terrainDirtyRef.current) terrain.instanceMatrix.needsUpdate = true;
        terrainDirtyRef.current = false;
        terrainMoving = moving;
      }

      // the firefly's breathing pulse is unbounded, so it lives under the
      // playback exception and settles to its base scale when the walk stops
      const playbackRunning = playingRef.current;
      const firefly = fireflyRef.current;
      if (firefly?.visible) {
        const base = firefly.userData.baseScale as number;
        const pulse =
          playbackRunning && !reducedRef.current
            ? 1 + 0.1 * Math.sin(clock.getElapsedTime() * 2.4)
            : 1;
        firefly.scale.setScalar(base * pulse);
      }
      renderer.render(scene, camera);
      return cameraMoved || labelsEasing || terrainMoving || playbackRunning;
    };

    const loop = new FrameLoop(host, drawFrame);
    loopRef.current = loop;
    // OrbitControls dispatches `change` from its own pointer/wheel/key
    // handlers and from every external `controls.update()` (fitView,
    // ensureVisible), so this covers camera motion the loop did not cause
    controls.addEventListener("change", () => loop.invalidate());

    return () => {
      stopDrift();
      loop.dispose();
      loopRef.current = null;
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
      tip.dispose();
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      scene.clear();
      onCanvasReady?.(null);
    };
  }, [onSelect, onCanvasReady, palette]);

  // build the plain: ground, grid, district plates, flat file tiles
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    filesRef.current = city?.files ?? [];
    slotsRef.current = [];
    heightsRef.current = new Map();
    boundsRef.current = bounds;
    terrainDirtyRef.current = true;
    loopRef.current?.invalidate();
    if (!city || city.files.length === 0) return;

    const group = new THREE.Group();
    const size = bounds.size;

    scene.fog = new THREE.Fog(new THREE.Color(palette.sky), size * 2.1, size * 4.2);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size * 6, size * 6),
      new THREE.MeshStandardMaterial({ color: palette.ground, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.32;
    group.add(ground);

    const grid = new THREE.GridHelper(size * 2.8, 46, palette.gridMajor, palette.gridMinor);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    grid.position.y = -0.3;
    group.add(grid);

    const plateDirs = city.dirs.filter((dir) => dir.depth <= 3 && dir.rect.w > 0 && dir.rect.d > 0);
    if (plateDirs.length > 0) {
      const plateGeo = new THREE.BoxGeometry(1, 1, 1);
      const plateMat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
      const plates = new THREE.InstancedMesh(plateGeo, plateMat, plateDirs.length);
      const matrix = new THREE.Matrix4();
      const shade = new THREE.Color();
      plateDirs.forEach((dir, i) => {
        const top = -0.2 + Math.min(dir.depth, 3) * 0.06;
        const height = top + 0.3;
        matrix.compose(
          new THREE.Vector3(
            dir.rect.x + dir.rect.w / 2 - bounds.cx,
            top - height / 2,
            dir.rect.z + dir.rect.d / 2 - bounds.cz,
          ),
          new THREE.Quaternion(),
          new THREE.Vector3(dir.rect.w, height, dir.rect.d),
        );
        plates.setMatrixAt(i, matrix);
        shade
          .set(palette.city.dirShadeNear)
          .lerp(new THREE.Color(palette.city.dirShadeFar), Math.min(dir.depth, 3) / 3);
        plates.setColorAt(i, shade);
      });
      plates.instanceMatrix.needsUpdate = true;
      if (plates.instanceColor) plates.instanceColor.needsUpdate = true;
      group.add(plates);
    }

    // flat tiles: every file exists on the map, dark until visited
    const tileGeo = new THREE.BoxGeometry(1, 1, 1);
    const tileMat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
    const tiles = new THREE.InstancedMesh(tileGeo, tileMat, city.files.length);
    const matrix = new THREE.Matrix4();
    for (const file of city.files) {
      const sx = Math.max(file.rect.w, 0.45);
      const sz = Math.max(file.rect.d, 0.45);
      const x = file.rect.x + file.rect.w / 2 - bounds.cx;
      const z = file.rect.z + file.rect.d / 2 - bounds.cz;
      matrix.compose(
        new THREE.Vector3(x, TILE_H / 2, z),
        new THREE.Quaternion(),
        new THREE.Vector3(sx, TILE_H, sz),
      );
      tiles.setMatrixAt(file.id, matrix);
      tiles.setColorAt(file.id, baseColor(file, colors));
    }
    tiles.instanceMatrix.needsUpdate = true;
    if (tiles.instanceColor) tiles.instanceColor.needsUpdate = true;
    tileMeshRef.current = tiles;
    group.add(tiles);

    // attention terrain: unlit columns that grow out of the plain
    const terrain = new THREE.InstancedMesh(
      attentionColumnGeometry(palette.columnShade),
      new THREE.MeshBasicMaterial({ toneMapped: false, vertexColors: true }),
      city.files.length,
    );
    terrain.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(city.files.length * 3),
      3,
    );
    terrain.count = 0;
    terrain.frustumCulled = false;
    terrainMeshRef.current = terrain;
    group.add(terrain);

    // district labels above the plain; drawn over the columns so a mountain
    // range never buries the name of the district behind it
    labelSetRef.current = new DirLabelSet(
      city.dirs
        .filter((dir) => dir.depth >= 1 && dir.fileCount > 0 && dir.rect.w > 0 && dir.rect.d > 0)
        .map((dir) => ({
          name: dirBasename(dir.path),
          x: dir.rect.x + dir.rect.w / 2 - bounds.cx,
          z: dir.rect.z + dir.rect.d / 2 - bounds.cz,
          radius: Math.hypot(dir.rect.w, dir.rect.d) / 2,
          fileCount: dir.fileCount,
          depth: dir.depth,
        })),
      group,
      LABEL_Y,
      palette.labelInk,
      true,
    );

    const firefly = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: fireflyTexture(palette.fireflyStops),
        color: new THREE.Color(palette.ember),
        blending: palette.glowBlending,
        depthWrite: false,
        transparent: true,
      }),
    );
    firefly.userData.baseScale = Math.max(size * 0.028, 2.2);
    firefly.visible = false;
    fireflyRef.current = firefly;
    group.add(firefly);

    const trail = new TrailRenderer(1.4, palette);
    trailRef.current = trail;
    group.add(trail.object);

    cityGroupRef.current = group;
    scene.add(group);

    // keep the canonical viewing direction, but pull back exactly far
    // enough that the whole plain fits the viewport's frustum — the fixed
    // size multiplier ignores the aspect ratio and overflows short windows
    const fitView = (): boolean => {
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (!camera || !controls) return true;
      const dir = new THREE.Vector3(0.46, 1.08, 0.72).normalize();
      const corners: THREE.Vector3[] = [];
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          corners.push(new THREE.Vector3(sx * bounds.halfW, 0, sz * bounds.halfD));
        }
      }
      const fitted = fitDistance(camera, dir, corners);
      if (fitted === null) return false;
      // breathing room so map edges clear the HUD overlays; floor keeps
      // near-empty maps from parking the camera on the ground
      const distance = Math.max(fitted * 1.12, size * 0.6);
      camera.position.copy(dir).multiplyScalar(distance);
      controls.target.set(0, 0, 0);
      controls.minDistance = size * 0.18;
      controls.maxDistance = Math.max(size * 2.6, distance * 1.2);
      controls.update();
      return true;
    };
    fitViewRef.current = fitView;
    fitPendingRef.current = fitView() ? null : fitView;

    return () => {
      fitPendingRef.current = null;
      fitViewRef.current = null;
      loopRef.current?.invalidate();
      disposeGroup(group);
      scene.remove(group);
      cityGroupRef.current = null;
      tileMeshRef.current = null;
      terrainMeshRef.current = null;
      trailRef.current = null;
      fireflyRef.current = null;
      labelSetRef.current = null;
    };
  }, [city, bounds, palette, colors]);

  // playback → terrain targets and colors
  useEffect(() => {
    const terrain = terrainMeshRef.current;
    const tiles = tileMeshRef.current;
    if (!terrain || !tiles || !city) return;

    const heights = heightsRef.current;
    const slots: TerrainSlot[] = [];
    const present = new Set<number>();
    // static map mode: no session drives attention, so raise every column by
    // its lines of code instead of leaving the terrain flat
    const maxLog = locHeights
      ? Math.log2(
          Math.max(
            1,
            city.files.reduce((m, f) => Math.max(m, f.lines), 1),
          ),
        )
      : 0;
    for (const file of city.files) {
      const touch = playback.touchByFile.get(file.id);
      const selected = file.path === selectedPath;
      tiles.setColorAt(file.id, selected ? colors.selected : baseColor(file, colors));
      if (touch) {
        const visits = playback.visitsByFile.get(file.id) ?? 1;
        let color = colors[touch];
        if (file.ghost) color = color.clone().lerp(colors.ghost, 0.45);
        if (selected) color = colors.selected;
        slots.push({ fileId: file.id, target: attentionHeight(touch, visits), color });
        present.add(file.id);
      } else if (locHeights) {
        const t = locFraction(file.lines, maxLog);
        let color = locColor(t, locRamp);
        if (file.ghost) color = color.lerp(colors.ghost, 0.45);
        if (selected) color = colors.selected;
        slots.push({ fileId: file.id, target: locHeight(t), color });
        present.add(file.id);
      }
    }
    // let columns that just went dark shrink back into the plain
    for (const [fileId, cur] of heights) {
      if (cur > 0.04 && !present.has(fileId)) {
        slots.push({ fileId, target: 0, color: colors.unvisited });
      } else if (cur <= 0.04 && !present.has(fileId)) {
        heights.delete(fileId);
      }
    }

    slots.forEach((slot, i) => terrain.setColorAt(i, slot.color));
    terrain.count = slots.length;
    if (terrain.instanceColor) terrain.instanceColor.needsUpdate = true;
    if (tiles.instanceColor) tiles.instanceColor.needsUpdate = true;
    slotsRef.current = slots;
    // slot index → fileId may have shifted even where no column is lerping
    terrainDirtyRef.current = true;
    loopRef.current?.invalidate();
  }, [city, playback, selectedPath, locHeights, colors, locRamp]);

  // the inspector opens over the right edge; pan the selected tile clear of it
  useEffect(() => {
    if (!city || !selectedPath) return;
    const file = city.files.find((f) => f.path === selectedPath);
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const canvas = rendererRef.current?.domElement;
    if (!file || !camera || !controls || !canvas) return;
    const top = heightsRef.current.get(file.id) ?? TILE_H;
    const world = centerFor(file, bounds);
    world.y = top;
    ensureVisible(
      camera,
      controls,
      world,
      canvas.clientWidth,
      canvas.clientHeight,
      INSPECTOR_RESERVED_PX,
    );
  }, [city, bounds, selectedPath]);

  // trail: ballistic arcs between recent fixations + the firefly at the head
  useEffect(() => {
    const trail = trailRef.current;
    if (!trail || !city) return;

    // playback resolves fileId with the same path key the citymap uses, so a
    // target still missing one has no tile to land on
    const targetFiles = playback.recentTargets
      .map((target) => (target.fileId !== undefined ? city.files[target.fileId] : undefined))
      .filter((file): file is CityFile => Boolean(file));

    const peakFor = (file: CityFile): number => {
      const touch = playback.touchByFile.get(file.id);
      const visits = playback.visitsByFile.get(file.id) ?? 1;
      return touch ? attentionHeight(touch, visits) : TILE_H;
    };

    const firefly = fireflyRef.current;
    if (firefly) {
      const head = targetFiles[targetFiles.length - 1];
      if (head) {
        const p = centerFor(head, bounds);
        firefly.position.set(p.x, peakFor(head) + 1.6, p.z);
        firefly.visible = true;
      } else {
        firefly.visible = false;
      }
    }

    trail.update(
      targetFiles.map((file) => {
        const p = centerFor(file, bounds);
        p.y = peakFor(file) + 0.4;
        return p;
      }),
    );
    loopRef.current?.invalidate();
  }, [city, playback, bounds, palette]);

  // starting or stopping the walk switches the loop between continuous and
  // demand-driven; either edge needs a frame to act on it
  useEffect(() => {
    loopRef.current?.invalidate();
  }, [playing]);

  return <div className="city-scene" ref={hostRef} aria-label="Attention terrain" />;
}

// Columns must read as phosphorescence, not paint: glow pools at the crest and
// falls off into the plain. Vertex shade multiplies the per-instance touch
// color; the top face sits under the side rims so edges catch the most light.
function attentionColumnGeometry(columnShade: readonly [number, number]): THREE.BoxGeometry {
  const [base, crest] = columnShade;
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const pos = geo.getAttribute("position");
  const normal = geo.getAttribute("normal");
  const shade = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) + 0.5;
    const glow = normal.getY(i) === 1 ? crest : base + (crest - base) * t * t;
    shade.fill(glow, i * 3, i * 3 + 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(shade, 3));
  return geo;
}

function baseColor(file: CityFile, colors: SceneColors): THREE.Color {
  if (file.ghost) return colors.ghost;
  let h = 2166136261;
  for (let i = 0; i < file.path.length; i++) {
    h = Math.imul(h ^ file.path.charCodeAt(i), 16777619);
  }
  const jitter = ((h >>> 0) % 1000) / 1000 - 0.5;
  return colors.unvisited.clone().offsetHSL(0, 0, jitter * 0.05);
}

function centerFor(file: CityFile, bounds: { cx: number; cz: number }): THREE.Vector3 {
  return new THREE.Vector3(
    file.rect.x + file.rect.w / 2 - bounds.cx,
    0,
    file.rect.z + file.rect.d / 2 - bounds.cz,
  );
}

function dirBasename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}
