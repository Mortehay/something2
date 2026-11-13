// Images admin tab: every game image with its web-copy state, batch/per-row Shrink and Undo,
// Reactivate, run progress and the operation log. Admin only. Values from the backend render
// as text children, never markup. Rows are paginated and previews lazy-loaded so ~1600 rows are cheap.
import { useMemo, useState } from 'react';
import styled from 'styled-components';
import toast from 'react-hot-toast';
import { Badge, Muted, Btn, fmtTime } from './seedUi.jsx';
import AdminLoading from './AdminLoading.jsx';
import { API_URL } from '../../config.js';
import { assetUrl } from './src/js/net/assets.js';
import { useImages, useImageKinds, useImageRun, useImageOperations, useImageActions } from './useImages.js';
import { useGameSettings, useUpdateGameSetting } from './useGameSettings.js';
import {
  isSheet, estimateWebBytes, formatBytes, subjectId, pagesOf, canShrink, canUndo, canReactivate, runBody, buildParams,
  overrideByKind, opLabel, autoShrinkOn,
} from './imagesModel.js';

const PAGE_SIZE = 50;
const STATE_TONE = { original: undefined, shrunk: 'ok', stale: 'warn', undone: 'info' };

const Page = styled.div`
  padding: 2rem; color: var(--s2-text); max-width: 1300px; margin: 0 auto;
  height: 100%; overflow-y: auto; background-color: var(--s2-surface);
`;
const Row = styled.div`display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: center;`;
const Filters = styled(Row)`margin: 0.8rem 0; font-size: 1.3rem;`;
const Field = styled.input`
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 6px; padding: 0.3rem 0.5rem; font-size: 1.3rem; width: 8rem;
`;
const Select = styled.select`
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 6px; padding: 0.3rem 0.5rem; font-size: 1.3rem;
`;
const Table = styled.table`
  width: 100%; border-collapse: collapse; font-size: 1.3rem;
  th, td { text-align: left; vertical-align: middle; padding: 0.35rem 0.5rem; border-top: 1px solid var(--s2-border); }
  th { color: var(--s2-text-muted); font-weight: 600; }
`;
const Thumb = styled.img`
  width: 48px; height: 48px; object-fit: contain; background: var(--s2-bg-sunken);
  border: 1px solid var(--s2-border); border-radius: 4px;
`;
const Bar = styled.div`
  position: sticky; bottom: 0; margin-top: 0.8rem; padding: 0.6rem 0.9rem; border: 1px solid var(--s2-border);
  border-radius: 8px; background: var(--s2-surface-raised); font-size: 1.4rem;
  display: flex; gap: 0.8rem; flex-wrap: wrap; align-items: center;
`;
const Panel = styled.div`
  padding: 0.6rem 0.9rem; margin: 0.6rem 0; border: 1px solid var(--s2-border); border-radius: 8px;
  background: var(--s2-surface-raised); font-size: 1.4rem;
`;
const Err = styled.p`margin: 0.4rem 0; color: var(--s2-danger); font-size: 1.3rem;`;
const Progress = styled.progress`width: 14rem; accent-color: var(--s2-accent);`;

const STATES = ['original', 'shrunk', 'stale', 'undone'];
const rowAction = (row) => (row.state === 'stale' ? 'Re-shrink' : 'Shrink');

function paramsText(params) {
  if (!params) return '';
  return [params.maxEdge != null && `${params.maxEdge} px`, params.scale != null && `scale ${params.scale}`,
    params.quality != null && `q${params.quality}`].filter(Boolean).join(', ');
}

// The override editor shared by the footer (batch) and a row's Shrink menu.
function Override({ rows, form, setForm }) {
  const needEdge = rows.some((r) => !isSheet(r.kind));
  const needScale = rows.some((r) => isSheet(r.kind));
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <Row>
      {needEdge && <label>maxEdge <Field aria-label="maxEdge" inputMode="numeric" placeholder="preset" value={form.maxEdge || ''} onChange={set('maxEdge')} /></label>}
      {needScale && <label>scale <Field aria-label="scale" inputMode="decimal" placeholder="preset" value={form.scale || ''} onChange={set('scale')} /></label>}
      <label>quality <Field aria-label="quality" inputMode="numeric" placeholder="preset" value={form.quality || ''} onChange={set('quality')} /></label>
    </Row>
  );
}

