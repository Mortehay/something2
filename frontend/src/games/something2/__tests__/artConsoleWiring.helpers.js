// A minimal hook runtime for the art console's wiring tests (SOMET-538).
//
// vitest runs in node with no DOM and no render library, so a component or
// hook here has never been EXECUTED by a test -- only its pure helpers have.
// That left two rework fixes guarded by nothing: the end-of-run catalogue
// refetch and the same-tick enqueue join both stayed green with the wiring
// deleted (re-validation mutants M7 and M8). This runtime calls the REAL
// hook/component function with React's state hooks replaced by slot arrays,
// so a test drives the code that ships rather than a copy of its predicate.
//
// Deliberately small: state, refs, memos and effects with dependency
// comparison. It is not React -- children are not rendered, only the element
// tree the function returns -- and it does not need to be.
export function createRuntime() {
  const rt = { slots: [], i: 0, effects: [] };

  const slot = (init) => {
    const idx = rt.i;
    rt.i += 1;
    if (!(idx in rt.slots)) rt.slots[idx] = init();
    return idx;
  };

  rt.hooks = {
    useState(initial) {
      const idx = slot(() => (typeof initial === 'function' ? initial() : initial));
      const set = (v) => {
        rt.slots[idx] = typeof v === 'function' ? v(rt.slots[idx]) : v;
      };
      return [rt.slots[idx], set];
    },
    useRef(initial) {
      return rt.slots[slot(() => ({ current: initial }))];
    },
    useMemo(fn) {
      slot(() => null);
      return fn();
    },
    useCallback(fn) {
      slot(() => null);
      return fn;
    },
    useEffect(fn, deps) {
      const idx = slot(() => ({ deps: undefined }));
      const prev = rt.slots[idx].deps;
      const changed = !deps || !prev || deps.some((d, k) => !Object.is(d, prev[k]));
      if (changed) {
        rt.slots[idx].deps = deps;
        rt.effects.push(fn);
      }
    },
  };

  // Calls `fn` as one render, then runs that render's effects (React runs
  // them after commit; the order relative to the render is what matters).
  rt.render = (fn, { runEffects = true } = {}) => {
    rt.i = 0;
    rt.effects = [];
    const out = fn();
    if (runEffects) for (const e of rt.effects) e();
    return out;
  };
  return rt;
}

// Every element in a returned tree, walking props.children (custom components
// are not expanded, but their children are already elements in the tree).
export function* elements(node) {
  if (Array.isArray(node)) {
    for (const n of node) yield* elements(n);
    return;
  }
  if (!node || typeof node !== 'object' || !node.props) return;
  yield node;
  yield* elements(node.props.children);
}

export function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props && node.props.children);
}
