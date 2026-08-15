// SOMET-325: a deliberately tiny path evaluator for pulling values out of a
// remote service's JSON response.
//
// WHY NOT A JSONPATH LIBRARY: the whole grammar this needs is "walk some keys,
// walk some array indices". A dependency would bring an expression language --
// filters, recursive descent, script evaluation -- whose extra power is
// entirely surface area, since the strings it evaluates come from an admin
// form and get run against a response from a machine we do not control.
//
// WHY IT IS SHARED: model discovery needs a LIST out of a response
// ($[*].model_name), and the image adapter (SOMET-327) needs ONE VALUE out of
// a response (images[0]). That is the same walk with a different arity, so it
// is one parser with two entry points rather than two parsers that drift.
//
// Supported syntax, which covers every service shape this epic targets:
//
//   $[*].model_name        A1111    -> root is an array of objects
//   models[*].name         Ollama   -> a named array of objects
//   data[*].id             OpenAI-compatible
//   images[0]              A1111 txt2img -> first image
//   output.images[0].url   nested single value
//
// A leading `$` is optional and means "the root".

// Splits a path into steps. Returns null for syntax the walker cannot honour,
// so callers can report "bad pointer" rather than silently matching nothing --
// those two are very different messages for whoever typed it.
function parsePointer(path) {
  if (typeof path !== 'string') return null;
  let rest = path.trim();
  if (!rest) return [];
  if (rest.startsWith('$')) rest = rest.slice(1);
  if (rest.startsWith('.')) rest = rest.slice(1);

  const steps = [];
  // Consume alternating key and [index] tokens until the string is used up.
  // Anything left over at the end is a syntax error rather than a silent
  // truncation of the path.
  const token = /^(?:([A-Za-z_][A-Za-z0-9_-]*)|\[(\*|\d+)\])/;
  while (rest.length) {
    const m = token.exec(rest);
    if (!m) return null;
    if (m[1] !== undefined) {
      steps.push({ type: 'key', name: m[1] });
    } else {
      steps.push(m[2] === '*' ? { type: 'all' } : { type: 'index', index: Number(m[2]) });
    }
    rest = rest.slice(m[0].length);
    // A '.' only separates tokens; it must be followed by something.
    if (rest.startsWith('.')) {
      rest = rest.slice(1);
      if (!rest.length) return null;
    }
  }
  return steps;
}

// Every value the path selects, in document order.
//
// An empty path means "the root itself", and a root that is an array is
// spread -- that makes `[]` the right pointer for a service that answers with
// a bare list of model-name strings, which is otherwise an awkward special
// case for the caller.
function selectAll(root, path) {
  const steps = parsePointer(path);
  if (steps === null) return null;          // syntax error, distinct from "no match"
  if (steps.length === 0) return Array.isArray(root) ? root.slice() : [root];

  let current = [root];
  for (const step of steps) {
    const next = [];
    for (const value of current) {
      if (value === null || value === undefined) continue;
      if (step.type === 'key') {
        if (typeof value === 'object' && !Array.isArray(value) && step.name in value) {
          next.push(value[step.name]);
        }
      } else if (step.type === 'all') {
        if (Array.isArray(value)) next.push(...value);
      } else if (Array.isArray(value) && step.index < value.length) {
        next.push(value[step.index]);
      }
    }
    current = next;
    if (current.length === 0) break;        // nothing left to walk into
  }
  return current;
}

// The first value the path selects, or undefined. `null` still means the path
// itself was malformed -- callers that conflate the two report "no image in
// the response" when the real problem is a typo in the pointer field.
function selectOne(root, path) {
  const all = selectAll(root, path);
  if (all === null) return null;
  return all.length ? all[0] : undefined;
}

module.exports = { parsePointer, selectAll, selectOne };
