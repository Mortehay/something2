'use strict';

const { PRIORITY_BY_SEVERITY, PLANE } = require('./config.js');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function summarize(claim) {
  const trimmed = String(claim).trim().replace(/\s+/g, ' ');
  return trimmed.length <= 90 ? trimmed : `${trimmed.slice(0, 87)}...`;
}

function renderTitle(f) {
  return `[${f.id}] ${f.severity} ${f.surface}: ${summarize(f.claim)}`;
}

function renderBody(f) {
  return [
    `<p><strong>Location:</strong> <code>${escapeHtml(f.file)}</code></p>`,
    `<p><strong>Lens:</strong> ${escapeHtml(f.lens)} &middot; <strong>Source:</strong> ${escapeHtml(f.source)}</p>`,
    `<p><strong>Claim:</strong> ${escapeHtml(f.claim)}</p>`,
    `<p><strong>Failure scenario:</strong> ${escapeHtml(f.failure_scenario)}</p>`,
    `<p><strong>Proposed fix:</strong> ${escapeHtml(f.proposed_fix)}</p>`,
    `<p><strong>Verification:</strong> ${escapeHtml(f.verification)}</p>`,
    `<p><em>Audit finding ${escapeHtml(f.id)} &middot; fingerprint ${escapeHtml(f.fingerprint)}</em></p>`,
  ].join('\n');
}

// The rendered snapshot decides whether an existing issue has drifted. Storing
// it on the finding avoids a read of every issue on every run.
function snapshot(f) {
  return `${renderTitle(f)}||${renderBody(f)}||${PRIORITY_BY_SEVERITY[f.severity]}||${f.status}`;
}

async function reconcile({ doc, client, epicId, labelIds = [], dryRun = false }) {
  const created = [];
  const updated = [];
  const closed = [];
  const skipped = [];

  for (const f of doc.findings) {
    if (f.status === 'unverified') {
      skipped.push(f.id);
      continue;
    }

    if (!f.plane_id) {
      const isFixed = f.status === 'fixed';
      if (isFixed) {
        closed.push(f.id);
      } else {
        created.push(f.id);
      }
      if (dryRun) continue;
      const payload = {
        name: renderTitle(f),
        description_html: renderBody(f),
        priority: PRIORITY_BY_SEVERITY[f.severity],
        labels: labelIds,
        parent: epicId,
      };
      if (isFixed) {
        payload.state = PLANE.doneStateId;
      }
      const issue = await client.createIssue(payload);
      f.plane_id = issue.id;
      f.plane_key = issue.sequence_id ? `SOMET-${issue.sequence_id}` : undefined;
      f.synced_snapshot = snapshot(f);
      continue;
    }

    const current = snapshot(f);
    if (current === f.synced_snapshot) continue;

    const patch = {
      name: renderTitle(f),
      description_html: renderBody(f),
      priority: PRIORITY_BY_SEVERITY[f.severity],
    };
    if (f.status === 'fixed') {
      patch.state = PLANE.doneStateId;
      closed.push(f.id);
    } else {
      updated.push(f.id);
    }

    if (dryRun) continue;
    await client.updateIssue(f.plane_id, patch);
    f.synced_snapshot = current;
  }

  return { created, updated, closed, skipped };
}

module.exports = { renderTitle, renderBody, snapshot, reconcile };
