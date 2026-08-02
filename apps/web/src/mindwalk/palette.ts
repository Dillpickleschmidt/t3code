import * as THREE from "three";

/**
 * The one place mindwalk's *data* colors are defined.
 *
 * Mindwalk states them twice — once in `styles.css` as `--moss`/`--moon`/
 * `--amber`, once in `scene/sceneUtils.ts` as `#8fb45f`/`#a5c8f1`/`#f0ad5a` —
 * and the two had already drifted apart by a few hundredths of oklch lightness.
 * They cannot drift here: the HUD's legend dots and the Timeline's action dots
 * are the *key* to what the GPU draws, so a swatch that disagrees with its
 * material is a lie about the scene.
 *
 * Chrome color (panels, hairlines, text) is deliberately absent — that is T3's
 * job, and the ported components take it from T3's tokens through Tailwind.
 * Only what encodes meaning lives here.
 *
 * ## Two palettes, one encoding
 *
 * Mindwalk is a nocturnal observatory: an unlit sky where *light is data*, and
 * only touch states and trails may glow. That reading has no light-mode
 * translation — raising the background without inverting the metaphor gives
 * washed-out fireflies on white, because additive blending against a light
 * backdrop is a no-op.
 *
 * So light mode inverts the metaphor too: a **daylight survey**, where ink is
 * data. Near-white ground, graphite masses, touch states as saturated ink.
 * Hue is preserved exactly — hue is the meaning the legend promises — and only
 * lightness flips. The glow model flips with it: `AdditiveBlending` emits onto
 * darkness, `NormalBlending` absorbs onto paper. Both preserve the two
 * properties the scene actually depends on, soft falloff (from the texture's
 * alpha) and accumulation (overlapping marks deepen).
 *
 * Dark mode remains the fidelity reference: it is what a live `mindwalk serve`
 * renders, and what screenshot parity is checked against.
 */
export type MindwalkTheme = "light" | "dark";

/**
 * Colors the GPU draws with.
 *
 * Hex strings rather than `THREE.Color` instances on purpose: the scenes
 * `clone()`, `lerp()`, and `set()` their way through these, and a shared
 * mutable Color would let one scene's tuning leak into the other's.
 */
export interface ScenePalette {
  /**
   * Scene background and fog target — distant geometry fades into it.
   *
   * The value here is only a fallback. At runtime the surface reads its own
   * computed `--background` and overrides this, so the stage is exactly the
   * colour the rest of the app is sitting on. Mindwalk's own sky was a
   * blue-tinted `#12151c`, which against T3's neutral dark read as a
   * different surface bolted into the panel.
   */
  readonly sky: string;
  /** The walker's trail. */
  readonly ember: string;
  readonly touch: {
    readonly hit: string;
    readonly read: string;
    readonly edit: string;
    /** Selection: the extreme end of the lightness axis, so it reads as the
     * brightest thing at night and the deepest thing by day. */
    readonly selected: string;
  };
  /** The plain the map sits on, and the survey grid ruled over it. Huge
   * meshes: at night they are a shade above the sky, and by day they must be
   * the paper itself or the fog turns them into a gradient wash. */
  readonly ground: string;
  readonly gridMajor: string;
  readonly gridMinor: string;
  /**
   * Vertical shade baked into the attention columns, base → crest.
   *
   * Mindwalk multiplies each column's touch colour by this so glow pools at
   * the crest and falls off into the plain — phosphorescence, not paint. That
   * only reads on an unlit stage: multiplying toward zero means "toward
   * black", which on paper puts a dark smudge at the foot of everything
   * instead of letting it fade out. By day the columns are flat and the
   * scene's own lighting does the shading.
   */
  readonly columnShade: readonly [base: number, crest: number];
  readonly city: {
    readonly unvisited: string;
    readonly ghost: string;
    /** Static-map height ramp, small files → large. Four stops, interpolated. */
    readonly locRamp: readonly [string, string, string, string];
    /** Directory floor plates, shallow → deep nesting. */
    readonly dirShadeNear: string;
    readonly dirShadeFar: string;
  };
  readonly tree: {
    readonly unvisited: string;
    readonly ghost: string;
    /** Branch at rest, and a branch leading to a visited leaf. The pair always
     * moves *away* from the sky: brighter at night, darker by day. */
    readonly edgeBase: string;
    readonly edgeLit: string;
    /** Held apart from `touch.edit` so the walker never reads as an amber leaf. */
    readonly fireflyHot: string;
  };
  readonly light: {
    readonly hemiSky: string;
    readonly hemiGround: string;
    readonly hemiIntensity: number;
    readonly sunColor: string;
    readonly sunIntensity: number;
  };
  /** Additive emits onto an unlit sky; normal absorbs onto paper. */
  readonly glowBlending: THREE.Blending;
  /** In-scene directory labels, drawn to a canvas texture. */
  readonly labelInk: string;
  /** Firefly sprite radial gradient: centre, mid, transparent edge. */
  readonly fireflyStops: readonly [string, string, string];
}

