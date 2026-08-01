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
  /** Scene background and fog target — distant geometry fades into it. */
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
  /** Legend swatches. `hit`/`read`/`edit` are the scene's own values. */
  readonly touch: {
    readonly hit: string;
    readonly read: string;
    readonly edit: string;
    readonly unvisited: string;
    /** Ghost swatches are hollow — a border, matching the wireframe orbs. */
    readonly ghostBorder: string;
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
    sky: "#12151c",
    ember: "#ff9e5e",
    touch: {
      hit: "#8fb45f",
      // chromatic enough to read as blue on lit terrain columns — a paler tint
      // washed out to white and stopped matching the HUD legend
      read: "#a5c8f1",
      edit: "#f0ad5a",
      selected: "#f6ead2",
    },
    city: {
      unvisited: "#5b6372",
      ghost: "#404551",
      locRamp: ["#5b6372", "#e0894f", "#9a6bd8", "#e0524f"],
      dirShadeNear: "#1a1f29",
      dirShadeFar: "#252b37",
    },
    tree: {
      unvisited: "#5a6375",
      ghost: "#4d5464",
      edgeBase: "#3c424f",
      edgeLit: "#7d8496",
      fireflyHot: "#ffeeda",
    },
    light: {
      hemiSky: "#66779b",
      hemiGround: "#161922",
      hemiIntensity: 1.7,
      sunColor: "#b6c5de",
      sunIntensity: 1.1,
    },
    glowBlending: THREE.AdditiveBlending,
    labelInk: "rgba(197, 205, 222, 0.95)",
    fireflyStops: ["rgba(255,255,255,1)", "rgba(255,210,160,0.55)", "rgba(255,158,94,0)"],
  },
  data: {
    touch: {
      hit: "#8fb45f",
      read: "#a5c8f1",
      edit: "#f0ad5a",
      unvisited: "oklch(0.5 0.014 254)",
      ghostBorder: "oklch(0.55 0.014 254)",
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
    // paper, not white: a flat #fff stage loses the aerial-perspective fog
    // cue that the night sky gets for free
    sky: "#eef1f6",
    ember: "#c2530f",
    touch: {
      hit: "#4f7d22",
      read: "#2c6aa8",
      edit: "#b4700f",
      selected: "#3c2c12",
    },
    city: {
      // unvisited sits just *below* the sky by day exactly as it sits just
      // above it by night: present, but the dullest thing on the stage
      unvisited: "#aab2c0",
      ghost: "#cbd1da",
      locRamp: ["#aab2c0", "#c26a1c", "#6a3fa6", "#b02623"],
      dirShadeNear: "#e2e6ee",
      dirShadeFar: "#d3d9e3",
    },
    tree: {
      unvisited: "#a9b1c0",
      ghost: "#c6ccd6",
      edgeBase: "#c2c8d3",
      edgeLit: "#5e6777",
      fireflyHot: "#3f2a10",
    },
    light: {
      hemiSky: "#dfe8f7",
      hemiGround: "#b5afa4",
      hemiIntensity: 2.2,
      sunColor: "#fff7ea",
      sunIntensity: 1.5,
    },
    glowBlending: THREE.NormalBlending,
    labelInk: "rgba(74, 84, 104, 0.95)",
    fireflyStops: ["rgba(63,42,16,0.95)", "rgba(140,74,20,0.5)", "rgba(194,83,15,0)"],
  },
  data: {
    touch: {
      hit: "#4f7d22",
      read: "#2c6aa8",
      edit: "#b4700f",
      unvisited: "oklch(0.68 0.014 254)",
      ghostBorder: "oklch(0.72 0.014 254)",
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
 * The data palette as inline custom properties for the surface root. Ported
 * CSS reads `var(--mw-act-edit)` where mindwalk read `var(--act-edit)`; the
 * `mw-` prefix keeps them from colliding with T3's own tokens.
 */
export function cssVariables({ data }: MindwalkPalette): Record<string, string> {
  return {
    "--mw-touch-hit": data.touch.hit,
    "--mw-touch-read": data.touch.read,
    "--mw-touch-edit": data.touch.edit,
    "--mw-touch-unvisited": data.touch.unvisited,
    "--mw-touch-ghost-border": data.touch.ghostBorder,
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
