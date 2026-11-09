// A provider such as Brevo adds its own List-Unsubscribe to mail without one, and a click on that blocks the address
// there, sign-in mail included. So every mail the relay sends carries its own, to Settings.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { confirmationMailer, emailNotifier, signInMailer, type MailTransport } from '../src/notify/email.ts';
import { openDb } from '../src/store/db.ts';

function capture() {
  const sent: { headers?: Record<string, string> }[] = [];
  const transport: MailTransport = { sendMail: async (message) => void sent.push(message) };
  return { sent, transport };
}
const OURS = '<https://klatsch.example/ui/settings>';

describe('List-Unsubscribe', () => {
  it('sign-in mail and its notice carry ours, beside Auto-Submitted', () => {
    const { sent, transport } = capture();
    const mailer = signInMailer(transport, 'k@klatsch.example');
    mailer.link('a@example.org', 'https://klatsch.example/ui/auth/email/abc', '123456');
    mailer.notice('a@example.org', 'https://klatsch.example/ui/settings');
    assert.equal(sent.length, 2);
    for (const mail of sent) assert.deepEqual(mail.headers, { 'Auto-Submitted': 'auto-generated', 'List-Unsubscribe': OURS });
  });

  it('a confirmation mail carries ours, on the origin of its link and without its token', () => {
    const { sent, transport } = capture();
    confirmationMailer(transport, 'k@klatsch.example')('a@example.org', 'https://klatsch.example/ui/confirm/secret-token');
    assert.equal(sent[0]!.headers!['List-Unsubscribe'], OURS);
  });

  it('a notification carries ours, on the person’s own base', () => {
    const { sent, transport } = capture();
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO users (id, handle, display_name, email, email_verified_at, created_at) VALUES ('u', 'ada', 'Ada', 'a@example.org', 1, 1)`).run();
    emailNotifier(db, transport, 'k@klatsch.example', () => 'https://klatsch.example')({ id: 'u', handle: 'ada' }, 'Something new.');
    assert.equal(sent[0]!.headers!['List-Unsubscribe'], OURS);
    db.close();
  });
});
