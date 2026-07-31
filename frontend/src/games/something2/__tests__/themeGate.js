// Shared implementation for the Something2 admin theme gate (see themeTokens.test.js).
// Exported as its own module so the gate's tests can exercise the exact function the
// gate itself uses, instead of a copy that could silently drift from it.

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const RGBA_RE = /rgba?\([^)]*\)/gi;

// CSS/JS properties that hold a colour. A bare keyword literal (white, black, red,
// green, blue) is only an offence when it sits in the *value* of one of these --
// never in prose, a comment, an identifier ("greenfield"), or an unrelated prop name
// elsewhere on the line. `transparent` is legitimate and is deliberately not listed.
const COLOR_PROP_SRC = '(?:color|background(?:-color)?|border(?:-[a-z-]+)?|outline(?:-color)?|box-shadow|fill|stroke)';
const KEYWORD_SRC = '(white|black|red|green|blue)';

// Unquoted CSS declaration inside a styled-components template literal, e.g.
// `color: white;` -- the value runs up to the terminating `;`.
const CSS_DECL_RE = new RegExp(`\\b${COLOR_PROP_SRC}\\s*:\\s*([^;]+);`, 'gi');
// Quoted value inside a JS object literal, e.g. inline `style={{ color: 'white' }}`.
const QUOTED_DECL_RE = new RegExp(`\\b${COLOR_PROP_SRC}\\s*:\\s*(['"])([^'"]*)\\1`, 'gi');
const BARE_KEYWORD_RE = new RegExp(`\\b${KEYWORD_SRC}\\b`, 'gi');

// Single-line exemption must NAME the literal(s) it exempts, e.g.:
//   color: '#00ff00', // s2-theme-exempt(#00ff00): tile data default, not chrome
// A bare `// s2-theme-exempt: reason` with no parenthesised list exempts nothing on
// that line. The named list may itself contain an rgba()/rgb() value, whose own
// parentheses would otherwise close the outer match early -- allow one level of
// nesting so `s2-theme-exempt(rgba(0,0,0,0.5)): reason` captures the whole value.
const SENTINEL_RE = /s2-theme-exempt\(((?:[^()]|\([^()]*\))*)\)/;

function norm(literal) {
  return literal.toLowerCase().replace(/\s+/g, '');
}

// Every hex / rgba() literal appearing anywhere in the text, regardless of position --
// these forms are syntactically unambiguous and never collide with prose or identifiers.
function positionFreeLiterals(text) {
  return [...(text.match(HEX_RE) ?? []), ...(text.match(RGBA_RE) ?? [])];
}

// Bare colour keywords, but only when they are the value (or lead the value) of a
// colour-bearing property -- covers both plain CSS declarations and quoted inline
// JS style values.
function keywordsInColorPosition(text) {
  const found = [];
  for (const m of text.matchAll(CSS_DECL_RE)) found.push(...(m[1].match(BARE_KEYWORD_RE) ?? []));
  for (const m of text.matchAll(QUOTED_DECL_RE)) found.push(...(m[2].match(BARE_KEYWORD_RE) ?? []));
  return found;
}

// Strip block-sentinel regions (`/* s2-theme-exempt:start ... s2-theme-exempt:end */`)
// wholesale -- those are intended as full-region exclusions -- then scan what remains
// line by line, honouring only single-line sentinels that name their literal(s) explicitly.
export function offendingLiterals(source) {
  const withoutBlocks = source.replace(
    /\/\*\s*s2-theme-exempt:start[\s\S]*?s2-theme-exempt:end\s*\*\//g, '',
  );
  return withoutBlocks
    .split('\n')
    .flatMap((line) => {
      const found = [...positionFreeLiterals(line), ...keywordsInColorPosition(line)];
      if (found.length === 0) return [];

      const sentinelMatch = line.match(SENTINEL_RE);
      if (!sentinelMatch) return found;

      const exemptedText = sentinelMatch[1];
      const exempted = new Set(
        [...positionFreeLiterals(exemptedText), ...(exemptedText.match(BARE_KEYWORD_RE) ?? [])]
          .map(norm),
      );
      return found.filter((literal) => !exempted.has(norm(literal)));
    });
}
