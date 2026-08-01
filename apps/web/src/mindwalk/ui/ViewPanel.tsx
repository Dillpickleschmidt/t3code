import { Mountain, TreePine } from "lucide-react";

import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";

export type SceneView = "tree" | "terrain";

interface ViewPanelProps {
  view: SceneView;
  onViewChange: (view: SceneView) => void;
  /** the legend line for the active view ("glow ∝ revisits", …) */
  note: string;
}

// Pop content for the dock's scene section: how the stage renders. Future
// layer toggles (line-level lights, trail length, floor contrast) join this
// panel instead of growing the strip.
//
// Mindwalk hand-rolled these as `aria-pressed` buttons, explicitly declining
// the radiogroup pattern because it lacked roving tabindex and arrow-key
// navigation. T3's ToggleGroup has both, so the primitive is a strict
// improvement over what it replaces rather than a reskin of it.
export function ViewPanel({ view, onViewChange, note }: ViewPanelProps) {
  return (
    <div className="grid gap-2">
      <ToggleGroup
        aria-label="Scene view"
        className="w-full"
        orientation="vertical"
        variant="outline"
        size="sm"
        value={[view]}
        onValueChange={(next) => {
          const chosen = next[0];
          if (chosen === "tree" || chosen === "terrain") onViewChange(chosen);
        }}
      >
        <ToggleGroupItem className="w-full justify-start gap-2" value="tree">
          <TreePine />
          <span>Tree</span>
        </ToggleGroupItem>
        <ToggleGroupItem className="w-full justify-start gap-2" value="terrain">
          <Mountain />
          <span>Terrain</span>
        </ToggleGroupItem>
      </ToggleGroup>
      <p className="px-1 text-xs text-muted-foreground/70 leading-snug">{note}</p>
    </div>
  );
}
