import type { LucideIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Separator } from "~/components/ui/separator";
import { Hint } from "./Hint";

export type PanelPresentation = "sheet" | "pop";
export type PanelSection = "scene" | "session";

/**
 * One dock panel, declared as data. Extending the dock — a layers toggle, a
 * compare view, a metrics board — means registering one descriptor here;
 * the strip, grouping, and open/close behavior come for free.
 */
export interface PanelDescriptor {
  id: string;
  icon: LucideIcon;
  hint: string;
  /** scene = how the stage renders; session = depth content about the trace */
  section: PanelSection;
  /** sheet = full-height paper, one at a time; pop = compact card anchored
   * to the strip, coexists with an open sheet */
  presentation: PanelPresentation;
  render: () => ReactNode;
}

interface DockProps {
  panels: PanelDescriptor[];
  openSheet: string | null;
  openPop: string | null;
  onToggle: (panel: PanelDescriptor) => void;
  onClosePop: () => void;
}

/**
 * The dock keeps mindwalk's own open/close logic rather than moving to T3's
 * Popover: a pop is explicitly allowed to coexist with an open sheet, which is
 * not what a popover means, and forcing it into one would change behavior
 * rather than restyle it. Only the chrome is T3's.
 */
export function Dock({ panels, openSheet, openPop, onToggle, onClosePop }: DockProps) {
  const popRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const sheet = panels.find((panel) => panel.id === openSheet && panel.presentation === "sheet");
  const pop = panels.find((panel) => panel.id === openPop && panel.presentation === "pop");
  const sections: PanelSection[] = ["scene", "session"];
  const grouped = sections
    .map((section) => ({ section, items: panels.filter((panel) => panel.section === section) }))
    .filter((group) => group.items.length > 0);

  // pops are transient: click-away or Escape dismisses, like any menu; the
  // strip is exempt so the toggle button doesn't dismiss-then-reopen
  useEffect(() => {
    if (!pop) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popRef.current?.contains(target) || stripRef.current?.contains(target)) return;
      onClosePop();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClosePop();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [pop, onClosePop]);

  return (
    // narrow hosts turn the dock into a bottom sheet, pinned inside the surface
    // rather than the visual viewport — mindwalk's own 900px rule, re-keyed to
    // the container because this is a resizable panel, not a window
    <div className="pointer-events-none absolute top-5 right-5 bottom-5 flex items-start gap-2.5 *:pointer-events-auto @max-[900px]:inset-x-3 @max-[900px]:top-auto @max-[900px]:bottom-3 @max-[900px]:flex-row-reverse @max-[900px]:items-end">
      {/* anchored left of the whole dock: beside the sheet when one is open,
          beside the strip otherwise — never covering either */}
      {pop ? (
        <div
          ref={popRef}
          className="mindwalk-glass absolute top-0 right-[calc(100%+10px)] z-20 min-w-[168px] rounded-[var(--control-radius)] border border-border p-2 shadow-xl @max-[900px]:static @max-[900px]:right-auto"
        >
          {pop.render()}
        </div>
      ) : null}
      {sheet ? (
        <aside className="mindwalk-glass h-full w-[320px] overflow-hidden rounded-[var(--control-radius)] border border-border shadow-xl @max-[900px]:h-auto @max-[900px]:max-h-[46%] @max-[900px]:w-auto @max-[900px]:min-w-0 @max-[900px]:flex-1">
          {sheet.render()}
        </aside>
      ) : null}
      <div className="relative flex items-start" ref={stripRef}>
        {/* toggle buttons, not tabs: panels open as pops or sheets with no
            tabpanel relationship, so aria-pressed is the honest semantic */}
        <div
          className="mindwalk-glass grid gap-1.5 rounded-[var(--control-radius)] border border-border p-1.5"
          role="group"
          aria-label="Stage panels"
        >
          {grouped.map((group, index) => (
            <div key={group.section} className="grid gap-1.5">
              {index > 0 ? <Separator className="my-0.5" /> : null}
              {group.items.map((panel) => {
                const active = panel.id === openSheet || panel.id === openPop;
                const Icon = panel.icon;
                return (
                  <Hint key={panel.id} text={panel.hint}>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-pressed={active}
                      aria-label={panel.hint}
                      data-pressed={active || undefined}
                      onClick={() => onToggle(panel)}
                    >
                      <Icon />
                    </Button>
                  </Hint>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
