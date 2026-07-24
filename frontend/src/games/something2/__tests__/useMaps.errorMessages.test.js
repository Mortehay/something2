import { describe, it, expect } from 'vitest';
import { throwApiError } from '../useMaps.js';

// F-024/SOMET-204: useCreateEntityType/useUpdateEntityType/useDeleteEntityType
// and the three tile-type mutations threw a hardcoded generic Error string on
// a non-ok response, discarding the backend's real {error: "..."} body --
// while the otherwise-identical item-type mutations already parsed it.
// Confirmed live: a 404 {"error":"Entity type not found"} still surfaced as
// the generic "Update failed: Failed to update entity type" toast.
//
// throwApiError is the shared helper both families now call, so this tests
// the exact code path the mutations use instead of duplicating the
// parse-and-throw logic (and the risk of it drifting again) in six places.

describe('throwApiError', () => {
  it('surfaces the backend error message when the body parses', async () => {
    const res = { json: async () => ({ error: 'Entity type not found' }) };
    await expect(throwApiError(res, 'Failed to update entity type')).rejects.toThrow('Entity type not found');
  });

  it('falls back to the generic message when the body is not parseable JSON', async () => {
    const res = { json: async () => { throw new Error('bad json'); } };
    await expect(throwApiError(res, 'Failed to update entity type')).rejects.toThrow('Failed to update entity type');
  });

  it('falls back to the generic message when the body parses but has no error field', async () => {
    const res = { json: async () => ({}) };
    await expect(throwApiError(res, 'Failed to delete tile type')).rejects.toThrow('Failed to delete tile type');
  });
});
