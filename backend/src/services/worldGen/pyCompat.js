// SOMET-644. Python-compatible numeric formatting and JSON for the JS port of
// the GPU box's world-spec generator (backend/tools/world_gen_ref/world_gen.py).
//
// The port must reproduce the box's `to_json()` output byte for byte, so every
// Python operation whose JS spelling differs is routed through here. The set is
// exactly what world_gen.py uses: round(x) / round(x, 1|2), `//`, `%`,
// f"{x:.0f}" / f"{x:.1f}", f"{value}" / str() on ints, floats, bools, None,
// strings, lists and dicts, and json.dumps(spec, indent=2).
//
// Floats vs ints. JS has one number type; Python prints 4.0 and 4 differently.
// The rule here:
//   - a plain JS number that is an integer value is a Python int;
//   - a plain JS number that is not an integer (2.5, NaN, Infinity) can only
//     have been a Python float, and prints as one;
//   - a Python float that happens to hold an integer value (4.0, -0.0, 1e16)
//     MUST be wrapped: pyFloat(4). PyFloat is an output marker - it is
//     arithmetic-transparent (valueOf), so `pyFloat(4) * 2 === 8`, but `===`
//     against a number is false; unwrap with `+f` before comparing. Compute
//     with plain numbers and wrap where a Python float would reach dumpsPy or
//     pyStr. The helpers below accept PyFloat anywhere they accept a number,
//     and return plain numbers.
//
// Rounding. pyRound and pyFormatFixed are exact: the double is expanded into
// mantissa * 2^exp with BigInt, scaled by 10^n, and rounded half-to-even on
// that exact rational - which is what CPython does (dtoa mode 3 on the binary
// value). Number.prototype.toFixed is NOT used: it rounds exact binary ties
// (0.125, 2.5) away from zero, Python rounds them to even.

class PyFloat {
  constructor(value) {
    this.value = Number(value);
    Object.freeze(this);
  }

  valueOf() { return this.value; }

  toJSON() { return this.value; }

  toString() { return pyFloatRepr(this.value); }

  [Symbol.toPrimitive](hint) {
    return hint === 'string' ? pyFloatRepr(this.value) : this.value;
  }
}

function pyFloat(x) {
  return x instanceof PyFloat ? x : new PyFloat(x);
}

function isPyFloat(x) {
  return x instanceof PyFloat;
}

const num = (x) => (x instanceof PyFloat ? x.value : x);

// --- exact rounding core -------------------------------------------------------

const POW10 = new Map();
function pow10(n) {
  let p = POW10.get(n);
  if (p === undefined) { p = 10n ** BigInt(n); POW10.set(n, p); }
  return p;
}

// |x| as m * 2^e, m and e exact (x finite).
function decompose(x) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const expField = (hi >>> 20) & 0x7ff;
  const frac = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (expField === 0) return { m: frac, e: -1074 };
  return { m: frac | (1n << 52n), e: expField - 1075 };
}

// round_half_even(|x| * 10^n) as a BigInt, computed on the exact binary value.
function scaledHalfEven(x, n) {
  const { m, e } = decompose(x);
  let N = m;
  let D = 1n;
  if (e >= 0) N <<= BigInt(e); else D <<= BigInt(-e);
  if (n >= 0) N *= pow10(n); else D *= pow10(-n);
  let q = N / D;
  const twice = (N % D) * 2n;
  if (twice > D || (twice === D && (q & 1n) === 1n)) q += 1n;
  return q;
}

const isNeg = (x) => x < 0 || Object.is(x, -0);

// CPython's limits for float.__round__(ndigits): beyond them the answer is
// known without computing (Objects/floatobject.c, NDIGITS_MAX/NDIGITS_MIN).
const NDIGITS_MAX = 323;
const NDIGITS_MIN = -308;

/**
 * Python's round(). `pyRound(x)` rounds half to even and returns an int (a
 * plain number, never -0); OverflowError/ValueError for inf/nan as in Python.
 * `pyRound(x, n)` returns the double nearest to x rounded to n decimals (ties
 * to even on the exact binary value), keeping the sign of zero. The result is
 * a plain number - wrap it with pyFloat() if it is to print as a float.
 */
