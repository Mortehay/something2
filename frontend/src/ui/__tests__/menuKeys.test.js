import { describe, it, expect } from 'vitest';
import { menuKeyAction } from '../menuKeys.js';

// The header account menu declared role="menu"/role="menuitem" while handling
// no keys at all -- a final-review finding. role="menu" tells assistive tech
// arrows/Escape/Tab work, so the roles were an unkept promise.
//
// vitest here is a plain node env (no DOM, no RTL), so the rule lives in a pure
// function and the component only maps its result onto focus() calls.

const open3 = (key, focusedIndex = 0) =>
  menuKeyAction({ key, open: true, focusedIndex, itemCount: 3 });

describe('menuKeyAction — closed trigger', () => {
  const closed = (key) => menuKeyAction({ key, open: false, focusedIndex: -1, itemCount: 3 });

  it('opens onto the FIRST item for ArrowDown', () => {
    expect(closed('ArrowDown')).toEqual({ type: 'open', index: 0 });
  });

  it('opens onto the LAST item for ArrowUp', () => {
    expect(closed('ArrowUp')).toEqual({ type: 'open', index: 2 });
  });

  it('ignores keys that are not the open gesture', () => {
    expect(closed('Escape')).toBeNull();
    expect(closed('Tab')).toBeNull();
    expect(closed('a')).toBeNull();
  });
});

describe('menuKeyAction — open menu', () => {
  it('cycles forward and wraps past the last item', () => {
    expect(open3('ArrowDown', 0)).toEqual({ type: 'focus', index: 1 });
    expect(open3('ArrowDown', 2)).toEqual({ type: 'focus', index: 0 });
  });

  it('cycles backward and wraps past the first item', () => {
    expect(open3('ArrowUp', 2)).toEqual({ type: 'focus', index: 1 });
    expect(open3('ArrowUp', 0)).toEqual({ type: 'focus', index: 2 });
  });

  it('jumps to the ends for Home and End', () => {
    expect(open3('Home', 1)).toEqual({ type: 'focus', index: 0 });
    expect(open3('End', 1)).toEqual({ type: 'focus', index: 2 });
  });

  it('closes on Escape so focus can return to the trigger', () => {
    expect(open3('Escape')).toEqual({ type: 'close' });
  });

  it('dismisses on Tab WITHOUT reclaiming focus, so tabbing moves on', () => {
    expect(open3('Tab')).toEqual({ type: 'dismiss' });
  });

  it('enters from the correct end when focus is still on the trigger', () => {
    // focusedIndex -1 must not be treated as a real position: naive modular
    // arithmetic sends ArrowUp to itemCount-2 instead of the last item.
    expect(open3('ArrowDown', -1)).toEqual({ type: 'focus', index: 0 });
    expect(open3('ArrowUp', -1)).toEqual({ type: 'focus', index: 2 });
  });

  it('ignores unrelated keys', () => {
    expect(open3('Enter')).toBeNull();
    expect(open3('ArrowLeft')).toBeNull();
  });
});

describe('menuKeyAction — single-item menu (what the header actually renders)', () => {
  const one = (key, focusedIndex = 0) =>
    menuKeyAction({ key, open: true, focusedIndex, itemCount: 1 });

  it('keeps both arrows on the only item rather than moving focus nowhere', () => {
    expect(one('ArrowDown')).toEqual({ type: 'focus', index: 0 });
    expect(one('ArrowUp')).toEqual({ type: 'focus', index: 0 });
  });

  it('still closes on Escape', () => {
    expect(one('Escape')).toEqual({ type: 'close' });
  });
});

describe('menuKeyAction — empty menu', () => {
  const empty = (key) => menuKeyAction({ key, open: true, focusedIndex: -1, itemCount: 0 });

  it('can still be escaped, so the user is never trapped', () => {
    expect(empty('Escape')).toEqual({ type: 'close' });
    expect(empty('Tab')).toEqual({ type: 'dismiss' });
  });

  it('has nothing to focus', () => {
    expect(empty('ArrowDown')).toBeNull();
    expect(empty('ArrowUp')).toBeNull();
  });

  it('cannot be opened onto a nonexistent item', () => {
    expect(menuKeyAction({ key: 'ArrowDown', open: false, focusedIndex: -1, itemCount: 0 })).toBeNull();
    expect(menuKeyAction({ key: 'ArrowUp', open: false, focusedIndex: -1, itemCount: 0 })).toBeNull();
  });
});
