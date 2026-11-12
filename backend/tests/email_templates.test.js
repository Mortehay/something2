const test = require('node:test');
const assert = require('node:assert');
const t = require('../src/email/templates.js');

const link = 'https://app.test/verify?token=abc-123';
const cases = [
  ['inviteApprovedEmail', () => t.inviteApprovedEmail({ code: 'CODE-9X', link }), ['CODE-9X', link], 'Your Something2 invite code'],
  ['verifyEmailEmail', () => t.verifyEmailEmail({ link }), [link], 'Verify your Something2 email'],
  ['resetPasswordEmail', () => t.resetPasswordEmail({ link }), [link], 'Reset your Something2 password'],
  ['inviteRejectedEmail', () => t.inviteRejectedEmail(), [], 'About your Something2 invite request'],
];

for (const [name, make, needles, subject] of cases) {
  test(`${name}: subject, content, palette, no external resources`, () => {
    const m = make();
    assert.strictEqual(m.subject, subject);
    for (const n of needles) {
      assert.ok(m.text.includes(n), `text has ${n}`);
      assert.ok(m.html.includes(n), `html has ${n}`);
    }
    assert.ok(m.html.includes('#1a1a2e'));
    if (name !== 'inviteRejectedEmail') assert.ok(m.html.includes('#4a9eff'));
    assert.ok(!/<img|<link|<style/i.test(m.html));
    assert.ok(m.text.includes("If you didn't ask for this, ignore this email."));
  });
}

test('hostile link is HTML-escaped', () => {
  const evil = 'https://a.test/"><script>alert(1)</script>';
  for (const m of [t.verifyEmailEmail({ link: evil }), t.resetPasswordEmail({ link: evil }), t.inviteApprovedEmail({ code: '<b>', link: evil })]) {
    assert.ok(!m.html.includes('<script>'));
    assert.ok(m.html.includes('&quot;&gt;&lt;script&gt;'));
  }
});

// The old address is no longer on any account, so "reset your password" from it cannot work.
test('emailChangedNoticeEmail: masked new address, contact-admin advice, never reset advice', () => {
  const m = t.emailChangedNoticeEmail({ maskedNew: 'a***@example.com' });
  assert.strictEqual(m.subject, 'Your Something2 email was changed');
  for (const body of [m.text, m.html]) {
    assert.ok(body.includes('a***@example.com'));
    assert.ok(body.includes('If you did not make this change, contact an administrator right away.'));
    assert.ok(!/reset your password/i.test(body));
  }
});