/**
 * Colors the chrome draws with — the legend for the scene above, plus the
 * Timeline's own action and mark spectra, which have no scene counterpart.
 *
 * Reaches the DOM as `--mw-*` custom properties on the surface root
 * (see `cssVariables`), so ported CSS keeps reading `var(--mw-act-edit)` the
 * way mindwalk read `var(--act-edit)`.
 */
export interface DataPalette {
  /** Legend swatches, straight from the scene's own values. The neutral pair
   * (unvisited, ghost) is resolved rather than declared — see `cssVariables`. */
  readonly touch: {
    readonly hit: string;
    readonly read: string;
    readonly edit: string;
  };
  /** Timeline histogram and readout. Cool = observation, warm = mutation;
   * chroma tracks importance so edits outshine the background hum. */
  readonly action: {
    readonly search: string;
    readonly read: string;
    readonly edit: string;
    readonly verify: string;
    readonly exec: string;
    readonly other: string;
  };
  readonly mark: {
    readonly compaction: string;
    readonly subagent: string;
    readonly userMessage: string;
  };
}

export interface MindwalkPalette {
  readonly scene: ScenePalette;
  readonly data: DataPalette;
}

const DARK: MindwalkPalette = {
  scene: {
    // fallback only; `--color-neutral-950`, the dark `--background`
    sky: "#0a0a0a",
    ember: "#ff9e5e",
    touch: {
      hit: "#8fb45f",
      // chromatic enough to read as blue on lit terrain columns — a paler tint
      // washed out to white and stopped matching the HUD legend
      read: "#a5c8f1",
      edit: "#f0ad5a",
      selected: "#f6ead2",
    },
    ground: "#141414",
    gridMajor: "#242424",
    gridMinor: "#1c1c1c",
    columnShade: [0.34, 0.82],
    city: {
      unvisited: "#616161",
      ghost: "#464646",
      locRamp: ["#616161", "#e0894f", "#9a6bd8", "#e0524f"],
      dirShadeNear: "#171717",
      dirShadeFar: "#232323",
    },
    tree: {
      unvisited: "#616161",
      ghost: "#525252",
      edgeBase: "#404040",
      edgeLit: "#8a8a8a",
      fireflyHot: "#ffeeda",
    },
    light: {
      hemiSky: "#7a7a7a",
      hemiGround: "#0a0a0a",
      hemiIntensity: 1.7,
      sunColor: "#c9c9c9",
      sunIntensity: 1.1,
    },
    glowBlending: THREE.AdditiveBlending,
    labelInk: "#a1a1a1",
    fireflyStops: ["rgba(255,255,255,1)", "rgba(255,210,160,0.55)", "rgba(255,158,94,0)"],
  },
  data: {
    touch: {
      hit: "#8fb45f",
      read: "#a5c8f1",
      edit: "#f0ad5a",
    },
    action: {
      search: "oklch(0.74 0.09 192)",
      read: "oklch(0.8 0.07 242)",
      edit: "oklch(0.8 0.16 75)",
      verify: "oklch(0.75 0.13 145)",
      exec: "oklch(0.58 0.02 255)",
      other: "oklch(0.55 0.015 255)",
    },
    mark: {
      compaction: "oklch(0.66 0.2 32)",
      subagent: "oklch(0.74 0.09 300)",
      userMessage: "oklch(0.63 0.02 252)",
    },
  },
};

