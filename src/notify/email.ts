import { readFileSync } from 'node:fs';
import { createTransport } from 'nodemailer';
import { notifications } from '../copy/notifications.ts';
import type { ConfirmationMailer, Notifier, SignInMailer } from '../service.ts';
import type { Db } from '../store/db.ts';

export interface MailTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string; headers?: Record<string, string> }): Promise<unknown>;
}

/**
 * What a failed send is logged as: nodemailer's error code and the SMTP reply code, never the error's text,
 * which can quote the recipient's address or the server's whole reply.
 */
export function mailFailure(error: unknown): string {
  const { code, responseCode } = (error ?? {}) as { code?: unknown; responseCode?: unknown };
  const name = typeof code === 'string' && /^[A-Z_]{1,32}$/.test(code) ? code : 'error';
  return typeof responseCode === 'number' && Number.isInteger(responseCode) ? `${name} ${responseCode}` : name;
}

/** Sends one message; a failure is logged as `what` and its codes, and never reaches the request that caused it. */
function send(transport: MailTransport, message: Parameters<MailTransport['sendMail']>[0], what: string): void {
  const failed = (error: unknown) => console.error(`[klatsch] ${what} failed: ${mailFailure(error)}`);
  try {
    transport.sendMail(message).catch(failed);
  } catch (error) {
    failed(error);
  }
}

/**
 * Email notifications, content-free like the desktop ones: a fixed subject,
 * the fixed message and a link to the web UI. No names, tags or summaries.
 * Sent only to a confirmed address. Every mail here is plain text only: SMTP services rewrite the links in an
 * HTML part to track clicks, and a link must reach the person as the relay made it.
 * `baseOf` gives each person's own base URL, so the link opens where they are signed in.
 */
/**
 * Our own List-Unsubscribe header. A provider such as Brevo adds its own to mail that has none, and a click on
 * that one blocks the address at the provider, so sign-in links stop arriving too; ours leads to Settings,
 * where a person turns off notifications and nothing else.
 */
const unsubscribe = (origin: string) => ({ 'List-Unsubscribe': `<${origin}/ui/settings>` });
const originOf = (link: string) => new URL(link).origin;

export function emailNotifier(db: Db, transport: MailTransport, from: string, baseOf: (handle: string) => string): Notifier {
  return (user, message) => {
    try {
      const row = db.prepare('SELECT email FROM users WHERE id = ? AND notify_email = 1 AND email IS NOT NULL AND email_verified_at IS NOT NULL').get(user.id) as
        | { email: string }
        | undefined;
      if (!row) return;
      send(transport, { from, to: row.email, subject: notifications.emailSubject, text: `${message}\n\n${baseOf(user.handle)}/ui\n`, headers: unsubscribe(baseOf(user.handle)) }, `email notification to @${user.handle}`);
    } catch (error) {
      console.error(`[klatsch] email notification to @${user.handle} failed: ${mailFailure(error)}`);
    }
  };
}

/** The one mail to an unconfirmed address: a fixed subject, one fixed sentence and the link. */
export function confirmationMailer(transport: MailTransport, from: string): ConfirmationMailer {
  return (to, link) => send(transport, { from, to, subject: notifications.confirmSubject, text: `${notifications.confirmText}\n\n${link}\n`, headers: unsubscribe(originOf(link)) }, 'email confirmation');
}

/**
 * Signing in by email. The mail: a fixed subject, the code, one sentence, the link, how long both work, and to ignore it if
 * unasked. The notice after a sign-in: one fixed sentence and the Settings link, so a sign-in that was not the
 * person shows. `Auto-Submitted` keeps out-of-office replies away (RFC 3834).
 */
export function signInMailer(transport: MailTransport, from: string): SignInMailer {
  const t = notifications;
  const headers = (at: string) => ({ 'Auto-Submitted': 'auto-generated', ...unsubscribe(originOf(at)) });
  return {
    link: (to, link, code) =>
      send(transport, { from, to, subject: t.signInSubject(code), text: `${t.signInCode}\n\n${code}\n\n${t.signInLead}\n\n${link}\n\n${t.signInExpiry}\n`, headers: headers(link) }, 'email sign-in link'),
    notice: (to, settings) => send(transport, { from, to, subject: t.signedInSubject, text: `${t.signedInText}\n\n${settings}\n`, headers: headers(settings) }, 'email sign-in notice'),
  };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * STARTTLS with a checked certificate is required unless the SMTP server is on this machine, so credentials
 * never go in clear: the URL cannot turn TLS off, and none of its `tls.*` options (such as `rejectUnauthorized`) apply.
 */
export function smtpUrl(raw: string): string {
  const url = new URL(raw);
  if (!LOOPBACK.has(url.hostname)) {
    url.searchParams.set('requireTLS', 'true');
    url.searchParams.delete('ignoreTLS');
    url.searchParams.delete('secure', 'false');
    for (const key of [...url.searchParams.keys()]) if (key.startsWith('tls.')) url.searchParams.delete(key);
  }
  // Never log the SMTP transcript: it carries confirmation links and the AUTH exchange.
  for (const key of ['debug', 'logger', 'transactionLog']) url.searchParams.delete(key);
  return url.toString();
}

/**
 * The SMTP URL, from the environment or from a file (`KLATSCH_SMTP_URL_FILE`, for a Docker secret), with one
 * trailing newline dropped. It holds the SMTP password, so no error names it or the file's contents.
 */
export function smtpUrlFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const { KLATSCH_SMTP_URL: url, KLATSCH_SMTP_URL_FILE: file } = env;
  if (url && file) throw new Error('Set KLATSCH_SMTP_URL or KLATSCH_SMTP_URL_FILE, not both.');
  if (!file) return url || undefined;
  try {
    return readFileSync(file, 'utf8').replace(/\r?\n$/, '') || undefined;
  } catch {
    throw new Error('KLATSCH_SMTP_URL_FILE cannot be read.');
  }
}

/** Email when the relay is configured for it (both variables), none when it is not (neither). */
export function emailFromEnv(
  env: NodeJS.ProcessEnv,
  db: Db,
  baseOf: (handle: string) => string,
): { notify: Notifier; confirm: ConfirmationMailer; signIn: SignInMailer } | undefined {
  const url = smtpUrlFromEnv(env);
  const from = env.KLATSCH_MAIL_FROM;
  if (Boolean(url) !== Boolean(from)) throw new Error('Email notifications need both KLATSCH_SMTP_URL and KLATSCH_MAIL_FROM; only one is set.');
  if (!url || !from) return undefined;
  const transport = createTransport(smtpUrl(url));
  return { notify: emailNotifier(db, transport, from, baseOf), confirm: confirmationMailer(transport, from), signIn: signInMailer(transport, from) };
}
