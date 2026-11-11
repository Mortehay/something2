// Gmail SMTP mailer. Unconfigured => console sender (dev/tests never reach Gmail).
// Never log SMTP_PASS, tokens or message bodies.
const nodemailer = require('nodemailer');

let sender = null;

// Test seam: when set, sendEmail hands the message to fn instead of SMTP/console.
function __setSender(fn) {
  sender = typeof fn === 'function' ? fn : null;
}

function smtpConfigured(env = process.env) {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
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
  });
  await transport.sendMail({ from: env.MAIL_FROM || env.SMTP_USER, ...message });
}

module.exports = { sendEmail, smtpConfigured, __setSender };
