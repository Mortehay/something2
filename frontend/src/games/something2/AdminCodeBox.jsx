import { useState } from 'react';
import { t } from './src/js/i18n/i18n.js';
import { useAdminGate } from './useAdminGate.js';
import { adminGateView, codeToSend } from './adminGateView.js';

// The Settings "Admin" tab: the code box that unlocks the in-game admin menu. Shown only to admin
// accounts (the server decides who is one and ignores everyone else). The code goes to the server
// and is not kept here: the input is cleared after every attempt, and an unlock lasts on the
// server (per account, until it restarts or you lock it again).
export default function AdminCodeBox({ gameRef }) {
  const gate = useAdminGate(gameRef, true);
  const [code, setCode] = useState('');
  const view = adminGateView(gate);

  const submit = (e) => {
    if (e) e.preventDefault();
    const c = codeToSend(code);
    if (!c) return;
    const g = gameRef.current;
    if (g && g.adminGateRequest) g.adminGateRequest('unlock', c);
    setCode('');
  };
  const lock = () => {
    const g = gameRef.current;
    if (g && g.adminGateRequest) g.adminGateRequest('lock');
  };

  return (
    <div>
      <p className="hint" style={{ margin: '0 0 10px' }}>{t(view.message)}</p>
      {view.mode === 'locked' && (
        <form onSubmit={submit} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="password"
            autoComplete="off"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t('Admin code')}
            aria-label={t('Admin code')}
            style={{ padding: '6px 10px', borderRadius: 6, minWidth: 180 }}
          />
          <button type="submit" disabled={!codeToSend(code)} style={{ padding: '6px 12px', borderRadius: 6, cursor: 'pointer' }}>
            {t('Unlock')}
          </button>
        </form>
      )}
      {view.error && <p role="alert" style={{ color: 'var(--s2-danger)', margin: '8px 0 0' }}>{t(view.error)}</p>}
      {view.mode === 'unlocked' && (
        <button type="button" onClick={lock} style={{ padding: '6px 12px', borderRadius: 6, cursor: 'pointer' }}>
          {t('Lock the admin menu')}
        </button>
      )}
    </div>
  );
}