function Preview({ row }) {
  const v = row.variant;
  const webKey = v?.active ? (v.web_key || v.web_sprite?.atlas_key) : null;
  return (
    <Row style={{ flexWrap: 'nowrap', gap: '0.3rem' }}>
      {row.original_key ? <Thumb loading="lazy" decoding="async" alt="original" title="original" src={assetUrl(API_URL, row.original_key)} /> : <Muted>—</Muted>}
      {webKey && <Thumb loading="lazy" decoding="async" alt="web copy" title="web copy" src={assetUrl(API_URL, webKey)} />}
    </Row>
  );
}

function ImageRow({ row, selected, onToggle, labels, busy, onShrink, onUndo, onReactivate }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({});
  const v = row.variant;
  const px = v?.web_width && v?.web_height ? `${v.web_width}×${v.web_height}` : '—';
  const sid = row.served_by ? `${row.served_by.table}\u0000${row.served_by.key}\u0000${row.served_by.column}` : null;
  const other = sid && sid !== subjectId(row) ? (labels.get(sid) || `${row.served_by.table}/${row.served_by.key}`) : null;
  const submit = () => {
    const { params, error } = buildParams([row], form);
    if (error) { toast.error(error); return; }
    onShrink(row, params);
    setOpen(false);
  };
  return (
    <>
      <tr>
        <td><input type="checkbox" aria-label={`select ${row.label}`} checked={selected} onChange={() => onToggle(row)} /></td>
        <td><Preview row={row} /></td>
        <td>{row.label}<br /><Muted>{row.kind}</Muted></td>
        <td>{formatBytes(row.bytes)}{v?.active && v.web_bytes != null && <><br /><Muted>→ {formatBytes(v.web_bytes)}</Muted></>}</td>
        <td>{px}</td>
        <td>
          <Badge $tone={STATE_TONE[row.state]}>{row.state}</Badge>
          {other && <><br /><Muted>served by {other}</Muted></>}
        </td>
        <td>
          <Row>
            {canShrink(row) && <Btn disabled={busy} onClick={() => setOpen(!open)} aria-expanded={open}>{rowAction(row)} ▾</Btn>}
            {canUndo(row) && <Btn disabled={busy} onClick={() => onUndo(row)}>Undo</Btn>}
            {canReactivate(row) && <Btn disabled={busy} onClick={() => onReactivate(row)}>Reactivate</Btn>}
          </Row>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7}>
            <Row>
              <Muted>preset {paramsText(v?.params) || 'default for this kind'}; override:</Muted>
              <Override rows={[row]} form={form} setForm={setForm} />
              <Btn $primary disabled={busy} onClick={submit}>{rowAction(row)}</Btn>
            </Row>
          </td>
        </tr>
      )}
    </>
  );
}

