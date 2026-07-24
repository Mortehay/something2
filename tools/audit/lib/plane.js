'use strict';

const { PLANE } = require('./config.js');

class PlaneClient {
  constructor({ apiKey, fetchImpl = globalThis.fetch, plane = PLANE }) {
    if (!apiKey) throw new Error('PlaneClient requires an apiKey');
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.plane = plane;
    this.projectRoot =
      `${plane.baseUrl}/workspaces/${plane.workspace}/projects/${plane.projectId}`;
  }

  async request(pathname, { method = 'GET', body } = {}) {
    const url = pathname.startsWith('http') ? pathname : `${this.projectRoot}${pathname}`;
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
    if (!response.ok) {
      throw new Error(`Plane ${method} ${url} failed: ${response.status} ${text}`);
    }
    return text ? JSON.parse(text) : null;
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

module.exports = { PlaneClient };
