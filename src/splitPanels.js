// The draggable divider between the map and the time series chart.
//
// The two panels are a flex column: the map takes whatever is left (flex: 1)
// and the chart panel is pinned to `--chart-panel-size` on the container, so a
// drag only ever writes one CSS custom property and the browser does the rest.
// Nothing here measures or resizes the map or the chart: the ArcGIS view and
// Chart.js both watch their own containers, so they follow the split on their
// own.
//
// The chart panel is hidden entirely in the whole-world view, and the divider
// has to disappear with it — otherwise it sits at the bottom of the map as a
// grab handle for a panel that isn't there. setChartVisible() is the one switch
// that moves both.
import {CHART_PANEL_MAX_PERCENT, CHART_PANEL_MIN_PERCENT, CHART_PANEL_PERCENT} from "./settings.js";

// Where the user last left the divider. Deliberately per-device rather than
// per-deployment: .env sets the height the app *ships* with, this remembers the
// height this person prefers. Double-clicking the divider clears it.
const STORAGE_KEY = "ggg-chart-panel-percent";
// Arrow-key step, in percentage points of the column height.
const KEYBOARD_STEP = 2;

const clampPercent = (pct) => Math.min(Math.max(pct, CHART_PANEL_MIN_PERCENT), CHART_PANEL_MAX_PERCENT);

const readStored = () => {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0 ? clampPercent(stored) : null;
  } catch {
    return null; // private mode / storage disabled — fall back to the .env default
  }
};

const writeStored = (pct) => {
  try {
    localStorage.setItem(STORAGE_KEY, String(Math.round(pct * 10) / 10));
  } catch { /* not being able to remember the size is not worth an error */ }
};

const clearStored = () => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* see writeStored */ }
};

/**
 * Wire the divider. Returns {setChartVisible(visible)} — the only way the rest
 * of the app should show or hide the chart panel, so the divider stays in sync.
 */
export function initPanelSplitter({stack, chartPanel, splitter}) {
  let percent = readStored() ?? CHART_PANEL_PERCENT;

  const apply = (next, {persist = false} = {}) => {
    percent = clampPercent(next);
    stack.style.setProperty("--chart-panel-size", `${percent}%`);
    splitter.setAttribute("aria-valuenow", String(Math.round(percent)));
    if (persist) writeStored(percent);
  };

  apply(percent);
  splitter.setAttribute("aria-valuemin", String(Math.round(CHART_PANEL_MIN_PERCENT)));
  splitter.setAttribute("aria-valuemax", String(Math.round(CHART_PANEL_MAX_PERCENT)));

  // Pointer events (not mouse events) so a touch or pen drag works identically,
  // and pointer capture so the drag keeps tracking once the cursor crosses into
  // the map — the ArcGIS view would otherwise swallow the move events and start
  // panning the map instead.
  let startY = 0;
  let startHeight = 0;

  splitter.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    startY = event.clientY;
    startHeight = chartPanel.getBoundingClientRect().height;
    splitter.setPointerCapture(event.pointerId);
    document.body.classList.add("panel-resizing");
    event.preventDefault(); // no text selection, no native drag
  });

  splitter.addEventListener("pointermove", (event) => {
    if (!splitter.hasPointerCapture(event.pointerId)) return;
    const stackHeight = stack.getBoundingClientRect().height;
    if (!stackHeight) return;
    // Dragging up (a smaller clientY) grows the chart, which is why the delta
    // is subtracted rather than added.
    apply(((startHeight - (event.clientY - startY)) / stackHeight) * 100);
  });

  const endDrag = (event) => {
    if (!splitter.hasPointerCapture(event.pointerId)) return;
    splitter.releasePointerCapture(event.pointerId);
    document.body.classList.remove("panel-resizing");
    writeStored(percent);
  };
  splitter.addEventListener("pointerup", endDrag);
  splitter.addEventListener("pointercancel", endDrag);

  // Back to the height this deployment ships with.
  splitter.addEventListener("dblclick", () => {
    clearStored();
    apply(CHART_PANEL_PERCENT);
  });

  // A separator that can only be dragged is unusable without a mouse, so the
  // same adjustment is on the arrow keys, with Home restoring the default.
  splitter.addEventListener("keydown", (event) => {
    const step = {ArrowUp: KEYBOARD_STEP, ArrowDown: -KEYBOARD_STEP, PageUp: KEYBOARD_STEP * 4, PageDown: -KEYBOARD_STEP * 4}[event.key];
    if (step !== undefined) {
      apply(percent + step, {persist: true});
    } else if (event.key === "Home") {
      clearStored();
      apply(CHART_PANEL_PERCENT);
    } else {
      return;
    }
    event.preventDefault();
  });

  return {
    setChartVisible(visible) {
      chartPanel.classList.toggle("hidden", !visible);
      splitter.classList.toggle("hidden", !visible);
    },
  };
}
