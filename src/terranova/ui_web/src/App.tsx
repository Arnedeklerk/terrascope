import { useEffect, useState } from "react";
import { Welcome } from "./panels/Welcome";
import { CatalogSearch } from "./panels/CatalogSearch";
import { Classify } from "./panels/Classify";
import { Accuracy } from "./panels/Accuracy";
import { TimeSeries } from "./panels/TimeSeries";
import { Cdse } from "./panels/Cdse";
import { Sam } from "./panels/Sam";
import { Foundation } from "./panels/Foundation";
import { CommandPalette } from "./panels/CommandPalette";
import { TelemetryConsent } from "./panels/TelemetryConsent";
import { useHotkey } from "./hooks/useHotkey";
import { useUiStore } from "./store/useUiStore";

/**
 * Root of the embedded React panel.
 *
 * View-switching is local (Zustand store).  The Cmd/Ctrl+K palette overlays
 * regardless of which view is mounted.
 */
// Stable (default-visible) vs. beta workflows.  The beta ones depend
// on heavier (and less-stable) dependencies (TerraTorch, segment-
// geospatial, BFAST, the CDSE OAuth flow), so hiding them by default
// keeps the dock approachable for new users without removing the
// capability for power users.
const STABLE_TABS = ["welcome", "catalog", "classify", "accuracy"] as const;
const BETA_TABS = ["timeseries", "sam", "foundation", "cdse"] as const;
const BETA_TABS_SET = new Set<string>(BETA_TABS);

export function App() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [showBeta, setShowBeta] = useState(false);
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);

  useHotkey(["Meta+k", "Control+k"], () => setPaletteOpen((v) => !v));
  useHotkey(["Escape"], () => setPaletteOpen(false));

  // If the user toggles beta off while sitting on a beta tab, bounce
  // them to Welcome so the panel doesn't render content for a tab
  // that no longer exists in the nav.
  useEffect(() => {
    if (!showBeta && BETA_TABS_SET.has(view)) setView("welcome");
  }, [showBeta, view, setView]);

  // Body-scroll position survives across tab switches because the
  // browser doesn't reset it on DOM tree changes.  That's jarring
  // (you land mid-page on a different panel).  Snap to top whenever
  // the active view changes.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [view]);

  const visibleTabs = showBeta
    ? [...STABLE_TABS, ...BETA_TABS]
    : [...STABLE_TABS];

  return (
    // No more inner scroll container.  The document body itself scrolls
    // natively — that's the fastest scroll path the browser offers, and
    // on HiDPI laptops where the previous overflow:auto inner scroller
    // forced re-rasterisation per frame, this is the meaningful fix.
    // Header is position: sticky so it stays pinned during the scroll.
    <div className="flex flex-col">
      <header
        // sticky pinned at the top.  Background is opaque (bg-bg-0)
        // so panel content scrolling underneath doesn't bleed through.
        className="sticky top-0 z-20 bg-bg-0 px-6 py-4 border-b border-bg-2 flex items-baseline gap-3"
      >
        <h1 className="text-lg font-semibold tracking-tight">Terranova</h1>
        <span className="text-fg-muted text-xs">Earth observation for QGIS</span>

        <nav className="ml-6 flex gap-1 text-xs flex-wrap">
          {visibleTabs.map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={
                "px-2.5 py-1 rounded " +
                (view === v
                  ? "bg-bg-2 text-fg"
                  : "text-fg-muted hover:text-fg hover:bg-bg-1")
              }
            >
              {v}
              {BETA_TABS_SET.has(v) && (
                <span className="ml-1 text-fg-muted/60 text-[10px]">β</span>
              )}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3 text-xs text-fg-muted">
          <label
            className="flex items-center gap-1.5 cursor-pointer select-none"
            title="Toggle in-development tabs (time-series, SAM, foundation models, CDSE)."
          >
            <input
              type="checkbox"
              checked={showBeta}
              onChange={(e) => setShowBeta(e.target.checked)}
            />
            <span>Beta features</span>
          </label>
          <span>
            <kbd className="px-1.5 py-0.5 bg-bg-1 rounded">Ctrl K</kbd>
            <span className="ml-2">commands</span>
          </span>
        </div>
      </header>

      <main className="p-6">
        {view === "welcome" && <Welcome />}
        {view === "catalog" && <CatalogSearch />}
        {view === "classify" && <Classify />}
        {view === "accuracy" && <Accuracy />}
        {view === "timeseries" && <TimeSeries />}
        {view === "sam" && <Sam />}
        {view === "foundation" && <Foundation />}
        {view === "cdse" && <Cdse />}
      </main>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <TelemetryConsent />
    </div>
  );
}
