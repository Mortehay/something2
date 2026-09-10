import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AdminLoading from '../AdminLoading.jsx';

// SOMET-557 follow-up. The spinner must be valid PHRASING content, because
// half its call sites put it inside a <p>.
//
// The bug this locks down, reported by React in the browser on the art tab:
//
//   In HTML, <div> cannot be a descendant of <p>. This will cause a hydration
//   error.   <styled.p> > <p> > <AdminLoading> > <div role="status">
//
// `inline` exists precisely so this can sit in a row of content, and that
// content is often the shared `Hint` (styled.p). A <p> may contain only
// phrasing content, so a block tag here is invalid at every such site -- and
// the browser silently CLOSES the <p> before a block child, leaving the text
// after the spinner in a different element than the markup says.
//
// Asserted on the RENDERED MARKUP rather than by spying for React's warning:
// that warning is a dev-build console.error whose wording changes between
// React versions, and this suite runs in a node environment with no DOM to
// validate against. The tag names are the actual contract.
//
// createElement rather than JSX because vitest.config.js collects only
// `src/**/*.test.js` and nothing in this suite has needed a renderer before.
const BLOCK_TAGS = ['div', 'p', 'section', 'article', 'ul', 'ol', 'li', 'table', 'h1', 'h2'];

describe('AdminLoading is safe inside a paragraph', () => {
  for (const inline of [true, false]) {
    it(`renders no block-level tag (inline=${inline})`, () => {
      const html = renderToStaticMarkup(h(AdminLoading, { inline, label: 'Loading…' }));
      // Guards against a vacuous pass: the component must actually have rendered.
      expect(html).toMatch(/<span/);
      for (const tag of BLOCK_TAGS) {
        expect(html, `<${tag}> is not valid inside a <p>`)
          .not.toMatch(new RegExp(`<${tag}[\\s>]`));
      }
    });
  }

  // The real shape from ArtConsoleAdmin's coverage line: the spinner inside a
  // <p> that also carries text.
  it('nests inside a <p> without introducing a block child', () => {
    const html = renderToStaticMarkup(
      h('p', null, h(AdminLoading, { label: 'Loading the catalogue…', inline: true, size: 16 })),
    );
    expect(html).toMatch(/^<p[\s>]/);
    expect(html).not.toMatch(/<div/);
  });

  // Not cosmetic: role=status + aria-live is how a screen reader is told the
  // page is busy, and it must survive the tag change.
  it('keeps its live-region semantics', () => {
    const html = renderToStaticMarkup(h(AdminLoading, null));
    expect(html).toMatch(/role="status"/);
    expect(html).toMatch(/aria-live="polite"/);
  });
});
