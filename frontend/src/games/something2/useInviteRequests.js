// Data hooks for the admin Invites tab over /api/admin/invite-requests. Approve mails a code locked to the
// requester's email; reject mails a refusal. Failures show the shared errorText for the server's error code.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { authHeaders, apiFetch } from './src/js/net/auth.js';
import { API_URL } from '../../config.js';
import { errorText } from '../../pages/loginModel.js';
import { historyStatus } from './inviteRequestsModel.js';

const BASE = `${API_URL}/api/admin/invite-requests`;
export const INVITE_REQUESTS_KEY = 'invite-requests';

async function call(path, method = 'GET') {
  const res = await apiFetch(`${BASE}${path}`, { method, headers: authHeaders() });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.error || `Request failed (${res.status})`);
    err.code = body?.error;
    err.retryAfterSec = body?.retryAfterSec;
    throw err;
  }
  return body;
}

export const useInviteRequests = (status) => useQuery({
  queryKey: [INVITE_REQUESTS_KEY, status],
  queryFn: async () => (await call(`?status=${encodeURIComponent(status)}`)).requests || [],
  retry: false,
});

export const usePendingRequests = () => useInviteRequests('pending');
export const useHistoryRequests = (filter) => useInviteRequests(historyStatus(filter));

function useDecision(action) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => call(`/${encodeURIComponent(id)}/${action}`, 'POST'),
    onError: (err) => { toast.error(errorText(err.code, err.retryAfterSec)); },
    // A 409 not_pending means another admin got there first: refresh either way.
    onSettled: () => { qc.invalidateQueries({ queryKey: [INVITE_REQUESTS_KEY] }); },
  });
}

export const useApprove = () => useDecision('approve');
export const useReject = () => useDecision('reject');