const LIGHT: MindwalkPalette = {
  scene: {
    // fallback only; `--color-zinc-25`, the light `--background`
    sky: "#fcfcfc",
    ember: "#c2530f",
    touch: {
      hit: "#4f7d22",
      read: "#2c6aa8",
      edit: "#b4700f",
      selected: "#3c2c12",
    },
    ground: "#fafafa",
    gridMajor: "#e8e8e8",
    gridMinor: "#f0f0f0",
    columnShade: [1, 1],
    city: {
      // unvisited sits just *below* the sky by day exactly as it sits just
      // above it by night: present, but the dullest thing on the stage
      unvisited: "#a8a8a8",
      ghost: "#c9c9c9",
      locRamp: ["#a8a8a8", "#c26a1c", "#6a3fa6", "#b02623"],
      dirShadeNear: "#ededed",
      dirShadeFar: "#dedede",
    },
    tree: {
      unvisited: "#a8a8a8",
      ghost: "#bdbdbd",
      edgeBase: "#c4c4c4",
      edgeLit: "#767676",
      fireflyHot: "#3f2a10",
    },
    light: {
      hemiSky: "#e6e6e6",
      hemiGround: "#fcfcfc",
      hemiIntensity: 2.2,
      sunColor: "#fdfdfd",
      sunIntensity: 1.5,
    },
    glowBlending: THREE.NormalBlending,
    labelInk: "#71717a",
    fireflyStops: ["rgba(63,42,16,0.95)", "rgba(140,74,20,0.5)", "rgba(194,83,15,0)"],
  },
  data: {
    touch: {
      hit: "#4f7d22",
      read: "#2c6aa8",
      edit: "#b4700f",
    },
    action: {
      search: "oklch(0.52 0.11 192)",
      read: "oklch(0.5 0.13 250)",
      edit: "oklch(0.56 0.14 62)",
      verify: "oklch(0.5 0.14 145)",
      exec: "oklch(0.55 0.02 255)",
      other: "oklch(0.62 0.015 255)",
    },
    mark: {
      compaction: "oklch(0.52 0.19 32)",
      subagent: "oklch(0.5 0.16 300)",
      userMessage: "oklch(0.55 0.02 252)",
    },
  },
};

export function paletteFor(theme: MindwalkTheme): MindwalkPalette {
  return theme === "light" ? LIGHT : DARK;
}

/**
 * Positions on T3's own neutral axis, as a percentage from `--background`
 * toward `--foreground`.
 *
 * Mindwalk's structural greys — the plain, the branches, unvisited and ghost
 * files — were a cool blue-grey family tuned against its navy sky. Against
 * T3's neutral surfaces they read as a foreign object, so they are expressed
 * as *distances* rather than colours: how far each thing sits from the
 * background toward the foreground. That keeps mindwalk's ordering intact
 * (ghost dimmer than unvisited, a lit branch brighter than one at rest) while
 * putting every value on whatever axis T3 currently uses.
 *
 * One ratio serves both themes, because "toward the foreground" already means
 * "more present" in either — it darkens on paper and lightens at night.
 */
const STRUCTURE_MIX = {
  ground: 3,
  gridMinor: 6,
  gridMajor: 10,
  dirShadeNear: 6,
  dirShadeFar: 12,
  cityGhost: 26,
  treeEdgeBase: 24,
  treeGhost: 32,
  unvisited: 39,
  treeEdgeLit: 55,
} as const;

/**
 * Light mode needs a longer step to read as the same separation.
 *
 * `color-mix(in oklab, …)` is perceptually uniform, so N% is the same
 * perceptual distance in either direction — but the *ground it lands on* is
 * not symmetric. Against black, 39% toward white is legible mid-grey; against
 * white, 39% toward black is faint. On the terrain that barely shows, because
 * the touch colours carry the image. On the tree, where the structure is the
 * content, it is the difference between reading the shape and squinting.
 *
 * One multiplier rather than a second table, so the ordering below stays the
 * single source of truth: ghost dimmer than unvisited, a lit branch brighter
 * than one at rest, in both themes.
 */
const LIGHT_MIX_GAIN = 1.4;

/**
 * The scene palette with every neutral resolved against the live theme.
 *
 * A WebGL canvas cannot inherit `bg-background` and `text-muted-foreground`
 * the way the chrome does — it has to be told — so the surface reads them off
 * a probe element inside itself and hands the result to both scenes. Resolved
 * rather than hardcoded so the stage stays exactly what the app is sitting on
 * if T3 retunes its palette, instead of a near-match that rots.
 *
 * The detour through a canvas is deliberate. T3's tokens are authored in
 * `oklch`, and `getComputedStyle` serializes a colour in the space it was
 * written in — so it hands back `oklch(...)`, which `THREE.Color.setStyle`
 * cannot read. A canvas context parses the full CSS colour syntax and
 * re-serializes opaque colours as `#rrggbb`, which three.js can.
 *
 * Any failure falls back to the static palette wholesale rather than in part,
 * so the scene is never a mix of two axes.
 */
