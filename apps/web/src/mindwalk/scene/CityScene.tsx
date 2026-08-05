import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { touchWord, type CityFile, type CityMap, type Touch } from "../types";
import type { FilePlayback } from "../playback/reducer";
import type { ScenePalette } from "../palette";
import { MAX_COLUMN_SEGMENTS, type Column } from "./columns";
import { DirLabelSet } from "./dirLabels";
import {
  disposeGroup,
  ensureVisible,
  inspectorInsets,
  restoreCamera,
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
  /**
   * How tall each file's column stands and in what colours — the whole of what
   * separates one drive mode from another. Built by the surface (see
   * `./columns`), because the policy is a pure function of its own data and
   * has no business being reachable only by mounting WebGL.
   */
  columns: readonly Column[];
  /** The walker: the trail, the firefly at its head, and the hover readout's
   * default wording. A surface with no walk (3D Diff) passes an empty one,
   * which hides the firefly and clears the trail without any gating here. */
  playback: FilePlayback;
  selectedPath?: string;
  onSelect: (path?: string) => void;
  /** Right-click. When set, the browser context menu is suppressed on the
   * canvas so the stage owns both buttons. */
  onSecondarySelect?: (path?: string) => void;
  onCanvasReady?: (canvas: HTMLCanvasElement | null) => void;
  /** Second line of the hover readout. Defaults to the walk's own vocabulary
   * ("read · 3 visits"), which is a lie on a surface that isn't a walk. */
  hoverMeta?: (file: CityFile) => string;
  // the scrubber is playing: the one state that earns a continuous frame loop
  playing?: boolean;
  /**
   * The tallest column this surface will ever draw, so the camera frames for
   * it. Fitting the ground alone was fine while columns were a fraction of the
   * map's width, and crops them once they are not.
   *
   * The surface's figure, not the frame's: taking it from the columns actually
   * on stage would rescale the view every time the scrubber moved between a
   * quiet commit and a busy one.
   */
  tallestColumn?: number;
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

export function CityScene({
  city,
  columns,
  playback,
  selectedPath,
  onSelect,
  onSecondarySelect,
  onCanvasReady,
  hoverMeta,
  playing = false,
  tallestColumn = 0,
  palette,
}: CitySceneProps) {
  // A palette switch rebuilds the stage rather than mutating every material in
  // place: it happens once in a blue moon, and the alternative is a second
  // code path that has to stay in step with scene construction forever.
  const colors = useMemo(() => sceneColors(palette), [palette]);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const tileMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const terrainMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const filesRef = useRef<CityFile[]>([]);
  /** instanceId → fileId for the terrain mesh, which is all picking needs */
  const slotFileIdsRef = useRef<number[]>([]);
  /** each file's finished column height, for the things that ride on top of a
   * column rather than draw it: the trail, the firefly, the selection pan */
  const columnTopRef = useRef<Map<number, number>>(new Map());
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
  // handlers live in the mount effect; they read playback through this ref
  const playbackRef = useRef(playback);
  playbackRef.current = playback;
  const hoverMetaRef = useRef(hoverMeta);
  hoverMetaRef.current = hoverMeta;
  // read through a ref so a new callback identity does not rebuild the stage
  const onSecondarySelectRef = useRef(onSecondarySelect);
  onSecondarySelectRef.current = onSecondarySelect;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const tallestColumnRef = useRef(tallestColumn);
  tallestColumnRef.current = tallestColumn;
  /** the user has framed the stage themselves; nothing auto-fits over that */
  const userTookCameraRef = useRef(false);
  // camera fit deferred while the viewport reports no size (hidden pane,
  // background tab); resize retries it instead of leaving the camera at NaN
  const fitPendingRef = useRef<(() => boolean) | null>(null);
  /** the live fit, so the resize handler in the other effect can re-run it */
  const fitViewRef = useRef<(() => boolean) | null>(null);
  /**
   * Where the camera was before a selection panned it clear of the inspector.
   *
   * mindwalk pans and never restores, which is fine on its stage: the reserve
   * is a modest slice of a wide page, so the shift is small and the inspector
   * is usually open anyway. Here the inspector can cover much of a narrow
   * panel, so the pan is large and leaving the stage shoved aside after it
   * closes reads as a bug. Cleared the moment the user takes the camera —
   * restoring over their own framing would be worse than not restoring.
   */
  const preSelectCameraRef = useRef<{ position: THREE.Vector3; target: THREE.Vector3 } | null>(
    null,
  );

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
    userTookCameraRef.current = false;
    controls.addEventListener("start", () => {
      userTookCameraRef.current = true;
      preSelectCameraRef.current = null;
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
        const fileId = slotFileIdsRef.current[hit.instanceId];
        return fileId === undefined ? undefined : filesRef.current[fileId];
      }
      return filesRef.current[hit.instanceId];
    };

    let downAt: { x: number; y: number; button: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      downAt = { x: event.clientX, y: event.clientY, button: event.button };
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!downAt || event.button !== downAt.button) {
        downAt = null;
        return;
      }
      const { button } = downAt;
      const moved = Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y);
      downAt = null;
      // a drag is camera movement on either button, never a selection
      if (moved > 5) return;
      if (button === 0) {
        onSelect(pickFile(event)?.path);
      } else if (button === 2) {
        onSecondarySelectRef.current?.(pickFile(event)?.path);
      }
    };
    const onContextMenu = (event: Event) => {
      if (onSecondarySelectRef.current) event.preventDefault();
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
        const meta = hoverMetaRef.current?.(file) ?? walkMeta(file, playbackRef.current);
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
    renderer.domElement.addEventListener("contextmenu", onContextMenu);

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
      // A saved camera means a selection pan is in flight and deliberate;
      // re-fitting would undo it and hide the selection behind the inspector.
      else if (!userTookCameraRef.current && !preSelectCameraRef.current) fitViewRef.current?.();
      loopRef.current?.invalidate();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    const clock = new THREE.Clock();
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
      return cameraMoved || labelsEasing || playbackRunning;
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
      renderer.domElement.removeEventListener("contextmenu", onContextMenu);
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
    slotFileIdsRef.current = [];
    boundsRef.current = bounds;
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

    // terrain: unlit columns that grow out of the plain, one instance per
    // stacked segment rather than per file — which is why diff stacking needed
    // no second mesh
    const terrainCapacity = city.files.length * MAX_COLUMN_SEGMENTS;
    const terrain = new THREE.InstancedMesh(
      columnGeometry(palette.columnShade),
      new THREE.MeshBasicMaterial({ toneMapped: false, vertexColors: true }),
      terrainCapacity,
    );
    terrain.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(terrainCapacity * 3),
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
      // the plain's corners at ground level, and again at the height of the
      // tallest column: a column stands where a file does, so its apex can be
      // anywhere over the map, and fitting the ground alone would crop it
      for (const sy of tallestColumnRef.current > 0 ? [0, tallestColumnRef.current] : [0]) {
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            corners.push(new THREE.Vector3(sx * bounds.halfW, sy, sz * bounds.halfD));
          }
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

  // columns → terrain matrices and colors. Heights land at full size in one
  // pass: the columns deliberately do not animate (see README's deviations)
  useEffect(() => {
    const terrain = terrainMeshRef.current;
    const tiles = tileMeshRef.current;
    if (!terrain || !tiles || !city) return;

    const selectedId = city.files.find((file) => file.path === selectedPath)?.id;
    for (const file of city.files) {
      tiles.setColorAt(file.id, file.id === selectedId ? colors.selected : baseColor(file, colors));
    }

    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const tops = new Map<number, number>();
    const slotFileIds: number[] = [];
    for (const column of columns) {
      const file = city.files[column.fileId];
      if (!file) continue;
      // segments of one file arrive together and bottom first, so a running
      // sum stacks them
      let stackBase = 0;
      // the capacity the terrain mesh was built with; a mode that stacks
      // deeper raises MAX_COLUMN_SEGMENTS rather than silently losing a slab
      for (const segment of column.segments.slice(0, MAX_COLUMN_SEGMENTS)) {
        const instanceId = slotFileIds.length;
        const drawn = Math.max(segment.height, 0.02);
        const sx = Math.max(file.rect.w, 0.45) + 0.04;
        const sz = Math.max(file.rect.d, 0.45) + 0.04;
        matrix.compose(
          new THREE.Vector3(
            file.rect.x + file.rect.w / 2 - boundsRef.current.cx,
            stackBase + drawn / 2 + TILE_H,
            file.rect.z + file.rect.d / 2 - boundsRef.current.cz,
          ),
          quaternion,
          new THREE.Vector3(sx, drawn, sz),
        );
        terrain.setMatrixAt(instanceId, matrix);
        // selection outranks whatever the mode painted, on every slab of the
        // stack, so a selected file reads as one solid marker
        terrain.setColorAt(
          instanceId,
          column.fileId === selectedId ? colors.selected : segment.color,
        );
        slotFileIds.push(column.fileId);
        stackBase += segment.height;
      }
      tops.set(column.fileId, stackBase);
    }
    terrain.count = slotFileIds.length;
    terrain.instanceMatrix.needsUpdate = true;
    if (terrain.instanceColor) terrain.instanceColor.needsUpdate = true;
    // `InstancedMesh.raycast` culls against a bounding sphere it computes
    // once, on the first raycast, and never refreshes. A hover over a frame
    // with no columns caches an *empty* sphere (radius -1), and picks on any
    // later column then miss and fall through to the tile behind it.
    // Invalidate whenever the matrices change so the next raycast recomputes
    // from the heights it is actually testing.
    terrain.boundingSphere = null;
    if (tiles.instanceColor) tiles.instanceColor.needsUpdate = true;
    slotFileIdsRef.current = slotFileIds;
    columnTopRef.current = tops;
    loopRef.current?.invalidate();
  }, [city, columns, selectedPath, colors]);

  // The inspector opens over the right edge; pan the selected tile clear of it.
  //
  // `palette` is a dependency for the rebuild, not for the color: a theme
  // switch reconstructs the stage and refits the camera, throwing the pan away
  // while the selection survives in React state, which drops the selected
  // column back under the inspector. The trail effect below carries `palette`
  // it never reads for the same reason. Re-panning when it is not needed costs
  // nothing — `ensureVisible` returns early once the point is inside the safe
  // box.
  useEffect(() => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const canvas = rendererRef.current?.domElement;
    if (!camera || !controls || !canvas) return;
    if (!city || !selectedPath) return restoreCamera(camera, controls, preSelectCameraRef);
    const file = city.files.find((f) => f.path === selectedPath);
    if (!file) return;
    preSelectCameraRef.current ??= {
      position: camera.position.clone(),
      target: controls.target.clone(),
    };
    const top = columnTopRef.current.get(file.id) ?? TILE_H;
    const world = centerFor(file, bounds);
    world.y = top;
    ensureVisible(
      camera,
      controls,
      world,
      canvas.clientWidth,
      canvas.clientHeight,
      inspectorInsets(canvas).right,
      inspectorInsets(canvas).bottom,
    );
  }, [city, bounds, selectedPath, palette]);

  // trail: ballistic arcs between recent fixations + the firefly at the head
  useEffect(() => {
    const trail = trailRef.current;
    if (!trail || !city) return;

    // playback resolves fileId with the same path key the citymap uses, so a
    // target still missing one has no tile to land on
    const targetFiles = playback.recentTargets
      .map((target) => (target.fileId !== undefined ? city.files[target.fileId] : undefined))
      .filter((file): file is CityFile => Boolean(file));

    // the walker rides on whatever the terrain is showing rather than
    // recomputing the attention curve, which is what lets the height policy
    // live entirely in `./columns`
    const peakFor = (file: CityFile): number =>
      Math.max(columnTopRef.current.get(file.id) ?? 0, TILE_H);

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
  }, [city, playback, columns, bounds, palette]);

  // starting or stopping the walk switches the loop between continuous and
  // demand-driven; either edge needs a frame to act on it
  useEffect(() => {
    loopRef.current?.invalidate();
  }, [playing]);

  // The stage is built before the data that says how tall it needs to be, so
  // the first fit framed the ground alone. Refit once that number lands — but
  // never over the user's own framing, and never over a selection pan, which
  // are the same two exclusions the resize handler makes.
  useEffect(() => {
    if (tallestColumn <= 0) return;
    if (userTookCameraRef.current || preSelectCameraRef.current) return;
    fitViewRef.current?.();
    loopRef.current?.invalidate();
  }, [tallestColumn]);

  return <div className="city-scene" ref={hostRef} aria-label="Attention terrain" />;
}

// Columns must read as phosphorescence, not paint: glow pools at the crest and
// falls off into the plain. Vertex shade multiplies the per-instance touch
// color; the top face sits under the side rims so edges catch the most light.
function columnGeometry(columnShade: readonly [number, number]): THREE.BoxGeometry {
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

/** The hover readout's default second line: what the walk did to this file. */
function walkMeta(file: CityFile, playback: FilePlayback): string {
  const touch = playback.touchByPath.get(file.path);
  if (!touch) return touchWord(undefined);
  const visits = playback.visitsByFile.get(file.id) ?? 0;
  return `${touchWord(touch)} · ${visits} visit${visits === 1 ? "" : "s"}`;
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