function pyRound(x, n) {
  x = num(x);
  if (n === undefined || n === null) {
    if (Number.isNaN(x)) throw new Error('ValueError: cannot convert float NaN to integer');
    if (!Number.isFinite(x)) throw new Error('OverflowError: cannot convert float infinity to integer');
    const q = Number(scaledHalfEven(x, 0));
    return x < 0 && q !== 0 ? -q : q;
  }
  if (!Number.isInteger(n)) throw new TypeError('ndigits must be an integer');
  if (!Number.isFinite(x) || x === 0) return x;
  if (n > NDIGITS_MAX) return x;
  if (n < NDIGITS_MIN) return isNeg(x) ? -0 : 0;
  const q = scaledHalfEven(x, n);
  if (q === 0n) return isNeg(x) ? -0 : 0;
  // q * 10^-n, correctly rounded back to a double by the decimal parser.
  const r = Number(`${q}e${-n}`);
  return isNeg(x) ? -r : r;
}

/** Python's format(x, '.Nf') / f"{x:.Nf}" for an int or float x. */
function pyFormatFixed(x, digits) {
  x = num(x);
  if (!Number.isInteger(digits) || digits < 0) throw new TypeError('digits must be a non-negative integer');
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x < 0 ? '-inf' : 'inf';
  let s = scaledHalfEven(x, digits).toString();
  if (digits > 0) {
    s = s.padStart(digits + 1, '0');
    s = `${s.slice(0, -digits)}.${s.slice(-digits)}`;
  }
  return isNeg(x) ? `-${s}` : s;
}

// --- // and % --------------------------------------------------------------------

// Ports of CPython float_floor_div / float_rem (Objects/floatobject.c). On ints
// below 2^53 every step is exact, so they double as int // and int %. The one
// int/float difference is the sign of a zero result (0 // -5 is 0, but
// 0.0 // -5 is -0.0): by the float rule, two plain integer operands are ints
// and get an unsigned 0; a PyFloat or non-integer operand keeps float -0.
function divmod(a, b) {
  const ints = !(a instanceof PyFloat) && !(b instanceof PyFloat)
    && Number.isInteger(a) && Number.isInteger(b);
  a = num(a);
  b = num(b);
  if (b === 0) throw new Error('ZeroDivisionError: division by zero');
  let mod = a % b; // fmod
  let div = (a - mod) / b;
  if (mod) {
    if ((b < 0) !== (mod < 0)) { mod += b; div -= 1; }
  } else {
    mod = b < 0 ? -0 : 0;
  }
  let floordiv;
  if (div) {
    floordiv = Math.floor(div);
    if (div - floordiv > 0.5) floordiv += 1;
  } else {
    floordiv = (a / b) < 0 ? -0 : 0;
  }
  if (ints) return [floordiv + 0, mod + 0]; // -0 + 0 === +0
  return [floordiv, mod];
}

/** Python `a // b` (floors toward -infinity). */
function floorDiv(a, b) { return divmod(a, b)[0]; }

/** Python `a % b` (result takes the sign of b). */
function pyMod(a, b) { return divmod(a, b)[1]; }

// --- repr / str ----------------------------------------------------------------------

/**
 * Python's repr(float): the shortest round-tripping digits (as JS produces),
 * laid out the Python way - scientific when the decimal exponent is < -4 or
 * >= 16, with a signed, at-least-two-digit exponent (1e-05, 1e+16), and a
 * trailing ".0" on integral values.
 */
function pyFloatRepr(x) {
  x = num(x);
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x < 0 ? '-inf' : 'inf';
  const sign = isNeg(x) ? '-' : '';
  if (x === 0) return `${sign}0.0`;
  const [mant, expStr] = Math.abs(x).toExponential().split('e');
  const digits = mant.replace('.', '');
  const e = Number(expStr);
  let body;
  if (e < -4 || e >= 16) {
    const frac = digits.length > 1 ? `.${digits.slice(1)}` : '';
    const absE = String(Math.abs(e)).padStart(2, '0');
    body = `${digits[0]}${frac}e${e < 0 ? '-' : '+'}${absE}`;
  } else if (e < 0) {
    body = `0.${'0'.repeat(-e - 1)}${digits}`;
  } else {
    const intPart = digits.slice(0, e + 1).padEnd(e + 1, '0');
    body = `${intPart}.${digits.slice(e + 1) || '0'}`;
  }
  return sign + body;
}

function intStr(x) {
  // BigInt keeps large ints out of exponent notation; -0 becomes "0".
  return BigInt(x).toString();
}

