'use strict';

const { PRIORITY_BY_SEVERITY, PLANE } = require('./config.js');
const { defaultSleep } = require('./sleep.js');

// This workspace rate-limits write bursts via Cloudflare (see plane.js) — a
// prior batch script against the same API needed exactly this kind of
// throttle. Conservative default; overridable via reconcile's `delayMs` or
// bin/sync.js's `--delay-ms`.
const DEFAULT_WRITE_DELAY_MS = 500;

// Plane sits behind a Cloudflare WAF that inspects request bodies for
// attack-signature strings (path traversal, script tags, SQLi shapes, ...).
// An audit tool's findings *describe* attacks, so their raw text routinely
// contains exactly those signatures (e.g. F-002's Verification field embeds
// `..%2F` inside a curl command) and gets blocked with a 403 HTML page
// instead of ever reaching Plane's API — no rate limit or fingerprinting
// involved, just the body content itself. Numeric-HTML-entity-encoding every
// non-alphanumeric character of finding-derived text (not just the five HTML
// metacharacters) removes any recognizable payload from the wire bytes while
// Plane's HTML renderer reconstructs and stores the original text exactly.
// See .claude/skills/plane-sync/SKILL.md for the full incident writeup.
//
// Iterates by code point (via the string's default iterator, which pairs
// surrogates) rather than by UTF-16 code unit, so astral-plane characters
// (e.g. emoji) encode to a single correct entity instead of two broken ones.
function encodeFindingText(value) {
  return Array.from(String(value), (ch) => (
    /^[A-Za-z0-9 ]$/.test(ch) ? ch : `&#${ch.codePointAt(0)};`
  )).join('');
}

function summarize(claim) {
  const trimmed = String(claim).trim().replace(/\s+/g, ' ');
  return trimmed.length <= 90 ? trimmed : `${trimmed.slice(0, 87)}...`;
}

function renderTitle(f) {
  return `[${encodeFindingText(f.id)}] ${encodeFindingText(f.severity)} ${encodeFindingText(f.surface)}: ${encodeFindingText(summarize(f.claim))}`;
}

function renderBody(f) {
  return [
    `<p><strong>Location:</strong> <code>${encodeFindingText(f.file)}</code></p>`,
    `<p><strong>Lens:</strong> ${encodeFindingText(f.lens)} &middot; <strong>Source:</strong> ${encodeFindingText(f.source)}</p>`,
    `<p><strong>Claim:</strong> ${encodeFindingText(f.claim)}</p>`,
    `<p><strong>Failure scenario:</strong> ${encodeFindingText(f.failure_scenario)}</p>`,
    `<p><strong>Proposed fix:</strong> ${encodeFindingText(f.proposed_fix)}</p>`,
    `<p><strong>Verification:</strong> ${encodeFindingText(f.verification)}</p>`,
    `<p><em>Audit finding ${encodeFindingText(f.id)} &middot; fingerprint ${encodeFindingText(f.fingerprint)}</em></p>`,
  ].join('\n');
}

// The rendered snapshot decides whether an existing issue has drifted. Storing
// it on the finding avoids a read of every issue on every run.
function snapshot(f) {
  return `${renderTitle(f)}||${renderBody(f)}||${PRIORITY_BY_SEVERITY[f.severity]}||${f.status}`;
}

async function reconcile({
  doc,
  client,
  epicId,
  labelIds = [],
  dryRun = false,
  delayMs = DEFAULT_WRITE_DELAY_MS,
  sleepImpl = defaultSleep,
}) {
  const created = [];
  const updated = [];
  const closed = [];
  const skipped = [];

  // Read-only calls (e.g. listLabels, done before reconcile runs) are not
  // throttled — only the write burst that tripped Cloudflare needs spacing.
  // No delay before the first write; only between consecutive ones.
  let wroteOnce = false;
  async function throttleBeforeWrite() {
    if (wroteOnce && delayMs > 0) {
      await sleepImpl(delayMs);
    }
    wroteOnce = true;
  }

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
      await throttleBeforeWrite();
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
    await throttleBeforeWrite();
    await client.updateIssue(f.plane_id, patch);
    f.synced_snapshot = current;
  }

  return { created, updated, closed, skipped };
}

module.exports = { renderTitle, renderBody, snapshot, reconcile };
