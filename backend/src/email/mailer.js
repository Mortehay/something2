// Gmail SMTP mailer. Unconfigured => console sender (dev/tests never reach Gmail).
// Never log SMTP_PASS, tokens or message bodies.
const nodemailer = require('nodemailer');

let sender = null;

const SMTP_TIMEOUT_MS = 15000;

// Test seam: when set, sendEmail hands the message to fn instead of SMTP/console.
function __setSender(fn) {
  sender = typeof fn === 'function' ? fn : null;
}

function smtpConfigured(env = process.env) {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
}

// Whether email actions (change email) are offered: real SMTP, or the EMAIL_GATE_FORCE test switch (console
// mail in dev/browser runs). Same inputs as the email gate (tokens.js emailGateActive). /me.mailEnabled and the
// change route's 503 mail_disabled both read this.
function mailEnabled(env = process.env) {
  return smtpConfigured(env) || env.EMAIL_GATE_FORCE === '1';
}

async function sendEmail(
  { to, subject, text, html },
  { env = process.env, createTransport = nodemailer.createTransport, log = console.log } = {},
) {
  const message = { to, subject, text, html };
  if (sender) {
    await sender(message);
    return;
  }
  if (!smtpConfigured(env)) {
    const url = /https?:\/\/\S+/.exec(text || '');
    log('[email:console]', to, subject, url ? url[0] : '');
    return;
  }
  const port = Number(env.SMTP_PORT || 587);
  const transport = createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS.replace(/\s+/g, '') },
    // Nodemailer's defaults are minutes long (2 min connect, 10 min socket); a stalled SMTP server would hold the
    // request (and, for approve/reset, a DB transaction) that long.
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
  // The recipient as an address object: nodemailer uses it verbatim instead of running it through its
  // address-list parser, so a single address can never be read as several.
  await transport.sendMail({ from: env.MAIL_FROM || env.SMTP_USER, ...message, to: { name: '', address: to } });
}

module.exports = { sendEmail, smtpConfigured, mailEnabled, __setSender, SMTP_TIMEOUT_MS };
