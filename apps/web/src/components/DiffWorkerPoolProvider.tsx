import { WorkerPoolContextProvider, useWorkerPool } from "@pierre/diffs/react";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, type ReactNode } from "react";
import { useTheme } from "../hooks/useTheme";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { getSyntaxHighlighterPromise } from "../lib/syntaxHighlighting";

const WARM_HIGHLIGHT_LANGUAGES = ["typescript", "tsx", "javascript", "json", "markdown"];

export class DiffWorkerError extends Schema.TaggedErrorClass<DiffWorkerError>()("DiffWorkerError", {
  operation: Schema.Literals(["create-worker", "get-render-options", "set-render-options"]),
  themeName: Schema.Literals(["pierre-light", "pierre-dark"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Diff worker operation ${this.operation} failed for theme ${this.themeName}.`;
  }
}

/**
 * Both highlighters initialize lazily on their first request, which puts
 * worker spawn + shiki + theme + grammar loading on the first diff's paint
 * path. Warming at idle moves that off-screen: the worker pool serves the
 * large diff surfaces, and the shared main-thread highlighter lets small
 * inline previews (which render with `disableWorkerPool`) tokenize
 * synchronously on first paint with no flash.
 */
function DiffWorkerPoolWarmup() {
  const workerPool = useWorkerPool();

  useEffect(() => {
    if (!workerPool || workerPool.isInitialized()) {
      return;
    }
    const warm = () => {
      void workerPool.initialize(WARM_HIGHLIGHT_LANGUAGES).catch(() => {});
      for (const language of WARM_HIGHLIGHT_LANGUAGES) {
        void getSyntaxHighlighterPromise(language).catch(() => {});
      }
    };
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(warm, { timeout: 2_000 });
      return () => cancelIdleCallback(id);
    }
    const timer = setTimeout(warm, 300);
    return () => clearTimeout(timer);
  }, [workerPool]);

  return null;
}

function DiffWorkerThemeSync({ themeName }: { themeName: DiffThemeName }) {
  const workerPool = useWorkerPool();

  useEffect(() => {
    if (!workerPool) {
      return;
    }

    let operation: DiffWorkerError["operation"] = "get-render-options";
    void (async () => {
      try {
        const current = workerPool.getDiffRenderOptions();
        if (current.theme === themeName) {
          return;
        }

        operation = "set-render-options";
        await workerPool.setRenderOptions({
          ...current,
          theme: themeName,
        });
      } catch (cause) {
        console.error(new DiffWorkerError({ operation, themeName, cause }));
      }
    })();
  }, [themeName, workerPool]);

  return null;
}

export function DiffWorkerPoolProvider({ children }: { children?: ReactNode }) {
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const workerPoolSize = useMemo(() => {
    const cores =
      typeof navigator === "undefined" ? 4 : Math.max(1, navigator.hardwareConcurrency || 4);
    return Math.max(2, Math.min(6, Math.floor(cores / 2)));
  }, []);

  return (
    <WorkerPoolContextProvider
      poolOptions={{
        workerFactory: () => {
          try {
            return new DiffsWorker();
          } catch (cause) {
            throw new DiffWorkerError({
              operation: "create-worker",
              themeName: diffThemeName,
              cause,
            });
          }
        },
        poolSize: workerPoolSize,
        totalASTLRUCacheSize: 240,
      }}
      highlighterOptions={{
        theme: diffThemeName,
        tokenizeMaxLineLength: 1_000,
        useTokenTransformer: true,
      }}
    >
      <DiffWorkerPoolWarmup />
      <DiffWorkerThemeSync themeName={diffThemeName} />
      {children}
    </WorkerPoolContextProvider>
  );
}