export function resolveScenePalette(host: HTMLElement, theme: MindwalkTheme): ScenePalette {
  const fallback = paletteFor(theme).scene;
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!context) return fallback;

  const probe = document.createElement("div");
  probe.style.display = "none";
  host.appendChild(probe);
  try {
    const read = (value: string): string | undefined => {
      probe.style.color = "";
      probe.style.color = value;
      // a value this browser cannot parse is dropped, leaving the property
      // empty — without this the probe would silently report inherited colour
      if (!probe.style.color) return undefined;
      const computed = getComputedStyle(probe).color;
      if (!computed) return undefined;
      // an unparseable assignment leaves fillStyle untouched, so a sentinel is
      // the only way to tell "the browser rejected it" from "the answer is black"
      const sentinel = "#010203";
      context.fillStyle = sentinel;
      context.fillStyle = computed;
      if (context.fillStyle === sentinel) return undefined;
      // Canvas serializes a colour in the space it was authored in, so T3's
      // oklch tokens come back as `oklab(...)` — which THREE.Color cannot
      // parse, and which an earlier `startsWith("#")` guard silently rejected,
      // falling the whole scene back to the static palette. Rasterizing one
      // pixel and reading the bytes converts to sRGB for us, whatever syntax
      // the token was written in.
      context.clearRect(0, 0, 1, 1);
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      // the stage is opaque; a see-through sky is not a usable fog target
      if (alpha !== 255) return undefined;
      const hex = (channel: number | undefined) => (channel ?? 0).toString(16).padStart(2, "0");
      return `#${hex(red)}${hex(green)}${hex(blue)}`;
    };
    const gain = theme === "light" ? LIGHT_MIX_GAIN : 1;
    const mix = (percent: number) =>
      read(
        `color-mix(in oklab, var(--foreground) ${Math.min(percent * gain, 100)}%, var(--background))`,
      );

    const sky = read("var(--background)");
    const labelInk = read("var(--muted-foreground)");
    const ground = mix(STRUCTURE_MIX.ground);
    const gridMajor = mix(STRUCTURE_MIX.gridMajor);
    const gridMinor = mix(STRUCTURE_MIX.gridMinor);
    const unvisited = mix(STRUCTURE_MIX.unvisited);
    const cityGhost = mix(STRUCTURE_MIX.cityGhost);
    const treeGhost = mix(STRUCTURE_MIX.treeGhost);
    const edgeBase = mix(STRUCTURE_MIX.treeEdgeBase);
    const edgeLit = mix(STRUCTURE_MIX.treeEdgeLit);
    const dirShadeNear = mix(STRUCTURE_MIX.dirShadeNear);
    const dirShadeFar = mix(STRUCTURE_MIX.dirShadeFar);
    if (
      !sky ||
      !labelInk ||
      !ground ||
      !gridMajor ||
      !gridMinor ||
      !unvisited ||
      !cityGhost ||
      !treeGhost ||
      !edgeBase ||
      !edgeLit ||
      !dirShadeNear ||
      !dirShadeFar
    ) {
      return fallback;
    }

    return {
      ...fallback,
      sky,
      labelInk,
      ground,
      gridMajor,
      gridMinor,
      city: {
        ...fallback.city,
        unvisited,
        ghost: cityGhost,
        // the ramp's first stop is the grey that means "smallest file", and it
        // has always been the same grey as unvisited
        locRamp: [unvisited, ...fallback.city.locRamp.slice(1)] as [string, string, string, string],
        dirShadeNear,
        dirShadeFar,
      },
      tree: { ...fallback.tree, unvisited, ghost: treeGhost, edgeBase, edgeLit },
      // the hemisphere's lower half is bounce off the floor, which is the sky
      light: { ...fallback.light, hemiGround: sky },
    };
  } finally {
    probe.remove();
  }
}

/**
 * The data palette as inline custom properties for the surface root. Ported
 * CSS reads `var(--mw-act-edit)` where mindwalk read `var(--act-edit)`; the
 * `mw-` prefix keeps them from colliding with T3's own tokens.
 */
export function cssVariables(
  { data }: MindwalkPalette,
  scene: ScenePalette,
): Record<string, string> {
  return {
    "--mw-touch-hit": data.touch.hit,
    "--mw-touch-read": data.touch.read,
    "--mw-touch-edit": data.touch.edit,
    // the two neutral swatches come from the *resolved* scene, not the static
    // palette: they key structural greys, which move with T3's axis
    "--mw-touch-unvisited": scene.city.unvisited,
    "--mw-touch-ghost-border": scene.city.ghost,
    "--mw-act-search": data.action.search,
    "--mw-act-read": data.action.read,
    "--mw-act-edit": data.action.edit,
    "--mw-act-verify": data.action.verify,
    "--mw-act-exec": data.action.exec,
    "--mw-act-other": data.action.other,
    "--mw-mark-compaction": data.mark.compaction,
    "--mw-mark-subagent": data.mark.subagent,
    "--mw-mark-user-message": data.mark.userMessage,
  };
}
