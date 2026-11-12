// .env sync box (email accounts, Task 15). Reading the board's .env is an ssh call into a small board, so it is read
// when the tab opens (board online), after a copy and on demand, never on a timer.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { call } from './useBoard.js';
import { copyResultText } from './boardEnvModel.js';

export const ENV_KEY = ['board-env'];

export const useBoardEnv = (enabled) => useQuery({
  queryKey: ENV_KEY, queryFn: () => call('/env'), enabled, staleTime: 60_000, retry: false,
});

export function useCopyEnv() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keys) => call('/env/copy', 'POST', { keys }),
    onSuccess: (out) => {
      const text = copyResultText(out);
      if (out?.written?.length) toast.success(text, { duration: 8000 }); else toast(text, { duration: 8000 });
    },
    onError: (err) => { toast.error(err.message); },
    // A failed copy may have written some keys before it stopped: read the statuses again either way.
    onSettled: () => { qc.invalidateQueries({ queryKey: ENV_KEY }); },
  });
}
