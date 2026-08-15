// SOMET-333: the outbound-request guard for admin-supplied provider URLs.
//
// THE THREAT, stated plainly: this feature lets an admin make the backend
// issue arbitrary HTTP requests to a host of their choosing. That is the
// entire point of the feature -- the image service is on another machine --
// but it means "admin" becomes a role that can reach anything the backend
// container can reach, including other services on the compose network.
//
// This module does NOT try to make that safe by blocking private addresses.
// Doing so would defeat the feature: the target IS a machine on the LAN, and
// http://192.168.1.20:7860 is the expected input. What it does instead is
// remove the classes of surprise the admin did not ask for:
//
//   * schemes that are not HTTP        -- file:, gopher:, ftp: can read local
//                                         files or drive other protocols
//   * credentials embedded in the URL  -- would be sent without ever appearing
//                                         in the auth header fields
//   * silent redirects to a new host   -- a service that 302s elsewhere would
//                                         otherwise carry the auth token to a
//                                         host the admin never configured
//   * unbounded response bodies        -- a hostile or broken service must not
//                                         be able to exhaust this process
//
// Validation happens HERE, at call time, as well as at save time in
// aiProviders.js. Both are necessary: the column can be edited straight in
// psql, so the call site cannot trust what it reads.

const MAX_REDIRECTS = 3;

// Returns null when the URL is acceptable, or a reason string.
function unsafeUrlReason(value) {
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    return 'not an absolute URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `scheme ${url.protocol} is not allowed; use http or https`;
  }
  if (url.username || url.password) {
    return 'credentials embedded in the URL are not allowed';
  }
  return null;
}

function assertSafeUrl(value) {
  const reason = unsafeUrlReason(value);
  if (reason) throw new Error(`refusing to call ${redactUrl(value)}: ${reason}`);
  return value;
}

// Never let a URL that might carry a secret reach a log line or an error
// message verbatim. Query strings are where API keys hide.
function redactUrl(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    if ([...url.searchParams.keys()].length) url.search = '?…';
    return url.toString();
  } catch (_) {
    return '[unparseable url]';
  }
}

// fetch(), with redirects followed by hand so each hop can be re-validated.
//
// The auth header is DROPPED on a cross-origin hop. A service redirecting to
// another host is not necessarily hostile -- but forwarding the admin's token
// to a host they never configured is not a decision this code gets to make
// silently.
async function safeFetch(url, init = {}, { fetchImpl = fetch, maxRedirects = MAX_REDIRECTS } = {}) {
  assertSafeUrl(url);
  let current = url;
  let headers = { ...(init.headers || {}) };
  const origin = new URL(url).origin;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetchImpl(current, { ...init, headers, redirect: 'manual' });
    const status = res.status;
    const isRedirect = status === 301 || status === 302 || status === 303
      || status === 307 || status === 308;
    if (!isRedirect) return res;

    const location = res.headers && res.headers.get ? res.headers.get('location') : null;
    if (!location) return res;                       // a redirect with nowhere to go
    const next = new URL(location, current).toString();
    const reason = unsafeUrlReason(next);
    if (reason) throw new Error(`provider redirected to an unusable URL: ${reason}`);
    if (new URL(next).origin !== origin) {
      // Cross-origin: keep following, but without the credentials.
      const { Authorization, ...rest } = headers;
      headers = Object.fromEntries(
        Object.entries(rest).filter(([k]) => k.toLowerCase() !== 'authorization'),
      );
      // Any custom auth header the admin configured is dropped too -- we do
      // not know which of these headers is the secret, so none of them travel.
      headers = { 'Content-Type': headers['Content-Type'] || 'application/json' };
    }
    current = next;
  }
  throw new Error(`provider redirected more than ${maxRedirects} times`);
}

// Reads a response body with a hard ceiling. Returns { buffer } or { error }.
// Streaming rather than res.arrayBuffer() so an enormous body is abandoned
// part-way instead of being fully buffered and then measured.
async function readCapped(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    if (typeof res.arrayBuffer !== 'function') {
      // Neither a stream nor a buffer: this is a hand-written stub in a test.
      // Report it rather than pretending a cap was applied.
      return { error: 'response body is not readable' };
    }
    // No streaming available (an older runtime): buffer, then enforce the cap.
    // Correct, just less defensive -- the body is already in memory by then.
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) return { error: 'response exceeded the size cap' };
    return { buffer: buf };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      return { error: 'response exceeded the size cap' };
    }
    chunks.push(Buffer.from(value));
  }
  return { buffer: Buffer.concat(chunks, total) };
}

// JSON, but never more than maxBytes of it.
//
// res.json() reads the WHOLE body before it can be capped, which hands a
// hostile or broken service a trivial way to exhaust this process -- the size
// cap on the decoded image is applied far too late to help. So the body is
// read through readCapped first and parsed from the capped buffer.
//
// Returns { json } or { error }.
async function readJsonCapped(res, maxBytes) {
  // A stub with only .json() (several of this repo's tests) cannot be capped;
  // fall through to it rather than failing, but only when there is genuinely
  // no body to stream. Real undici responses always have one.
  if ((!res.body || typeof res.body.getReader !== 'function')
      && typeof res.arrayBuffer !== 'function'
      && typeof res.json === 'function') {
    try {
      return { json: await res.json() };
    } catch (_) {
      // res.json() throws on a non-JSON body. Returning the error keeps this
      // branch's contract identical to the streaming one above -- letting it
      // propagate would turn "the service answered HTML" into a 500.
      return { error: 'response was not valid JSON' };
    }
  }
  const read = await readCapped(res, maxBytes);
  if (read.error) return { error: read.error };
  try {
    return { json: JSON.parse(read.buffer.toString('utf8')) };
  } catch (_) {
    return { error: 'response was not valid JSON' };
  }
}

module.exports = {
  assertSafeUrl, unsafeUrlReason, redactUrl, safeFetch, readCapped, readJsonCapped, MAX_REDIRECTS,
};