function History() {
  const [batch, setBatch] = useState('');
  const valid = batch === '' || /^[0-9a-f-]{36}$/i.test(batch);
  const { data, isLoading, error } = useImageOperations(valid ? batch : '', true);
  const ops = Array.isArray(data) ? data : [];
  return (
    <Panel>
      <Row>
        <label>Batch <Field aria-label="batch filter" style={{ width: '24rem' }} placeholder="batch id (all)" value={batch} onChange={(e) => setBatch(e.target.value.trim())} /></label>
        {!valid && <Err role="alert">Not a batch id</Err>}
      </Row>
      {isLoading && <AdminLoading />}
      {error && <Err role="alert">{error.message}</Err>}
      {!isLoading && ops.length === 0 && <Muted>No operations yet</Muted>}
      {ops.length > 0 && (
        <Table>
          <thead><tr><th>When</th><th>Op</th><th>Image</th><th>Size</th><th>Result</th><th>Batch</th></tr></thead>
          <tbody>
            {ops.map((o) => (
              <tr key={o.id}>
                <td>{fmtTime(o.created_at)}</td>
                <td>{opLabel(o)}</td>
                <td>{o.subject_table}/{o.subject_key} <Muted>{o.subject_column}</Muted></td>
                <td>{formatBytes(o.bytes_before)} → {formatBytes(o.bytes_after)}</td>
                <td><Badge $tone={o.status === 'ok' ? 'ok' : 'bad'}>{o.status}</Badge>{o.error && <><br /><Muted>{String(o.error)}</Muted></>}</td>
                <td>{o.batch_id ? <Btn onClick={() => setBatch(o.batch_id)} title="Filter by this batch">{String(o.batch_id).slice(0, 8)}</Btn> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

export default function ImagesAdmin() {
  const [kind, setKind] = useState('');
  const [state, setState] = useState('');
  const [minKb, setMinKb] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState(() => new Set());
  const [form, setForm] = useState({});
  const [showHistory, setShowHistory] = useState(false);
  const minBytes = Math.max(0, Number(minKb) || 0) * 1000;

  const { data, isLoading, error } = useImages({ kind, state, minBytes });
  const kinds = useImageKinds();
  const run = useImageRun();
  const { startRun, cancel, reactivate } = useImageActions();

  const rows = useMemo(() => (Array.isArray(data) ? data : []), [data]);
  const labels = useMemo(() => new Map(rows.map((r) => [subjectId(r), r.label])), [rows]);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = pagesOf(rows, PAGE_SIZE, safePage);
  const chosen = useMemo(() => rows.filter((r) => selected.has(subjectId(r))), [rows, selected]);
  const running = run.data?.status === 'running';
  const busy = running || startRun.isPending;
  const total = chosen.reduce((n, r) => n + (Number.isFinite(r.bytes) ? r.bytes : 0), 0);
  const preset = useMemo(() => {
    const ks = [...new Set(chosen.map((r) => r.kind))];
    const defaults = new Map((Array.isArray(kinds.data) ? kinds.data : []).map((k) => [k.kind, k.defaults]));
    return ks.length === 1 ? paramsText(defaults.get(ks[0])) : 'default per kind';
  }, [chosen, kinds.data]);
  const batchParams = buildParams(chosen, form);
  const estimate = estimateWebBytes(chosen, overrideByKind(chosen, batchParams.params));
  const { settings, isLoadingSettings } = useGameSettings();
  const updateSetting = useUpdateGameSetting();
  const autoOn = autoShrinkOn(settings);

  const toggle = (row) => setSelected((s) => {
    const n = new Set(s);
    const id = subjectId(row);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const setFilter = (fn) => (e) => { fn(e.target.value); setPage(0); setSelected(new Set()); };
  const start = (op, list, params) => startRun.mutate(runBody(op, list, params), {
    onSuccess: () => toast.success(`${op === 'undo' ? 'Undo' : 'Shrink'} started for ${list.length}`),
  });

  return (
    <Page>
      <h2>Images</h2>
      <Row>
        <label title="New and regenerated art gets a web copy automatically. An image you undid is never shrunk again automatically. Cancelling an auto run pauses auto-shrink for 10 minutes.">
          <input type="checkbox" aria-label="Auto-shrink new art" checked={autoOn}
            disabled={isLoadingSettings || updateSetting.isPending}
            onChange={(e) => updateSetting.mutate({ key: 'image_auto_shrink', value: e.target.checked })} />
          {' '}Auto-shrink new art
        </label>
      </Row>
      <Filters>
        <label>Kind <Select aria-label="kind" value={kind} onChange={setFilter(setKind)}>
          <option value="">all</option>
          {(Array.isArray(kinds.data) ? kinds.data : []).map((k) => <option key={k.kind} value={k.kind}>{k.kind}</option>)}
        </Select></label>
        <label>State <Select aria-label="state" value={state} onChange={setFilter(setState)}>
          <option value="">all</option>
          {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
        </Select></label>
        <label>Larger than <Field aria-label="min KB" inputMode="numeric" placeholder="0" value={minKb} onChange={setFilter(setMinKb)} /> KB</label>
        <Muted>{rows.length} matching</Muted>
      </Filters>

      {run.data && run.data.status && (
        <Panel role="status" aria-label="run">
          <Row>
            <b>{run.data.op === 'undo' ? 'Undo' : 'Shrink'}{run.data.auto && ' · auto'}</b>
            <Badge $tone={running ? 'info' : run.data.status === 'done' ? 'ok' : 'warn'}>{run.data.status}</Badge>
            <Progress max={run.data.total || 1} value={run.data.done} />
            <span>{run.data.done}/{run.data.total}{run.data.failed > 0 && ` · ${run.data.failed} failed`}</span>
            {running && <Btn onClick={() => cancel.mutate()} disabled={cancel.isPending}>Cancel</Btn>}
            {!running && run.data.finishedAt && <Muted>finished {fmtTime(run.data.finishedAt)}</Muted>}
          </Row>
          {run.data.error && <Err role="alert">Run stopped early: {String(run.data.error)}</Err>}
        </Panel>
      )}

      {isLoading && <AdminLoading />}
      {error && <Err role="alert">{error.message}</Err>}
      {data && rows.length === 0 && <Muted>No images match</Muted>}
      {rows.length > 0 && (
        <Table>
          <thead>
            <tr>
              <th><input type="checkbox" aria-label="select this page"
                checked={visible.length > 0 && visible.every((r) => selected.has(subjectId(r)))}
                onChange={(e) => setSelected((s) => {
                  const n = new Set(s);
                  visible.forEach((r) => (e.target.checked ? n.add(subjectId(r)) : n.delete(subjectId(r))));
                  return n;
                })} /></th>
              <th>Preview</th><th>Name</th><th>Size</th><th>px</th><th>State</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <ImageRow key={subjectId(r)} row={r} labels={labels} busy={busy}
                selected={selected.has(subjectId(r))} onToggle={toggle}
                onShrink={(row, params) => start('shrink', [row], params)}
                onUndo={(row) => start('undo', [row])}
                onReactivate={(row) => reactivate.mutate(row.subject)} />
            ))}
          </tbody>
        </Table>
      )}
      {rows.length > PAGE_SIZE && (
        <Row style={{ margin: '0.6rem 0' }}>
          <Btn disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>Previous</Btn>
          <span>Page {safePage + 1} of {pageCount}</span>
          <Btn disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>Next</Btn>
        </Row>
      )}

      <Bar aria-label="batch">
        <span>Selected {chosen.length} · {formatBytes(total)} → est. ~{formatBytes(estimate)}</span>
        <Muted>preset: {preset || '—'}</Muted>
        <Btn onClick={() => setSelected(new Set(rows.map(subjectId)))} disabled={rows.length === 0}>Select all {rows.length} matching</Btn>
        <Btn onClick={() => setSelected(new Set())} disabled={selected.size === 0}>Clear</Btn>
        {chosen.length > 0 && <Override rows={chosen} form={form} setForm={setForm} />}
        {batchParams.error && <Err role="alert">{batchParams.error}</Err>}
        <Btn $primary disabled={busy || chosen.length === 0 || Boolean(batchParams.error)}
          onClick={() => start('shrink', chosen, batchParams.params)}>Shrink</Btn>
        <Btn disabled={busy || chosen.length === 0} onClick={() => start('undo', chosen)}>Undo</Btn>
      </Bar>

      <Row style={{ margin: '0.8rem 0' }}>
        <Btn onClick={() => setShowHistory(!showHistory)} aria-expanded={showHistory}>History {showHistory ? '▾' : '▸'}</Btn>
      </Row>
      {showHistory && <History />}
    </Page>
  );
}
