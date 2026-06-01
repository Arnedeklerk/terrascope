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

  const visibleTabs = showBeta
    ? [...STABLE_TABS, ...BETA_TABS]
    : [...STABLE_TABS];

  return (
    <div className="min-h-screen flex flex-col">
      <header className="px-6 py-4 border-b border-bg-2 flex items-baseline gap-3">
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

      <main
        className="flex-1 p-6 overflow-auto"
        // Tell QtWebEngine's compositor that this container will scroll
        // — gives it a chance to promote it to its own GPU layer.
        // overscroll-behavior contains scroll chaining so a slow
        // touchpad fling at the bottom doesn't queue up rubber-band
        // events all the way back to QGIS's outer canvas.
        style={{
          willChange: "scroll-position",
          overscrollBehavior: "contain",
        }}
      >
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
