// Pure view rules for BulkRegenerateButton. Split out for the same reason
// providerForm.js is split out of SettingsAdmin.jsx: this project has no React
// test renderer, so any logic left inside a component is logic nothing checks.
//
// The one rule worth stating: there is ONE run server-side, shared by both
// registries. So the tiles button has to render sensibly while an ENTITIES run
// is going, and vice versa -- it cannot assume the run it sees is its own.

export function runViewState(run, kind) {
  if (!run) return { mode: "idle" };
  const running = run.status === "running";
  if (running && run.kind !== kind) return { mode: "busy-elsewhere", otherKind: run.kind };
  if (running) {
    const handled = run.done + run.failed;
    return {
      mode: "running",
      handled,
      total: run.total,
      // total is 0 for a run where every subject was skipped. It finishes
      // immediately so this is nearly unreachable, but a NaN width would
      // silently collapse the bar rather than fail loudly.
      percent: run.total > 0 ? Math.round((handled / run.total) * 100) : 0,
      currentName: run.current ? run.current.name : null,
      failed: run.failed,
      cancelling: Boolean(run.cancelling),
    };
  }
  // A finished run belonging to the OTHER registry is not this button's
  // business -- showing "Finished: 308 done" above the tile list would be
  // reporting someone else's work.
  if (run.kind !== kind) return { mode: "idle" };
  return {
    mode: "finished",
    stopped: run.status === "cancelled",
    done: run.done,
    failed: run.failed,
    skipped: run.skipped || [],
    error: run.error || null,
  };
}

// `count` is how many will actually run WITHOUT colour-box types;
// `countIncludingRect` is how many run with them. Showing the catalog total in
// both cases would promise 308 entities and regenerate 194 -- a confirm dialog
// that overstates what it is about to do is worse than none.
export function confirmMessage({ count, countIncludingRect, noun, includeRect }) {
  const scope = includeRect
    ? `all ${countIncludingRect ?? count} ${noun} (including colour-box types)`
    : `${count} ${noun}`;
  return `Regenerate ${scope} through the AI provider?\n\n`
    + "Every image is drawn again and replaces the current one. This can take "
    + "hours and can be stopped at any time.\n\n"
    + "Sprites and animations are not touched.";
}
