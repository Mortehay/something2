// Email templates. Table layout, inline styles only: no <img>, <link> or <style>
// (mail clients strip or block them). Palette mirrors frontend/src/pages/Login.jsx.
const C = { page: '#0f0f1a', card: '#1a1a2e', border: '#2e2e3e', button: '#4a9eff', heading: '#ffffff', body: '#b8b8c8' };
const FOOTER = "If you didn't ask for this, ignore this email.";

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function layout({ heading, bodyHtml, button }) {
  const btn = button
    ? `<tr><td style="padding:8px 0 16px 0;"><a href="${esc(button.href)}" style="display:inline-block;background:${C.button};color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:6px;">${esc(button.label)}</a></td></tr>` +
      `<tr><td style="padding:0 0 16px 0;font-size:12px;color:${C.body};word-break:break-all;">${esc(button.href)}</td></tr>`
    : '';
  return `<!doctype html><html><body style="margin:0;padding:0;background:${C.page};">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};padding:24px 12px;"><tr><td align="center">` +
    `<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:${C.card};border:1px solid ${C.border};border-radius:8px;font-family:Arial,Helvetica,sans-serif;"><tr><td style="padding:28px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">` +
    `<tr><td style="padding:0 0 16px 0;font-size:22px;font-weight:bold;color:${C.heading};">${esc(heading)}</td></tr>` +
    `<tr><td style="padding:0 0 16px 0;font-size:15px;line-height:1.5;color:${C.body};">${bodyHtml}</td></tr>` +
    btn +
    `<tr><td style="padding:16px 0 0 0;border-top:1px solid ${C.border};font-size:12px;color:${C.body};">${esc(FOOTER)}</td></tr>` +
    `</table></td></tr></table></td></tr></table></body></html>`;
}

function inviteApprovedEmail({ code, link }) {
  return {
    subject: 'Your Something2 invite code',
    text: `Your invite request was approved. Your invite code: ${code}\n\nRegister here: ${link}\n\n${FOOTER}`,
    html: layout({
      heading: 'Your invite is ready',
      bodyHtml: `Your invite request was approved. Your invite code:<br><strong style="font-size:20px;color:${C.heading};letter-spacing:1px;">${esc(code)}</strong>`,
      button: { label: 'Create your account', href: link },
    }),
  };
}

function inviteRejectedEmail() {
  return {
    subject: 'About your Something2 invite request',
    text: `We can't offer you an invite right now. You can ask again in a few days.\n\n${FOOTER}`,
    html: layout({
      heading: 'About your invite request',
      bodyHtml: "We can't offer you an invite right now. You can ask again in a few days.",
      button: null,
    }),
  };
}

function verifyEmailEmail({ link }) {
  return {
    subject: 'Verify your Something2 email',
    text: `Confirm your email address to finish setting up your account: ${link}\n\nThis link expires in 24 hours.\n\n${FOOTER}`,
    html: layout({
      heading: 'Verify your email',
      bodyHtml: 'Confirm your email address to finish setting up your account. This link expires in 24 hours.',
      button: { label: 'Verify email', href: link },
    }),
  };
}

function resetPasswordEmail({ link }) {
  return {
    subject: 'Reset your Something2 password',
    text: `Choose a new password: ${link}\n\nThis link works once and expires in 24 hours.\n\n${FOOTER}`,
    html: layout({
      heading: 'Reset your password',
      bodyHtml: 'Use the button below to choose a new password. It works once and expires in 24 hours.',
      button: { label: 'Reset password', href: link },
    }),
  };
}

module.exports = { inviteApprovedEmail, inviteRejectedEmail, verifyEmailEmail, resetPasswordEmail };
