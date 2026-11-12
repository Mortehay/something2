// Invite requests: a public "ask for an invite" form (invite mode only) and the
// admin queue that approves (mints an email-locked code and mails it) or rejects.
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { clientIpKey } = require('../clientIp.js');
const { requireAdmin } = require('./middleware.js');
const { registrationMode } = require('../productionSafety.js');
const { normalizeEmail, verifiedHolder } = require('./emailAddress.js');
const { mintCode } = require('./inviteCodeGen.js');
const { linkOrigin } = require('../email/linkOrigin.js');
const { inviteApprovedEmail, inviteRejectedEmail } = require('../email/templates.js');
const { sendEmail } = require('../email/mailer.js');

const NOTE_MAX = 300;
const STATUSES = ['pending', 'approved', 'rejected'];

// IP-only: every request is one row an admin must read, so cap the flood.
function requestIpLimiter() {
  return rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => clientIpKey(req),
  });
}

const toRequest = (r) => ({
  id: r.id,
  email: r.email,
  note: r.note,
  status: r.status,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
  decidedBy: r.decided_by,
  inviteCode: r.invite_code,
  codeUsed: r.code_used_at != null,
});

const SELECT_REQUEST = `
  SELECT r.id, r.email::text AS email, r.note, r.status, r.created_at, r.decided_at,
         r.decided_by, r.invite_code::text AS invite_code, c.used_at AS code_used_at
    FROM invite_requests r LEFT JOIN invite_codes c ON c.code = r.invite_code`;

// Mounted at /api. `pool` has query() and connect().
module.exports = function inviteRequestRouter(pool) {
  const router = express.Router();
  const adminGuard = requireAdmin(pool);

  router.get('/auth/options', (req, res) => {
    let mode;
    try { mode = registrationMode(); } catch { return res.status(500).json({ error: 'misconfigured' }); }
    return res.json({ registrationMode: mode, inviteRequests: mode === 'invite' });
  });

  router.post('/auth/invite-requests', requestIpLimiter(), async (req, res) => {
    try {
      if (registrationMode() !== 'invite') return res.status(404).json({ error: 'not found' });
      const body = req.body || {};
      const email = normalizeEmail(body.email);
      if (!email) return res.status(400).json({ error: 'invalid_email' });
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, NOTE_MAX) : '';
      // Same answer whether or not a row is made: the response must not reveal
      // that an address already has an account or a pending request.
      if (await verifiedHolder(pool, email) == null) {
        await pool.query(
          `INSERT INTO invite_requests (email, note)
           SELECT $1, $2
            WHERE NOT EXISTS (
              SELECT 1 FROM invite_requests
               WHERE email = $1
                 AND (status = 'pending'
                      OR (status = 'rejected' AND decided_at > now() - interval '7 days')))
           ON CONFLICT DO NOTHING`,
          [email, note || null],
        );
      }
      return res.json({ ok: true });
    } catch (err) {
      console.error('invite request failed');
      return res.status(500).json({ error: 'invite request failed' });
    }
  });

  router.get('/admin/invite-requests', adminGuard, async (req, res) => {
    const status = req.query.status === undefined ? 'pending' : String(req.query.status);
    if (status !== 'all' && !STATUSES.includes(status)) {
      return res.status(400).json({ error: 'invalid status' });
    }
    try {
      const { rows } = await pool.query(
        `${SELECT_REQUEST} WHERE ($1 = 'all' OR r.status = $1) ORDER BY r.created_at DESC, r.id DESC`,
        [status],
      );
      return res.json({ requests: rows.map(toRequest) });
    } catch (err) {
      console.error('invite request list failed');
      return res.status(500).json({ error: 'invite request list failed' });
    }
  });

  // Decide a pending request inside one transaction that also sends the mail:
  // a failed send rolls the decision (and any minted code) back, and the row
  // lock makes a double-click decide once and mail once.
  async function decide(req, res, approve) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: 'not found' });
    let client;
    let began = false;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      began = true;
      const { rows } = await client.query(
        "SELECT id, email::text AS email FROM invite_requests WHERE id = $1 AND status = 'pending' FOR UPDATE",
        [id],
      );
      if (!rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'not_pending' });
      }
      const { email } = rows[0];
      let message;
      let code = null;
      if (approve) {
        const origin = linkOrigin(req);
        if (!origin) {
          await client.query('ROLLBACK');
          return res.status(500).json({ error: 'no_link_origin' });
        }
        for (let attempt = 0; attempt < 5 && !code; attempt += 1) {
          const candidate = mintCode();
          const ins = await client.query(
            `INSERT INTO invite_codes (code, note, email) VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING RETURNING code`,
            [candidate, `request ${id}`, email],
          );
          if (ins.rows.length) code = ins.rows[0].code;
        }
        if (!code) throw new Error('could not mint a unique code');
        const link = `${origin}/login?register=1&invite=${code}&email=${encodeURIComponent(email)}`;
        message = inviteApprovedEmail({ code, link });
      } else {
        message = inviteRejectedEmail();
      }
      await client.query(
        `UPDATE invite_requests
            SET status = $2, decided_at = now(), decided_by = $3, invite_code = $4
          WHERE id = $1`,
        [id, approve ? 'approved' : 'rejected', req.user.id, code],
      );
      try {
        await sendEmail({ to: email, subject: message.subject, text: message.text, html: message.html });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('invite request email failed');
        return res.status(502).json({ error: 'email_failed' });
      }
      await client.query('COMMIT');
      began = false;
      const { rows: out } = await client.query(`${SELECT_REQUEST} WHERE r.id = $1`, [id]);
      return res.json({ request: toRequest(out[0]) });
    } catch (err) {
      if (began) { try { await client.query('ROLLBACK'); } catch { /* connection already gone */ } }
      console.error('invite request decision failed');
      return res.status(500).json({ error: 'invite request decision failed' });
    } finally {
      if (client) client.release();
    }
  }

  router.post('/admin/invite-requests/:id/approve', adminGuard, (req, res) => decide(req, res, true));
  router.post('/admin/invite-requests/:id/reject', adminGuard, (req, res) => decide(req, res, false));

  return router;
};
