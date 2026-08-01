import type { ReactElement } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/**
 * Mindwalk's `data-hint` attribute, expressed through T3's tooltip.
 *
 * Upstream hand-rolled a CSS `::after` bubble because "native title is too
 * slow for an instrument" — which is true of `title`, but T3's tooltip is
 * already instant when its provider says so, and brings real positioning,
 * portalling, collision handling, and dismissal that a `::after` cannot. The
 * hint text itself is mindwalk's, verbatim: these strings are what teach the
 * spectrum, and rewriting them would quietly change what the HUD claims.
 */
export function Hint({ text, children }: { text: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup className="max-w-[250px]">{text}</TooltipPopup>
    </Tooltip>
  );
}
