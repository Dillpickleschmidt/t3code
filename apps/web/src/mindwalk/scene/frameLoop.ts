// Demand-driven frame driver. Mindwalk's scenes each ran an unconditional
// `requestAnimationFrame` loop that re-rendered forever while mounted; this
// repo forbids that — AGENTS.md: "No continuously repainting animations; they
// peg the GPU on high-refresh displays." A visible but idle scene must cost
// nothing, which is stricter than pausing on a hidden tab: a parked, visible
// view is exactly the case the rule names.
//
// Three inputs decide whether a frame happens:
//
//   - `invalidate()` — a discrete change (new citymap, new playback snapshot,
//     resize, camera event) owes exactly one repaint.
//   - the `draw` callback's return value — `true` means an animation is still
//     in flight (orbit damping, height lerps, label fades, playback) so the
//     next frame follows on its own. This is the only continuous mode, and
//     every producer of it terminates.
//   - the awake gate — a hidden tab or an off-screen host suspends both, and
//     wakes owing one repaint.
//
// Deliberately not React-aware: the scenes are imperative three.js, so the
// loop is owned by the mount effect and poked from the data effects.
/**
 * How long the arrival drift is allowed to run.
 *
 * Mindwalk auto-rotates the camera until the first interaction, which on a
 * view you open and never touch is unbounded motion on a parked, visible
 * host — the case AGENTS.md names. Bounding it keeps the effect and caps the
 * cost: at `autoRotateSpeed = -0.5` (a full orbit in ~120s) this is roughly
 * 18 degrees, enough parallax to read the scene as 3D.
 */
export const ATTRACT_DRIFT_MS = 6000;

export class FrameLoop {
  private frame: number | null = null;
  /** a repaint is owed: something changed that the last frame did not show */
  private pending = true;
  private hostVisible = true;
  private disposed = false;
  private readonly observer: IntersectionObserver;

  constructor(
    host: Element,
    private readonly draw: () => boolean,
  ) {
    // surface-inactive: a hidden pane, a collapsed panel, or a scrolled-away
    // host stops intersecting, which is the signal a ResizeObserver only sees
    // for `display: none`
    this.observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      if (visible === this.hostVisible) return;
      this.hostVisible = visible;
      if (visible) this.invalidate();
      else this.suspend();
    });
    this.observer.observe(host);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.schedule();
  }

  /** something changed off-loop; draw one more frame */
  invalidate() {
    if (this.disposed) return;
    this.pending = true;
    this.schedule();
  }

  dispose() {
    this.disposed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.observer.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibility);
  }

  private get awake(): boolean {
    return this.hostVisible && !document.hidden;
  }

  private schedule() {
    if (this.disposed || this.frame !== null || !this.awake) return;
    this.frame = requestAnimationFrame(this.tick);
  }

  // `pending` is cleared before `draw` runs so an invalidate raised *during*
  // the frame (a `change` event from `controls.update()`, say) still books the
  // next one instead of being swallowed by the frame that was already drawing.
  private readonly tick = () => {
    this.frame = null;
    this.pending = false;
    const animating = this.draw();
    if (animating || this.pending) this.schedule();
  };

  private readonly onVisibility = () => {
    if (document.hidden) this.suspend();
    else this.invalidate();
  };

  private suspend() {
    if (this.frame === null) return;
    cancelAnimationFrame(this.frame);
    this.frame = null;
    // the animation state lives in the scene's refs, not here, so waking only
    // needs one frame to pick it back up
    this.pending = true;
  }
}
