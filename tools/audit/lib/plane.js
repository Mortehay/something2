'use strict';

const { PLANE } = require('./config.js');
const { defaultSleep } = require('./sleep.js');
const { createCurlTransport } = require('./curl-transport.js');

// Cloudflare's block page (the one that ambushed the first live sync — Ray ID
// a203d1cb8fb85b5a) is HTML containing one of these markers. A genuine Plane
// authorization failure is always JSON. We only retry the former: retrying a
// bad API key for a minute would just hide a misconfiguration behind a slow,
// confusing failure.
//
// Root cause (confirmed by experiment, not guesswork): Cloudflare fingerprints
// the HTTP client's TLS/HTTP2 handshake, not the User-Agent header and not
// request rate. An identical write issued by real `curl` succeeded (201) at
// the same instant Node's `fetch` was blocked (403 HTML) from the same
// machine, same key. Reads (GET) pass through fetch fine, which is why the
// failure looks intermittent rather than structural. The fix is transport,
// not headers or backoff: writes go through real curl (see
// ./curl-transport.js and the default `fetchImpl` below). This retry/backoff
// logic stays as cheap insurance regardless.
const BLOCK_PAGE_MARKERS = [/cloudflare/i, /Ray ID/i, /Attention Required/i, /cf-error/i];

function looksLikeBlockPage(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || !/^<(!doctype|html)/i.test(trimmed)) return false;
  return BLOCK_PAGE_MARKERS.some((re) => re.test(trimmed));
}

class PlaneClient {
  constructor({
    apiKey,
    // Real curl by default — see the root-cause note above. Tests (and any
    // other caller that needs to stay offline) inject a fake `fetchImpl`
    // here; it only needs to match the small fetch-like surface `request()`
    // calls: (url, { method, headers, body }) => { ok, status, text() }.
    fetchImpl = createCurlTransport(),
    plane = PLANE,
    sleepImpl = defaultSleep,
    maxAttempts = 4,
    retryBaseMs = 1000,
  } = {}) {
    if (!apiKey) throw new Error('PlaneClient requires an apiKey');
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.plane = plane;
    this.sleepImpl = sleepImpl;
    this.maxAttempts = maxAttempts;
    this.retryBaseMs = retryBaseMs;
    this.projectRoot =
      `${plane.baseUrl}/workspaces/${plane.workspace}/projects/${plane.projectId}`;
  }

  async request(pathname, { method = 'GET', body } = {}) {
    const url = pathname.startsWith('http') ? pathname : `${this.projectRoot}${pathname}`;
    let attempt = 0;

    for (;;) {
      attempt += 1;
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          'X-API-Key': this.apiKey,
          'Content-Type': 'application/json',
          // Cloudflare 403s the default Node UA. Do not remove.
          'User-Agent': this.plane.userAgent,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      const text = await response.text();
      if (response.ok) {
        return text ? JSON.parse(text) : null;
      }

      // 429 is unambiguous — Plane/Cloudflare are never rate-limiting a genuine
      // authz failure with that status. A 403 is ambiguous, so only treat it as
      // retryable when the body is the Cloudflare block page rather than JSON.
      const retryable = response.status === 429 || (response.status === 403 && looksLikeBlockPage(text));

      if (!retryable) {
        throw new Error(`Plane ${method} ${url} failed: ${response.status} ${text}`);
      }
      if (attempt >= this.maxAttempts) {
        throw new Error(
          `Plane ${method} ${url} failed after ${attempt} attempts (rate-limited, giving up): ${response.status} ${text}`
        );
      }

      const delay = this.retryBaseMs * 2 ** (attempt - 1);
      await this.sleepImpl(delay);
    }
  }

  async paginate(pathname) {
    const out = [];
    let cursor = null;
    do {
      const sep = pathname.includes('?') ? '&' : '?';
      const page = await this.request(cursor ? `${pathname}${sep}cursor=${cursor}` : pathname);
      out.push(...(page.results || []));
      cursor = page.next_page_results ? page.next_cursor : null;
    } while (cursor);
    return out;
  }

  listLabels() {
    return this.paginate('/labels/');
  }

  createLabel({ name, description = '', color = '#64748b' }) {
    return this.request('/labels/', { method: 'POST', body: { name, description, color } });
  }

  listIssues({ labelId } = {}) {
    return this.paginate(labelId ? `/issues/?labels=${labelId}` : '/issues/');
  }

  createIssue(body) {
    return this.request('/issues/', { method: 'POST', body });
  }

  updateIssue(id, patch) {
    return this.request(`/issues/${id}/`, { method: 'PATCH', body: patch });
  }

  async deleteIssue(id) {
    await this.request(`/issues/${id}/`, { method: 'DELETE' });
  }
}

module.exports = { PlaneClient, looksLikeBlockPage };
