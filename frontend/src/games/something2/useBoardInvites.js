// SOMET-734. Data hooks for the Invite codes box. Each call goes ssh -> docker exec on a small board, so the list
// is read when the tab opens, after a change, and on demand, never on a timer.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { call } from './useBoard.js';

export const INVITES_KEY = ['board-invites'];

export const useBoardInvites = (enabled) => useQuery({
  queryKey: INVITES_KEY, queryFn: () => call('/invites'), enabled, staleTime: 60_000, retry: false,
});

export function useMakeInvites() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ count, note }) => call('/invites/mint', 'POST', { count, ...(note ? { note } : {}) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: INVITES_KEY }); },
    onError: (err) => { toast.error(err.message); },
  });
}

export function useRevokeInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code) => call('/invites/revoke', 'POST', { code }),
    onSuccess: (out) => {
      toast.success(out?.revoked ? `Revoked ${out.revoked}` : 'Nothing was revoked: the code was already used or is gone');
      qc.invalidateQueries({ queryKey: INVITES_KEY });
    },
    onError: (err) => { toast.error(err.message); },
  });
}
