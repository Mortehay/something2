const test = require('node:test');
const assert = require('node:assert');
const { sendEmail, smtpConfigured, __setSender } = require('../src/email/mailer.js');

const msg = { to: 'a@b.c', subject: 'Hi', text: 'Go: https://x.test/a?b=1 now', html: '<p>hi</p>' };
const cfg = { SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'u@gmail.com', SMTP_PASS: 'abcd efgh ijkl mnop' };

test('smtpConfigured needs host, user and pass', () => {
  assert.strictEqual(smtpConfigured({}), false);
  assert.strictEqual(smtpConfigured({ ...cfg, SMTP_PASS: '' }), false);
  assert.strictEqual(smtpConfigured(cfg), true);
});

test('console sender when unconfigured', async () => {
  const calls = [];
  let transportCalled = false;
  await sendEmail(msg, {
    env: {},
    createTransport: () => { transportCalled = true; },
    log: (...a) => calls.push(a),
  });
  assert.strictEqual(transportCalled, false);
  assert.deepStrictEqual(calls, [['[email:console]', 'a@b.c', 'Hi', 'https://x.test/a?b=1']]);
});

test('strips spaces from SMTP_PASS', async () => {
  let opts; let sent;
  await sendEmail(msg, {
    env: cfg,
    createTransport: (o) => { opts = o; return { sendMail: async (m) => { sent = m; } }; },
    log: () => {},
  });
  assert.strictEqual(opts.auth.pass, 'abcdefghijklmnop');
  assert.strictEqual(opts.port, 587);
  assert.strictEqual(opts.secure, false);
  assert.strictEqual(sent.from, 'u@gmail.com');
  assert.deepStrictEqual(sent.to, { name: '', address: 'a@b.c' });
});

test('transport carries 15 s connection, greeting and socket timeouts', async () => {
  let opts;
  await sendEmail(msg, {
    env: cfg,
    createTransport: (o) => { opts = o; return { sendMail: async () => {} }; },
    log: () => {},
  });
  assert.strictEqual(opts.connectionTimeout, 15000);
  assert.strictEqual(opts.greetingTimeout, 15000);
  assert.strictEqual(opts.socketTimeout, 15000);
});

test('port 465 is secure and MAIL_FROM wins', async () => {
  let opts; let sent;
  await sendEmail(msg, {
    env: { ...cfg, SMTP_PORT: '465', MAIL_FROM: 'Game <g@x.test>' },
    createTransport: (o) => { opts = o; return { sendMail: async (m) => { sent = m; } }; },
  });
  assert.strictEqual(opts.secure, true);
  assert.strictEqual(opts.port, 465);
  assert.strictEqual(sent.from, 'Game <g@x.test>');
});

test('rethrows transport failure', async () => {
  await assert.rejects(
    sendEmail(msg, {
      env: cfg,
      createTransport: () => ({ sendMail: async () => { throw new Error('smtp down'); } }),
    }),
    /smtp down/,
  );
});

test('__setSender replaces SMTP and console', async () => {
  const got = [];
  __setSender((m) => got.push(m));
  try {
    await sendEmail(msg, { env: cfg, createTransport: () => { throw new Error('no'); } });
  } finally { __setSender(null); }
  assert.deepStrictEqual(got, [msg]);
});
