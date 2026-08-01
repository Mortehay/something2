import { describe, it, expect } from 'vitest';
import { guardRedirect } from '../routeGuards.js';

describe('guardRedirect', () => {
  it('sends a signed-out visitor to the login screen', () => {
    expect(guardRedirect({ authed: false, isAdmin: false })).toBe('/login');
  });

  it('sends a signed-out visitor to login even on an admin route', () => {
    expect(guardRedirect({ authed: false, isAdmin: false, requireAdmin: true })).toBe('/login');
  });

  it('lets a signed-in non-admin through a non-admin route', () => {
    expect(guardRedirect({ authed: true, isAdmin: false })).toBeNull();
  });

  it('bounces a signed-in non-admin off an admin route to the game view', () => {
    expect(guardRedirect({ authed: true, isAdmin: false, requireAdmin: true })).toBe('/game');
  });

  it('lets an admin through an admin route', () => {
    expect(guardRedirect({ authed: true, isAdmin: true, requireAdmin: true })).toBeNull();
  });
});