function reprStr(s) {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    // Non-printable Latin-1 controls. CPython also escapes other non-printable
    // Unicode (str.isprintable); world_gen.py never repr()s such strings.
    else if (c < 0x20 || (c >= 0x7f && c <= 0xa0)) out += `\\x${c.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return out + quote;
}

function pyRepr(v) {
  if (typeof v === 'string') return reprStr(v);
  return pyStr(v);
}

const isPlainDict = (v) => v instanceof Map
  || (v !== null && typeof v === 'object' && !Array.isArray(v)
      && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null));

/**
 * Python's str(v) - what f"{v}" prints - for bool, int, float, None, str,
 * list (arrays print as Python lists, items via repr) and dict (plain objects
 * and Maps print as {'k': v, ...} in insertion order, keys and values via
 * repr) - the shapes a JSON spec can put in front of check_units.
 */
function pyStr(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (v instanceof PyFloat) return pyFloatRepr(v.value);
  if (typeof v === 'number') return Number.isInteger(v) ? intStr(v) : pyFloatRepr(v);
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`;
  if (isPlainDict(v)) {
    const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
    return `{${entries.map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(', ')}}`;
  }
  throw new TypeError(`pyStr: unsupported value ${Object.prototype.toString.call(v)}`);
}

// --- json.dumps ----------------------------------------------------------------------

// json.dumps default ensure_ascii=True: escape \ and ", the five short escapes,
// and every code unit outside printable ASCII (0x20-0x7e) as \uXXXX lowercase.
// Astral characters come out as their UTF-16 surrogate pair, as in Python.
const SHORT_ESCAPES = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };
function jsonStr(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const c = s.charCodeAt(i);
    if (SHORT_ESCAPES[ch]) out += SHORT_ESCAPES[ch];
    else if (c < 0x20 || c > 0x7e) out += `\\u${c.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

function jsonFloat(x) {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  return pyFloatRepr(x);
}

function jsonKey(k) {
  if (typeof k === 'string') return k;
  if (k === true) return 'true';
  if (k === false) return 'false';
  if (k === null) return 'null';
  if (k instanceof PyFloat) return jsonFloat(k.value);
  if (typeof k === 'number') return Number.isInteger(k) ? intStr(k) : jsonFloat(k);
  throw new TypeError(`dumpsPy: keys must be str, int, float, bool or None, not ${typeof k}`);
}

const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;

function entriesOf(v) {
  if (v instanceof Map) return [...v.entries()];
  const keys = Object.keys(v);
  const bad = keys.find((k) => ARRAY_INDEX.test(k) && Number(k) < 2 ** 32 - 1);
  if (bad !== undefined) {
    throw new TypeError(`dumpsPy: plain object has integer-like key "${bad}"; JS has already `
      + 'moved it ahead of the other keys, so Python insertion order is lost - use a Map');
  }
  return keys.map((k) => [k, v[k]]);
}

function encode(v, indent, depth) {
  if (v === null) return 'null';
  if (v === undefined) throw new TypeError('dumpsPy: undefined has no Python equivalent');
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (v instanceof PyFloat) return jsonFloat(v.value);
  if (typeof v === 'number') return Number.isInteger(v) ? intStr(v) : jsonFloat(v);
  if (typeof v === 'string') return jsonStr(v);

  let items;
  let open;
  let close;
  if (Array.isArray(v)) {
    items = v.map((x) => encode(x, indent, depth + 1));
    [open, close] = ['[', ']'];
  } else if (v instanceof Map || Object.getPrototypeOf(v) === Object.prototype
             || Object.getPrototypeOf(v) === null) {
    items = entriesOf(v).map(([k, x]) => {
      if (x === undefined) throw new TypeError(`dumpsPy: key "${k}" is undefined`);
      return `${jsonStr(jsonKey(k))}: ${encode(x, indent, depth + 1)}`;
    });
    [open, close] = ['{', '}'];
  } else {
    throw new TypeError(`dumpsPy: TypeError: ${Object.prototype.toString.call(v)} is not JSON serializable`);
  }

  if (items.length === 0) return open + close;
  if (indent === null) return open + items.join(', ') + close;
  const inner = `\n${' '.repeat(indent * (depth + 1))}`;
  const outer = `\n${' '.repeat(indent * depth)}`;
  return open + inner + items.join(`,${inner}`) + outer + close;
}

/**
 * json.dumps(value) / json.dumps(value, indent=N) with Python's defaults:
 * ensure_ascii, separators (", ", ": ") flat or ("," + newline, ": ") indented,
 * insertion order, NaN/Infinity allowed. Accepts null, booleans, numbers (see
 * the float rule at the top), PyFloat, strings, arrays, Maps and plain objects.
 */
function dumpsPy(value, { indent = null } = {}) {
  if (indent !== null && !(Number.isInteger(indent) && indent >= 0)) {
    throw new TypeError('dumpsPy: indent must be null or a non-negative integer');
  }
  return encode(value, indent, 0);
}

module.exports = {
  PyFloat, pyFloat, isPyFloat,
  pyRound, pyFormatFixed, floorDiv, pyMod,
  pyFloatRepr, pyStr, dumpsPy,
};
