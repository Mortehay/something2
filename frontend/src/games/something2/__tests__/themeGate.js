// Shared implementation for the Something2 admin theme gate (see themeTokens.test.js).
// Exported as its own module so the gate's tests can exercise the exact function the
// gate itself uses, instead of a copy that could silently drift from it.

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;

// Single-line exemption must NAME the hex(es) it exempts, e.g.:
//   color: '#00ff00', // s2-theme-exempt(#00ff00): tile data default, not chrome
// A bare `// s2-theme-exempt: reason` with no parenthesised hex list exempts
// nothing on that line — it is not a valid single-line exemption by itself.
const SENTINEL_RE = /s2-theme-exempt\(([^)]*)\)/;

// Strip block-sentinel regions (`/* s2-theme-exempt:start ... s2-theme-exempt:end */`)
// wholesale — those are intended as full-region exclusions — then scan what remains
// line by line, honouring only single-line sentinels that name their hex explicitly.
export function offendingLiterals(source) {
  const withoutBlocks = source.replace(
    /\/\*\s*s2-theme-exempt:start[\s\S]*?s2-theme-exempt:end\s*\*\//g, '',
  );
  return withoutBlocks
    .split('\n')
    .flatMap((line) => {
      const hexOnLine = line.match(HEX_RE) ?? [];
      if (hexOnLine.length === 0) return [];

      const sentinelMatch = line.match(SENTINEL_RE);
      if (!sentinelMatch) return hexOnLine;

      const exempted = new Set(
        (sentinelMatch[1].match(HEX_RE) ?? []).map((hex) => hex.toLowerCase()),
      );
      return hexOnLine.filter((hex) => !exempted.has(hex.toLowerCase()));
    });
}
