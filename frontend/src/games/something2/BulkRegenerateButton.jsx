// "Regenerate all tiles" / "Regenerate all entities" for the admin registries.
//
// The run is server-side and survives this component unmounting, so everything
// here reads from one polled endpoint rather than from local state. Switching
// tabs mid-run and coming back shows the same progress.
//
// Sprites are never touched: the server generates single images only. The
// wording says so, because "regenerate all" is exactly the phrase an admin
// would expect to blow away animation work.
import { useState } from "react";
import styled from "styled-components";
import { HiOutlineArrowPath, HiOutlineXMark } from "react-icons/hi2";
import {
  useBulkImageRun, useStartBulkImageRun, useCancelBulkImageRun,
} from "./useBulkImageJob.js";
import { runViewState, confirmMessage } from "./bulkRegenerateView.js";

const Wrap = styled.div`
  display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;
`;

const Button = styled.button`
  background: ${p => p.$danger ? "var(--s2-danger, #e5484d)" : "var(--s2-surface-raised)"};
  color: var(--s2-text); border: 1px solid var(--s2-border); border-radius: 6px;
  padding: 0.5rem 1rem; font-weight: bold; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px;
  &:disabled { opacity: 0.5; cursor: default; }
`;

const Panel = styled.div`
  display: flex; align-items: center; gap: 0.75rem;
  background: var(--s2-surface-raised); border: 1px solid var(--s2-border);
  border-radius: 6px; padding: 0.5rem 0.75rem;
`;

const Bar = styled.div`
  width: 160px; height: 6px; border-radius: 3px; overflow: hidden;
  background: color-mix(in srgb, var(--s2-text) 15%, transparent);
  div { height: 100%; background: var(--s2-accent); transition: width 0.4s ease; }
`;

const Note = styled.span`
  color: var(--s2-text-secondary); font-size: 1.2rem;
`;

const Checkbox = styled.label`
  color: var(--s2-text-secondary); font-size: 1.2rem;
  display: inline-flex; align-items: center; gap: 4px; cursor: pointer;
`;

// `kind` is what the server understands ('tiles' | 'entities'); `noun` is what
// the admin reads.
export default function BulkRegenerateButton({
  kind, noun, count, countIncludingRect, offerIncludeRect = false,
}) {
  const [includeRect, setIncludeRect] = useState(false);
  const { run } = useBulkImageRun();
  const start = useStartBulkImageRun();
  const cancel = useCancelBulkImageRun();

  // Every "what should this show" decision lives in bulkRegenerateView.js,
  // where it is tested. A run of the OTHER kind blocks this one -- one remote
  // box, one run -- so the button says why instead of failing on click.
  const view = runViewState(run, kind);

  const onStart = () => {
    if (!window.confirm(confirmMessage({ count, countIncludingRect, noun, includeRect }))) return;
    start.mutate({ kind, include_rect: includeRect });
  };

  if (view.mode === "running") {
    return (
      <Panel>
        <Bar><div style={{ width: `${view.percent}%` }} /></Bar>
        <Note>
          {view.handled}/{view.total}
          {view.currentName ? ` · ${view.currentName}` : ""}
          {view.failed > 0 ? ` · ${view.failed} failed` : ""}
        </Note>
        <Button
          $danger
          onClick={() => cancel.mutate()}
          disabled={cancel.isPending || view.cancelling}
        >
          <HiOutlineXMark /> {view.cancelling ? "Stopping…" : "Stop"}
        </Button>
      </Panel>
    );
  }

  return (
    <Wrap>
      {offerIncludeRect && (
        <Checkbox title="Types that currently draw as a plain colour box have never had art. Including them changes how they look in game.">
          <input
            type="checkbox"
            checked={includeRect}
            onChange={e => setIncludeRect(e.target.checked)}
          />
          include colour-box types
        </Checkbox>
      )}
      <Button
        onClick={onStart}
        disabled={start.isPending || view.mode === "busy-elsewhere"}
      >
        <HiOutlineArrowPath />
        {view.mode === "busy-elsewhere"
          ? `Busy: ${view.otherKind}`
          : `Regenerate all ${noun}`}
      </Button>
      {view.mode === "finished" && (
        <Note>
          {view.stopped ? "Stopped" : "Finished"}: {view.done} done
          {view.failed > 0 ? `, ${view.failed} failed` : ""}
          {view.skipped.length > 0
            // Named in the title attribute rather than the line: these are the
            // types the admin has to go and pin to a provider, and a bare
            // count would not tell them which.
            ? <span title={view.skipped.map(s => s.name).join(", ")}>
              , {view.skipped.length} skipped (no AI provider)
            </span>
            : null}
          {view.error ? ` — ${view.error}` : ""}
        </Note>
      )}
    </Wrap>
  );
}
