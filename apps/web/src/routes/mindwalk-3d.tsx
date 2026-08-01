import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

// three.js and the ported scenes load only when this route is visited, so the
// main bundle pays nothing for them.
const MindwalkHarness = lazy(() => import("../mindwalk/MindwalkHarness"));

export const Route = createFileRoute("/mindwalk-3d")({
  validateSearch: (search: Record<string, unknown>) => ({
    threadId: typeof search.threadId === "string" ? search.threadId : "",
  }),
  component: Mindwalk3dRouteView,
});

function Mindwalk3dRouteView() {
  const { threadId } = Route.useSearch();
  return (
    <div className="h-full min-h-0 flex-1">
      <Suspense fallback={null}>
        <MindwalkHarness threadId={threadId} />
      </Suspense>
    </div>
  );
}
