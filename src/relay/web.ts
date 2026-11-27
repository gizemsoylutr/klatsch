import { transaction } from '../store/db.ts';
import { GUEST_HOURS, normalHandle, reservedHandle, type ConversationSummary, type ConversationView } from '../service.ts';
import { randomBytes } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html } from 'hono/html';
import { findByCode, getApproval, normalizeCode, type Approval } from '../auth/approvals.ts';
import { createEmailConfirmation, findEmailConfirmation } from '../auth/email-confirmations.ts';
import { claimEmailLogin, claimEmailLoginByCode, createEmailLogin, findEmailLogin, normalCode, normalEmail, type EmailLogin, type JoinRef } from '../auth/email-logins.ts';
import { authorizeUrl, identify, newAttempt, type GitHubIdentity } from '../auth/github.ts';
import { googleAuthorizeUrl, identifyGoogle, newGoogleAttempt, type GoogleIdentity } from '../auth/google.ts';
import { createInvite, findInvite, inviteById } from '../auth/invites.ts';
import { issueCode, readAuthorize, redirectTo } from '../auth/oauth.ts';
import { passkeyById, passkeysOf, transportsOf, type PasskeyView } from '../auth/passkeys.ts';
import { CONNECT_INTERVAL_S, decideConnect, findConnect, pollConnect, startConnect } from '../auth/connect-requests.ts';
import { connectCommand, createToken, mcpAddCommand, revokeToken, tokensOf, type TokenListing } from '../auth/tokens.ts';
import { consumeLogin, endOtherSessions, endSession, otherSessions, readSession, SESSION_IDLE, startSession, takeFirstHome } from '../auth/web-sessions.ts';
import { baseFor, isHosted } from '../config.ts';
import { keyedHash, safeEqual } from '../crypto.ts';
import type { Flag } from '../detect/detectors.ts';
import {
  HANDLE,
  isEmail,
  KlatschError,
  type AgentThanksView,
  type ApprovalView,
  type Choice,
  type CircleView,
  type GrantView,
  type IntroView,
  type Klatsch,
  type AskView,
  type NoteView,
  type SharingCircle,
  type SipRow,
  type UserRow,
  type Visibility,
  sourceOfRow,
} from '../service.ts';
import { sourceHost, type Source } from '../source.ts';
import { AGENT_THANKS_PER_DAY, GUEST } from '../copy/agent.ts';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { copy } from './copy.ts';
import { PASSKEY_SCRIPT } from './passkey-script.ts';
import { ICON_SVG, MANIFEST, PUSH_SCRIPT, SERVICE_WORKER } from './push-script.ts';
import { RECORD_SCRIPT } from './record-script.ts';
import { vapidFromSecret } from '../notify/push.ts';
import { avatar, button, dialog, githubLink, googleLink, heart, icon, outcome, pair, screen, signInScreen, tagList, type Tab, type Viewer, chip, GITHUB_ICON, GOOGLE_ICON, KEY_ICON, messenger, CUP_MARK } from './layout.ts';

const COOKIE = 'klatsch_session';
/** A key to the page a visitor without a session wanted, for the redirect after the login link. */
const NEXT_COOKIE = 'klatsch_next';
const NEXT_TTL_MS = 10 * 60 * 1000;
const loginHelp = html`<p class="fine">${copy.signIn.help}</p>`;
const GITHUB_PATH = '/ui/auth/github';
const GOOGLE_PATH = '/ui/auth/google';
/** GitHub sign-ins one address may start, and callbacks it may send, in ten minutes (each counted apart). */
const GITHUB_REQUESTS_PER_ADDRESS = 40;
/** Tries at a free handle in one sign-in, then it ends. */
const HANDLE_TRIES = 10;
/** Joins by public link in ten minutes, per address and per person (each counted apart), against sign-up floods. */
/** Per address in ten minutes. A command polls every three seconds for at most ten minutes, so 200 polls is one person. */
const NOTE_CHECK_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const CONNECT_STARTS_PER_ADDRESS = 20;
const CONNECT_POLLS_PER_ADDRESS = 600;
const JOINS_PER_ADDRESS = 20;
const JOINS_PER_PERSON = 5;
const STORE_CAP = 10_000;
const EMAIL_PATH = '/ui/auth/email';
/** Sign-in links one address (IPv6 by /64) may ask for in an hour, whatever addresses it types. */
const EMAIL_REQUESTS_PER_ADDRESS = 10;
/** Sign-in codes typed per browser, and per client address, an hour: right or wrong. */
const CODE_TRIES_PER_KEY = 20;
/** The webmail inboxes the "Check your email" page links to: the same two for every address, so the page says nothing about it. */
const MAIL_APPS = [
  ['https://mail.google.com/mail/u/0/#inbox', 'openGmail'],
  ['https://outlook.live.com/mail/', 'openOutlook'],
] as const;
const HOUR_MS = 60 * 60 * 1000;
/** How long a passkey prompt may stay open: its challenge is good once, for this long. */
const PASSKEY_CHALLENGE_MS = 5 * 60 * 1000;
/** Passkey sign-in tries (options asked for, answers checked: each counted) per address in an hour. */
const PASSKEY_TRIES_PER_ADDRESS = 30;
/** The form cookie of pages without a session: refreshed by every such page, so twelve hours after the last one. */
const FORM_COOKIE_TTL_S = 12 * 60 * 60;
/** How long a browser someone signed in with counts as theirs for email sign-in limits (the most browsers keep a cookie). */
const KNOWN_TTL_S = 400 * 24 * 60 * 60;

/**
 * What a GitHub sign-in carries between its steps: the attempt until GitHub answers (`linkTo` only when the
 * person asked to connect GitHub on Settings), then either a connection waiting for its confirmation or a
 * new GitHub account joining by an invite or a public circle's join link.
 */
type GitHubStep =
  | { kind: 'attempt'; state: string; verifier: string; linkTo?: string }
  | { kind: 'link'; identity: GitHubIdentity; userId: string }
  | { kind: 'join'; identity: GitHubIdentity; csrf: string; target: JoinTarget; tries: number };

/**
 * What a new person joins by: an invite (single use) or a public circle's join link (anyone, many times). After
 * an email sign-in link, an invite is known by its id: the link is bound to it, and the invite's token is never stored.
 */
type JoinTarget = { kind: 'invite'; token: string } | { kind: 'public'; token: string } | { kind: 'invite-id'; id: string };

/** A new address's sign-in link, once opened and confirmed: the proven address, at its invite or join link. */
type EmailJoin = { email: string; target: JoinTarget; tries: number };

/** The page a join target was opened at, as remembered for after the sign-in. */
const joinTargetOf = (path: string | undefined): JoinTarget | undefined => {
  const found = path?.match(/^\/ui\/(invite|join)\/([\w-]+)$/);
  if (!found) return undefined;
  return found[1] === 'invite' ? { kind: 'invite', token: found[2]! } : { kind: 'public', token: found[2]! };
};

/**
 * Values kept in memory for ten minutes behind a random key that only a cookie holds. Visitors without a
 * session can fill it, so it is bounded: entries expire in the order they were put, so the sweep stops at
 * the first live one (no full scan per put), and at the cap the oldest goes; the worst case is starting over.
 */
function shortLived<T>(ttlMs = NEXT_TTL_MS) {
  const entries = new Map<string, { value: T; expires: number }>();
  const read = (key: string | undefined): T | undefined => {
    const entry = key ? entries.get(key) : undefined;
    return entry && entry.expires > Date.now() ? entry.value : undefined;
  };
  return {
    put(value: T): string {
      const now = Date.now();
      for (const [key, entry] of entries) {
        if (entry.expires > now) break;
        entries.delete(key);
      }
      if (entries.size >= STORE_CAP) entries.delete(entries.keys().next().value!);
      const key = randomBytes(24).toString('base64url');
      entries.set(key, { value, expires: now + ttlMs });
      return key;
    },
    read,
    /** Once only: the entry is gone after this, whether it was still valid or not. */
    take(key: string | undefined): T | undefined {
      const value = read(key);
      if (key) entries.delete(key);
      return value;
    },
  };
}

/** At most `limit` per key in a window. Bounded like `shortLived`: windows end in the order they started. */
export function perKeyLimit(limit: number, windowMs: number) {
  const windows = new Map<string, { start: number; count: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    for (const [k, w] of windows) {
      if (now - w.start < windowMs) break;
      windows.delete(k);
    }
    const current = windows.get(key);
    if (!current) {
      if (windows.size >= STORE_CAP) windows.delete(windows.keys().next().value!);
      windows.set(key, { start: now, count: 1 });
      return true;
    }
    return ++current.count <= limit;
  };
}

/**
 * The key a per-address join limit counts by: an IPv4 address as it is, an IPv6 address by its /64 (one
 * subscriber usually holds a whole /64, so counting single addresses would not limit anything).
 */
export function addressKey(address: string): string {
  const ip = address.replace(/%.*$/, '').toLowerCase();
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1]!;
  if (!ip.includes(':')) return ip;
  const [head = '', tail] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** `/approvals/:id` as an exact pattern: literal segments, and a parameter of word characters and `-` only. */
const routePattern = (path: string) =>
  new RegExp(`^${path.split('/').map((part) => (part.startsWith(':') ? '[\\w-]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}$`);

type Env = { Variables: { userId: string; csrf: string; session: string } };

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
/** The pages with a passkey button: the same, plus the one same-origin script and its posts back to the relay. */
const SCRIPT_CSP = "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
/** A conversation page: the recorder script (/ui/record.js), and voice notes that play from this relay. */
const CHAT_CSP = SCRIPT_CSP.replace("img-src 'self' data:;", "img-src 'self' data:; media-src 'self';");

/**
 * The OAuth consent page: its form is answered with a redirect back to the client, and browsers check that
 * redirect against form-action too, so that one origin (a registered, validated redirect URI's) is added.
 * Chrome checks every later redirect of the same navigation as well, and some clients' callbacks redirect
 * on to another of their own sites (ChatGPT's developer platform goes chatgpt.com → platform.openai.com),
 * so any https origin may follow. The form itself still only posts here: the page runs no script.
 */
/** A file someone sent, opened in the browser: sandboxed, nothing runs, nothing loads from elsewhere. */
const FILE_CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox";
const CONSENT_CSP_START = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; manifest-src 'self'; form-action 'self' ";
const consentCsp = (redirectUri: string) => `${CONSENT_CSP_START}${new URL(redirectUri).origin} https:; frame-ancestors 'none'; base-uri 'none'`;

/** The headers of every page the relay serves to a browser: the web UI and the landing page at `/`. */
/** Night or day, as the person chose it in the menu; without the cookie the device decides. */
export const THEME_COOKIE = 'klatsch_theme';
const THEMES = ['light', 'dark'] as const;
export const pageHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  // A chosen theme marks the page's <html>, so the page's own colours follow it without any script.
  const theme = getCookie(c, THEME_COOKIE);
  if ((THEMES as readonly string[]).includes(theme ?? '') && (c.res.headers.get('content-type') ?? '').startsWith('text/html')) {
    const body = await c.res.text();
    c.res = new Response(body.replace('<html lang="en">', `<html lang="en" data-theme="${theme}">`), c.res);
  }
  // Only pages that run a script of ours set their own policy (passkeys, notifications, the voice note recorder on a
  // conversation); they keep it, all else gets none.
  const own = c.res.headers.get('Content-Security-Policy');
  c.header('Content-Security-Policy', own === SCRIPT_CSP || own === CHAT_CSP || own === FILE_CSP || (own !== null && own.startsWith(CONSENT_CSP_START)) ? own : PAGE_CSP);
  // same-origin, not no-referrer: under no-referrer browsers send `Origin: null` on form posts,
  // which the Origin checks then refuse. The login token still never leaves this origin.
  c.header('Referrer-Policy', 'same-origin');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Cache-Control', 'no-store');
};

/** Server-rendered; no JavaScript but the passkey script on sign-in and Settings. Every interpolation is escaped by `html`. */
export function webRoutes(klatsch: Klatsch, secret: Buffer): Hono<Env> {
  const web = new Hono<Env>();
  const { db, config } = klatsch;
  const secure = config.publicUrl.startsWith('https://');
  /** In local mode, 127.0.0.1 or localhost as the request came in; hosted, always `publicUrl`. */
  const base = (c: Context) => baseFor(config, c.req.header('host'));

  // The page to return to after signing in. The cookie holds only a random key; the path stays here for
  // ten minutes, because it can carry a secret (an invite or confirmation token). In memory, like the code tries.
  const returns = shortLived<string>();
  /** Only a page one of the GET routes below answers (not the dashboard, not a form target, not a typo). */
  const isPage = (path: string): boolean =>
    path.startsWith('/ui/') && web.routes.some((route) => route.method === 'GET' && route.path !== '/' && route.path !== '/login' && routePattern(route.path).test(path.slice(3)));
  /** Not when another site sent the browser here: it must not choose where a login lands. */
  const navigatedHere = (c: Context) => ['none', 'same-origin', undefined].includes(c.req.header('Sec-Fetch-Site'));
  // Only on the public URL: GitHub sends people back to exactly that origin (in local mode, not to localhost).
  const github = (c: Context) => (config.github && base(c) === config.publicUrl ? config.github : undefined);
  const githubButton = (c: Context) =>
    github(c) ? html`<a class="button primary" href="${GITHUB_PATH}">${copy.signIn.github}</a><p class="fine">${copy.signIn.githubNote}</p>` : '';

  web.use('*', pageHeaders);

  // A browser someone signed in with, remembered long after the session by a value only the relay can make (a
  // random part and its HMAC with the person's id): their email sign-in requests from it are not held back by
  // what strangers ask for their address. Host-only, HttpOnly; it opens nothing by itself.
  const knownCookie = secure ? { name: '__Host-klatsch_known', path: '/' } : { name: 'klatsch_known', path: '/ui' };
  const knownTag = (userId: string, random: string) => keyedHash(secret, `known ${userId} ${random}`);
  const isKnownFor = (value: string | undefined, userId: string) => {
    const [random, tag, extra] = value?.split('.') ?? [];
    return Boolean(random && tag && extra === undefined && safeEqual(tag, knownTag(userId, random)));
  };
  /** The keys a browser asks for links under: its known cookie's random part, else its form cookie's value. */
  const knownKey = (value: string | undefined) => `known ${value?.split('.')[0] ?? ''}`;
  const formKey = (nonce: string | undefined) => `form ${nonce ?? ''}`;

  /** Sets the new session's cookie and goes back to the page remembered for this browser, once, or home. */
  const enter = (c: Context, session: string, userId: string) => c.redirect(arrive(c, session, userId), 303);
  /** `enter` without the redirect: sets the cookies and returns where to go, for an answer the passkey script follows. */
  const arrive = (c: Context, session: string, userId: string): string => {
    // Lax, not Strict: approval links are opened from the MCP client (another app), and the session must
    // reach that page; so must GitHub's redirect back. Every state change is a POST with a form token and an Origin check.
    setCookie(c, COOKIE, session, { httpOnly: true, sameSite: 'Lax', secure, path: '/ui', maxAge: SESSION_IDLE / 1000 });
    const random = randomBytes(18).toString('base64url');
    setCookie(c, knownCookie.name, `${random}.${knownTag(userId, random)}`, { httpOnly: true, sameSite: 'Lax', secure, path: knownCookie.path, maxAge: KNOWN_TTL_S });
    const key = getCookie(c, NEXT_COOKIE);
    if (key !== undefined) deleteCookie(c, NEXT_COOKIE, { path: '/ui' });
    return returns.take(key) ?? '/ui';
  };

  // ---------- review accounts (a chat app directory's reviewers: a handle and a password, no codes) ----------

  const allowReviewAddress = perKeyLimit(10, HOUR_MS);
  const allowReviewHandle = perKeyLimit(10, HOUR_MS);
  let reviewChecks = 0;
  const reviewForm = (c: Context, failed: boolean) =>
    c.html(
      signInScreen(
        copy.review.title,
        html`<p class="lead">${copy.review.lead}</p>
          ${failed ? html`<p class="flag" role="alert">${copy.review.failed}</p>` : ''}
          <form class="mail" method="post" action="/ui/review-login">
            <input type="hidden" name="csrf" value="${formToken(c)}" />
            <input type="text" name="handle" maxlength="40" required autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="${copy.review.handle}" aria-label="${copy.review.handle}" />
            <input type="password" name="password" maxlength="100" required autocomplete="current-password" placeholder="${copy.review.password}" aria-label="${copy.review.password}" />
            <button class="primary">${copy.review.signIn}</button>
          </form>
          <p>${copy.review.note}</p>`,
      ),
      failed ? 401 : 200,
    );
  web.get('/review-login', (c) => (klatsch.hasReviewAccounts() ? reviewForm(c, false) : c.notFound()));
  web.post('/review-login', async (c) => {
    if (!klatsch.hasReviewAccounts()) return c.notFound();
    const refused = await refusedForm(c);
    if (refused) return refused;
    const form = await c.req.parseBody();
    const handle = typeof form.handle === 'string' ? form.handle.slice(0, 40) : '';
    const password = typeof form.password === 'string' ? form.password.slice(0, 100) : '';
    const busy = () => c.html(notice(copy.signIn.busyTitle, html`<p class="sub">${copy.signIn.busy}</p>`), 429);
    if (!allowReviewAddress(addressKey(address(c))) || !allowReviewHandle(normalHandle(handle))) return busy();
    // scrypt costs memory and time: a few checks at once, never a queue someone can grow.
    if (reviewChecks >= 4) return busy();
    reviewChecks++;
    let userId: string | undefined;
    try {
      userId = await klatsch.passwordSignIn(handle, password);
    } finally {
      reviewChecks--;
    }
    return userId ? signIn(c, userId) : reviewForm(c, true);
  });

  web.get('/login', (c) => {
    const login = consumeLogin(db, secret, c.req.query('t') ?? '');
    if (!login) return c.html(notice(copy.signIn.expiredTitle, html`<p class="sub">${copy.signIn.expired}</p>${loginHelp}${githubButton(c)}`), 401);
    return enter(c, login.session, login.userId);
  });

  // ---------- guests ("Try it without an account": a few hours with the demo friend only) ----------

  const allowGuestHour = perKeyLimit(3, HOUR_MS);
  const allowGuestDay = perKeyLimit(10, 24 * HOUR_MS);
  const guestLinkGone = (c: Context) => c.html(notice(copy.invite.title, html`<p class="sub">${copy.invite.invalid}</p>`), 410);
  const guestBusy = (c: Context, status: 429 | 503) => c.html(notice(copy.guest.busyTitle, html`<p class="sub">${GUEST.busy}</p>`), status);
  web.get('/guest', (c) => {
    if (!config.guest) return c.notFound();
    const t = copy.guest;
    return c.html(
      signInScreen(
        t.title(GUEST_HOURS),
        html`<p class="lead">${t.lead}</p>
          <ul>${t.points(GUEST_HOURS).map((line) => html`<li>${line}</li>`)}</ul>
          <form class="mail" method="post" action="/ui/guest">
            <input type="hidden" name="csrf" value="${formToken(c)}" />
            <button class="primary">${t.start}</button>
          </form>
          <p><a href="/ui">${t.signInInstead}</a></p>`,
      ),
    );
  });
  web.post('/guest', async (c) => {
    if (!config.guest) return c.notFound();
    const refused = await refusedForm(c);
    if (refused) return refused;
    // Both windows count every try, so a network cannot make guests faster by spreading them out.
    const key = addressKey(address(c));
    if (![allowGuestHour(key), allowGuestDay(key)].every(Boolean)) return guestBusy(c, 429);
    // From a guest's friend link: join that guest at once, and go straight to the conversation.
    const form = await c.req.parseBody();
    const token = typeof form.invite === 'string' ? form.invite : '';
    const invite = token ? findInvite(db, secret, token) : undefined;
    if (token && (!invite || !klatsch.isGuest(invite.createdBy))) return guestLinkGone(c);
    let guest: string;
    try {
      guest = klatsch.startGuest();
    } catch (error) {
      if (error instanceof KlatschError) return guestBusy(c, 503);
      throw error;
    }
    if (invite) {
      try {
        klatsch.acceptInvite(guest, invite);
      } catch (error) {
        if (!(error instanceof KlatschError)) throw error;
        klatsch.endGuest(guest, 'web');
        return guestLinkGone(c);
      }
      const earlier = getCookie(c, COOKIE);
      if (earlier) endSession(db, secret, earlier);
      arrive(c, startSession(db, secret, guest).session, guest);
      return c.redirect(`/ui/chat/${encodeURIComponent(klatsch.user(invite.createdBy).handle)}`, 303);
    }
    // Back to where this browser was going (the consent page of a chat app being connected), else Home.
    return signIn(c, guest);
  });

  // ---------- sign in with GitHub ----------

  const callbackUrl = `${config.publicUrl}${GITHUB_PATH}/callback`;
  const githubSteps = shortLived<GitHubStep>();
  // Host-only: never a Domain attribute. On https with the __Host- prefix (which needs Path=/), so a sibling
  // subdomain cannot plant or shadow it; on a local http relay the browser would refuse the prefix.
  const step = secure ? { name: '__Host-klatsch_github', path: '/' } : { name: 'klatsch_github', path: GITHUB_PATH };
  const setStep = (c: Context, value: GitHubStep) =>
    setCookie(c, step.name, githubSteps.put(value), { httpOnly: true, sameSite: 'Lax', secure, path: step.path, maxAge: NEXT_TTL_MS / 1000 });
  /** The step this browser is at, used up (`take`) or only looked at. */
  const stepOf = (c: Context, take: boolean) => {
    const key = getCookie(c, step.name);
    if (!take) return githubSteps.read(key);
    if (key !== undefined) deleteCookie(c, step.name, { path: step.path, secure });
    return githubSteps.take(key);
  };
  const allowAddress = perKeyLimit(GITHUB_REQUESTS_PER_ADDRESS, NEXT_TTL_MS);
  /**
   * Who asks, for the per-address limit. Hosted: the address Caddy saw, which it puts last in
   * X-Forwarded-For (it ignores what a client sends there). Local: the socket's address.
   */
  const address = (c: Context): string => {
    if (isHosted(config)) return c.req.header('X-Forwarded-For')?.split(',').at(-1)?.trim() || 'unknown';
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      return 'unknown';
    }
  };
  const githubFailed = (c: Context, title: string = copy.signIn.failedTitle, line: string = copy.signIn.failed, status: 400 | 409 | 429 = 400) =>
    c.html(notice(title, html`<p class="sub">${line}</p>${githubButton(c)}`), status);
  const tooMany = (c: Context) => githubFailed(c, copy.signIn.busyTitle, copy.signIn.busy, 429);
  /** Signs this browser in as `userId`, ending a session it had (perhaps someone else's). */
  const signIn = (c: Context, userId: string) => {
    const earlier = getCookie(c, COOKIE);
    if (earlier) endSession(db, secret, earlier);
    return enter(c, startSession(db, secret, userId).session, userId);
  };
  /** The handle a GitHub login gives, when it is a valid one nobody here has. */
  const freeHandle = (login: string): string | undefined => {
    const handle = login.toLowerCase();
    return HANDLE.test(handle) && !reservedHandle(handle) && !db.prepare('SELECT 1 FROM users WHERE handle = ?').get(handle) ? handle : undefined;
  };
  /**
   * What a join target shows and how it is accepted, while it is valid: an invite names who invites; a public
   * circle says it is public and how many are in it.
   */
  const joinView = (target: JoinTarget, viewerName: string) => {
    if (target.kind !== 'public') {
      const invite = target.kind === 'invite' ? findInvite(db, secret, target.token) : inviteById(db, target.id);
      return (
        invite && {
          heading: copy.invite.heading,
          top: pair(invite.inviterName, viewerName, { leftBlue: true, rightBlue: false }),
          line: copy.invite.line(invite.inviterName, invite.inviterHandle, invite.circleName),
          note: copy.invite.note,
          accept: (userId: string) => klatsch.acceptInvite(userId, invite),
          circle: { id: invite.circleId, invite },
        }
      );
    }
    const circle = klatsch.publicCircle(target.token);
    return (
      circle && {
        heading: copy.commons.heading(circle.name),
        top: icon(),
        line: copy.commons.line(circle.people),
        note: copy.commons.note,
        accept: (userId: string) => klatsch.joinPublic(userId, target.token),
        circle: { id: circle.id },
      }
    );
  };
  type JoinView = NonNullable<ReturnType<typeof joinView>>;
  /** The join page of a GitHub sign-in: a handle field only when the login cannot be one. */
  const githubJoinPage = (c: Context, at: Extract<GitHubStep, { kind: 'join' }>, view: JoinView, refused: boolean) =>
    joinPage(c, { action: `${GITHUB_PATH}/join`, csrf: at.csrf }, view, freeHandle(at.identity.login) ? undefined : copy.signIn.pickLead(at.identity.login.toLowerCase()), refused);
  const invalidTarget = (target: JoinTarget) =>
    target.kind !== 'public' ? notice(copy.invite.invalidTitle, html`<p class="sub">${copy.invite.invalid}</p>`) : notice(copy.commons.invalidTitle, html`<p class="sub">${copy.commons.invalid}</p>`);
  const allowJoinFrom = perKeyLimit(JOINS_PER_ADDRESS, NEXT_TTL_MS);
  const allowJoinBy = perKeyLimit(JOINS_PER_PERSON, NEXT_TTL_MS);

  /**
   * Someone who is nobody here yet, at an invite or a join link: Join, with a handle field when `lead` says why
   * one is needed (a GitHub login that cannot be one, or a new address, which brings none).
   */
  const joinPage = (c: Context, form: { action: string; csrf: string }, view: JoinView, lead: unknown, refused: boolean) => {
    const pick = refused || lead !== undefined;
    return c.html(
      dialog(
        view.heading,
        undefined,
        html`${view.top}
          <h1 id="title">${view.heading}</h1>
          <p class="sub">${view.line}</p>
          <form method="post" action="${form.action}">
            <input type="hidden" name="csrf" value="${form.csrf}" />
            ${pick
              ? html`<p class="sub">${refused ? copy.signIn.pickRefused : lead}</p>
                  <input name="handle" maxlength="39" autocomplete="username" autocapitalize="none" spellcheck="false" aria-label="${copy.signIn.handleLabel}" />
                  <p class="fine">${copy.signIn.pickNote}</p>`
              : ''}
            <button class="primary">${copy.invite.join}</button>
          </form>
          <p class="fine">${view.note}</p>`,
      ),
      refused ? 409 : 200,
    );
  };

  // A link, not a form: a form's redirect to github.com would need the CSP to allow it as a form target.
  // It only ever signs in; connecting GitHub to a signed-in person starts from Settings (a form post).
  web.get('/auth/github', (c) => {
    const app = github(c);
    if (!app) return c.notFound();
    // Only from this relay's own pages: another site must not start a sign-in in this browser.
    if (!navigatedHere(c)) return c.redirect('/ui', 303);
    if (!allowAddress(`start ${addressKey(address(c))}`)) return tooMany(c);
    const { state, verifier } = newAttempt();
    setStep(c, { kind: 'attempt', state, verifier });
    return c.redirect(authorizeUrl(app, callbackUrl, state, verifier), 302);
  });

  web.get('/auth/github/callback', async (c) => {
    const app = github(c);
    if (!app) return c.notFound();
    if (!allowAddress(`callback ${addressKey(address(c))}`)) return tooMany(c);
    // One use: a replayed callback finds nothing, whatever its code.
    const attempt = stepOf(c, true);
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (attempt?.kind !== 'attempt' || !code || !state || !safeEqual(state, attempt.state)) return githubFailed(c);
    const identity = await identify(app, code, attempt.verifier, callbackUrl);
    if (!identity) return githubFailed(c);
    if (attempt.linkTo) {
      // Nothing is written yet: the person confirms which GitHub account they connect, in their own session.
      const session = getCookie(c, COOKIE);
      const still = session ? readSession(db, secret, session) : undefined;
      if (still?.userId !== attempt.linkTo) return githubFailed(c);
      if (klatsch.userByGitHub(identity.id)) return githubFailed(c, copy.signIn.inUseTitle, copy.signIn.inUse, 409);
      setStep(c, { kind: 'link', identity, userId: still.userId });
      return c.html(
        dialog(
          copy.settings.connectTitle,
          { name: klatsch.user(still.userId).display_name, csrf: still.csrf },
          html`${icon()}
            <h1 id="title">${copy.settings.connectTitle}</h1>
            <p class="sub">${copy.settings.connectQuestion(identity.login)}</p>
            <div class="two">${button(`${GITHUB_PATH}/cancel`, copy.settings.cancel, still.csrf)}${button(`${GITHUB_PATH}/link`, copy.settings.connect, still.csrf, 'primary')}</div>`,
        ),
      );
    }
    const userId = klatsch.userByGitHub(identity.id);
    if (userId) {
      klatsch.noteGitHubLogin(userId, identity.login);
      return signIn(c, userId);
    }
    // Nobody here yet: a person is made only when they join a circle, so they need the invite or join link they came from.
    const key = getCookie(c, NEXT_COOKIE);
    if (key !== undefined) deleteCookie(c, NEXT_COOKIE, { path: '/ui' });
    const target = joinTargetOf(returns.take(key));
    const view = target && joinView(target, '?');
    if (!target || !view) {
      return c.html(notice(copy.noCircle.title, html`<p class="sub">${copy.noCircle.signedInGitHub(identity.login)}</p><p class="sub">${copy.noCircle.line}</p><p class="sub">${copy.noCircle.chatApp}</p>`));
    }
    const join = { kind: 'join' as const, identity, csrf: randomBytes(24).toString('base64url'), target, tries: 0 };
    setStep(c, join);
    return githubJoinPage(c, join, view, false);
  });

  // No session yet, so the step's own form token and the exact Origin guard this post.
  web.post('/auth/github/join', async (c) => {
    if (!github(c)) return c.notFound();
    if (c.req.header('Origin') !== new URL(config.publicUrl).origin) return c.text(copy.layout.crossOrigin, 403);
    const at = stepOf(c, false);
    const form = await c.req.parseBody();
    if (at?.kind !== 'join' || typeof form.csrf !== 'string' || !safeEqual(form.csrf, at.csrf)) return githubFailed(c);
    const view = joinView(at.target, '?');
    if (!view) {
      stepOf(c, true);
      return c.html(invalidTarget(at.target), 404);
    }
    if (at.target.kind === 'public' && !allowJoinFrom(`join ${addressKey(address(c))}`)) return tooMany(c);
    const typed = typeof form.handle === 'string' ? form.handle.trim().toLowerCase() : undefined;
    let joined: string | 'taken';
    try {
      joined = klatsch.joinWithGitHub(at.identity, typed ?? freeHandle(at.identity.login) ?? '', view.accept);
    } catch (error) {
      if (!(error instanceof KlatschError)) throw error;
      stepOf(c, true);
      return at.target.kind !== 'public' ? c.html(invalidTarget(at.target), 404) : c.html(notice(copy.layout.notPossible, html`<p class="sub">${error.message}</p>`), 409);
    }
    if (joined === 'taken') {
      if (++at.tries >= HANDLE_TRIES) {
        stepOf(c, true);
        return githubFailed(c);
      }
      return githubJoinPage(c, at, view, true);
    }
    stepOf(c, true);
    return signIn(c, joined);
  });

  // ---------- sign in with Google: the same steps and rules as GitHub's ----------

  const google = (c: Context) => (config.google && base(c) === config.publicUrl ? config.google : undefined);
  const googleCallback = `${config.publicUrl}${GOOGLE_PATH}/callback`;
  const googleSteps = shortLived<GoogleStep>();
  const gStep = secure ? { name: '__Host-klatsch_google', path: '/' } : { name: 'klatsch_google', path: GOOGLE_PATH };
  const setGoogleStep = (c: Context, value: GoogleStep) =>
    setCookie(c, gStep.name, googleSteps.put(value), { httpOnly: true, sameSite: 'Lax', secure, path: gStep.path, maxAge: NEXT_TTL_MS / 1000 });
  const googleStepOf = (c: Context, take: boolean) => {
    const key = getCookie(c, gStep.name);
    if (!take) return googleSteps.read(key);
    if (key !== undefined) deleteCookie(c, gStep.name, { path: gStep.path, secure });
    return googleSteps.take(key);
  };
  const googleButton = (c: Context) => (google(c) ? html`<a class="button primary" href="${GOOGLE_PATH}">${copy.signIn.google}</a><p class="fine">${copy.signIn.googleNote}</p>` : '');
  const googleFailed = (c: Context, title: string = copy.signIn.failedTitle, line: string = copy.signIn.googleFailed, status: 400 | 409 | 429 = 400) =>
    c.html(notice(title, html`<p class="sub">${line}</p>${googleButton(c)}`), status);
  const googleJoinPage = (c: Context, at: Extract<GoogleStep, { kind: 'join' }>, view: JoinView, refused: boolean) =>
    joinPage(c, { action: `${GOOGLE_PATH}/join`, csrf: at.csrf }, view, freeHandle(at.identity.login) ? undefined : copy.signIn.pickEmail(at.identity.email), refused);

  web.get('/auth/google', (c) => {
    const app = google(c);
    if (!app) return c.notFound();
    if (!navigatedHere(c)) return c.redirect('/ui', 303);
    if (!allowAddress(`gstart ${addressKey(address(c))}`)) return googleFailed(c, copy.signIn.busyTitle, copy.signIn.busy, 429);
    const attempt = newGoogleAttempt();
    setGoogleStep(c, { kind: 'attempt', ...attempt });
    return c.redirect(googleAuthorizeUrl(app, googleCallback, attempt), 302);
  });

  web.get('/auth/google/callback', async (c) => {
    const app = google(c);
    if (!app) return c.notFound();
    if (!allowAddress(`gcallback ${addressKey(address(c))}`)) return googleFailed(c, copy.signIn.busyTitle, copy.signIn.busy, 429);
    // One use: a replayed callback finds nothing, whatever its code.
    const attempt = googleStepOf(c, true);
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (attempt?.kind !== 'attempt' || !code || !state || !safeEqual(state, attempt.state)) return googleFailed(c);
    const identity = await identifyGoogle(app, code, attempt, googleCallback);
    if (!identity) return googleFailed(c);
    if (attempt.linkTo) {
      const session = getCookie(c, COOKIE);
      const still = session ? readSession(db, secret, session) : undefined;
      if (still?.userId !== attempt.linkTo) return googleFailed(c);
      if (klatsch.userByGoogle(identity.sub)) return googleFailed(c, copy.signIn.googleInUseTitle, copy.signIn.googleInUse, 409);
      setGoogleStep(c, { kind: 'link', identity, userId: still.userId });
      return c.html(
        dialog(
          copy.settings.googleConnectTitle,
          { name: klatsch.user(still.userId).display_name, csrf: still.csrf },
          html`${icon()}
            <h1 id="title">${copy.settings.googleConnectTitle}</h1>
            <p class="sub">${copy.settings.googleConnectQuestion(identity.email)}</p>
            <div class="two">${button(`${GOOGLE_PATH}/cancel`, copy.settings.cancel, still.csrf)}${button(`${GOOGLE_PATH}/link`, copy.settings.connect, still.csrf, 'primary')}</div>`,
        ),
      );
    }
    const userId = klatsch.userByGoogle(identity.sub);
    if (userId) {
      klatsch.noteGoogleSignIn(userId, identity.email);
      return signIn(c, userId);
    }
    // Never found by address: an address someone here has is told so, and connects Google from their own Settings.
    if (klatsch.usersByEmail(identity.email).length || klatsch.mailboxTaken(identity.email)) {
      return c.html(notice(copy.signIn.googleAddressTitle, html`<p class="sub">${copy.signIn.googleAddress}</p>`), 409);
    }
    const key = getCookie(c, NEXT_COOKIE);
    if (key !== undefined) deleteCookie(c, NEXT_COOKIE, { path: '/ui' });
    const target = joinTargetOf(returns.take(key));
    const view = target && joinView(target, '?');
    if (!target || !view) {
      return c.html(notice(copy.noCircle.title, html`<p class="sub">${copy.noCircle.signedInGoogle(identity.email)}</p><p class="sub">${copy.noCircle.line}</p><p class="sub">${copy.noCircle.chatApp}</p>`));
    }
    const join = { kind: 'join' as const, identity, csrf: randomBytes(24).toString('base64url'), target, tries: 0 };
    setGoogleStep(c, join);
    return googleJoinPage(c, join, view, false);
  });

  // No session yet, so the step's own form token and the exact Origin guard this post.
  web.post('/auth/google/join', async (c) => {
    if (!google(c)) return c.notFound();
    if (c.req.header('Origin') !== new URL(config.publicUrl).origin) return c.text(copy.layout.crossOrigin, 403);
    const at = googleStepOf(c, false);
    const form = await c.req.parseBody();
    if (at?.kind !== 'join' || typeof form.csrf !== 'string' || !safeEqual(form.csrf, at.csrf)) return googleFailed(c);
    const view = joinView(at.target, '?');
    if (!view) {
      googleStepOf(c, true);
      return c.html(invalidTarget(at.target), 404);
    }
    if (at.target.kind === 'public' && !allowJoinFrom(`join ${addressKey(address(c))}`)) return googleFailed(c, copy.signIn.busyTitle, copy.signIn.busy, 429);
    const typed = typeof form.handle === 'string' ? form.handle.trim().toLowerCase() : undefined;
    let joined: string | 'taken';
    try {
      joined = klatsch.joinWithGoogle(at.identity, typed ?? freeHandle(at.identity.login) ?? '', view.accept, view.circle);
    } catch (error) {
      if (!(error instanceof KlatschError)) throw error;
      googleStepOf(c, true);
      return at.target.kind !== 'public' ? c.html(invalidTarget(at.target), 404) : c.html(notice(copy.layout.notPossible, html`<p class="sub">${error.message}</p>`), 409);
    }
    if (joined === 'taken') {
      if (++at.tries >= HANDLE_TRIES) {
        googleStepOf(c, true);
        return googleFailed(c);
      }
      return googleJoinPage(c, at, view, true);
    }
    googleStepOf(c, true);
    return signIn(c, joined);
  });

  // ---------- sign in by email ----------

  // Forms shown without a session (the address on the sign-in page, the link's confirm page, the join page after
  // it) carry a form token derived from a random value in a host-only cookie, so the relay keeps nothing per page
  // view; with the exact Origin, another site cannot post them. The same value tells which browser asked for a link.
  const formCookie = secure ? { name: '__Host-klatsch_form', path: '/' } : { name: 'klatsch_form', path: '/ui' };
  const formTokenOf = (nonce: string) => keyedHash(secret, `form ${nonce}`);
  /** This browser's value, if it sent a well-formed one. */
  const formNonce = (c: Context): string | undefined => {
    const nonce = getCookie(c, formCookie.name);
    return nonce && /^[\w-]{32}$/.test(nonce) ? nonce : undefined;
  };
  /** The form token for a page; each page sets the cookie again, so a page left open for hours still posts. */
  const formToken = (c: Context): string => {
    const nonce = formNonce(c) ?? randomBytes(24).toString('base64url');
    setCookie(c, formCookie.name, nonce, { httpOnly: true, sameSite: 'Lax', secure, path: formCookie.path, maxAge: FORM_COOKIE_TTL_S });
    return formTokenOf(nonce);
  };
  /** Null when the post may go on; otherwise the refusal, as for a signed-in form. */
  const refusedForm = async (c: Context) => {
    if (c.req.header('Origin') !== new URL(base(c)).origin) return c.text(copy.layout.crossOrigin, 403);
    const sent = (await c.req.parseBody()).csrf;
    const nonce = formNonce(c);
    return typeof sent === 'string' && nonce && safeEqual(sent, formTokenOf(nonce)) ? null : c.text(copy.layout.badFormToken, 403);
  };

  // A new address's join step, like GitHub's: in memory behind a host-only cookie key.
  const emailJoins = shortLived<EmailJoin>();
  const joinCookie = secure ? { name: '__Host-klatsch_email', path: '/' } : { name: 'klatsch_email', path: EMAIL_PATH };
  const emailJoinOf = (c: Context, take: boolean) => {
    const key = getCookie(c, joinCookie.name);
    if (!take) return emailJoins.read(key);
    if (key !== undefined) deleteCookie(c, joinCookie.name, { path: joinCookie.path, secure });
    return emailJoins.take(key);
  };
  const emailJoinPage = (c: Context, email: string, view: JoinView, refused: boolean) =>
    joinPage(c, { action: `${EMAIL_PATH}/join`, csrf: formToken(c) }, view, copy.signIn.pickEmail(email), refused);
  const allowEmailFrom = perKeyLimit(EMAIL_REQUESTS_PER_ADDRESS, HOUR_MS);
  /** At most one "someone signed in" mail per person an hour: enough to notice, not a stream. */
  const allowSignInNotice = perKeyLimit(1, HOUR_MS);
  // The email path's own refusals: nothing here is about GitHub.
  const emailBusy = (c: Context) => c.html(notice(copy.signIn.busyTitle, html`<p class="sub">${copy.signIn.busy}</p>`), 429);

  /**
   * What a link for a new address is bound to: the invite by its id, or the public join link, while either is valid
   * and the circle did not remove someone who had this address's mailbox.
   */
  const joinRefOf = (target: JoinTarget, email: string): JoinRef | undefined => {
    if (target.kind === 'public') {
      const circle = klatsch.publicCircle(target.token);
      return circle && !klatsch.mailboxRemovedFrom(email, circle.id) ? { kind: 'public', ref: target.token } : undefined;
    }
    const invite = target.kind === 'invite' ? findInvite(db, secret, target.token) : inviteById(db, target.id);
    return invite && !klatsch.mailboxRemovedFrom(email, invite.circleId, invite) ? { kind: 'invite', ref: invite.id } : undefined;
  };
  const targetOfRef = (join: JoinRef): JoinTarget => (join.kind === 'public' ? { kind: 'public', token: join.ref } : { kind: 'invite-id', id: join.ref });

  /**
   * Mails a link to the one person whose confirmed address this is, or, at a valid invite or join link, to an
   * address nobody here has whose mailbox nobody here has either; to anyone else nothing. Within the limits.
   */
  const mailSignInLink = (email: string, nonce: string, known: string | undefined, target: JoinTarget | undefined, at: string) => {
    if (!isEmail(email)) return;
    const people = klatsch.usersByEmail(email);
    const join = people.length === 0 && target && !klatsch.mailboxTaken(email) ? joinRefOf(target, email) : undefined;
    if (people.length !== 1 && !join) return;
    // A known browser is counted by its known cookie, which it cannot swap for a fresh one the way it can a form cookie.
    const isKnown = people.length === 1 && isKnownFor(known, people[0]!);
    const sent = createEmailLogin(db, secret, { email, browser: isKnown ? knownKey(known) : formKey(nonce), join, known: isKnown }, at);
    if (!sent) return;
    klatsch.signInMailer!.link(email, sent.link, sent.code);
    klatsch.audit(people[0] ?? null, 'web', 'email.signin.send');
  };

  // The same page for every address, known or not, refused or limited: it tells nobody who has an account here.
  // What happens next runs after the answer, so its timing does not tell either.
  web.post('/auth/email', async (c) => {
    if (!klatsch.signInMailer) return c.notFound();
    const refused = await refusedForm(c);
    if (refused) return refused;
    const typed = (await c.req.parseBody()).email;
    const email = typeof typed === 'string' ? normalEmail(typed) : '';
    const nonce = formNonce(c)!;
    const known = getCookie(c, knownCookie.name);
    // A new address joins only by the invite or join link this browser came from (remembered for after signing in).
    const target = joinTargetOf(returns.read(getCookie(c, NEXT_COOKIE)));
    const at = base(c);
    if (allowEmailFrom(`email ${addressKey(address(c))}`)) {
      setImmediate(() => {
        try {
          mailSignInLink(email, nonce, known, target, at);
        } catch {
          console.error('[klatsch] email sign-in link failed');
        }
      });
    }
    const t = copy.emailSignIn;
    return c.html(notice(t.sentTitle, html`<p class="sub">${t.sent}</p>${codeForm(c)}${target ? '' : html`<p class="sub">${t.sentNew}</p>`}`, false));
  });

  /**
   * The code from the mail, typed in this browser, and the two webmail inboxes. No JavaScript: one field, which phones
   * can fill from the mail (`one-time-code`). The same for every address.
   */
  const codeForm = (c: Context) => {
    const t = copy.emailSignIn;
    return html`<form method="post" action="${EMAIL_PATH}/code">
        <input type="hidden" name="csrf" value="${formToken(c)}" />
        <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="\\d{3} ?\\d{3}" maxlength="7" required placeholder="${t.codePlaceholder}" aria-label="${t.codeLabel}" />
        <button class="primary">${t.codeButton}</button>
      </form>
      <nav class="mailapps" aria-label="${t.mailApps}">${MAIL_APPS.map(
        ([href, label]) => html`<a class="button" href="${href}" target="_blank" rel="noopener noreferrer">${t[label]} <span aria-hidden="true">↗</span></a>`,
      )}</nav>`;
  };

  // Unknown, used and expired links all get the same page.
  const invalidEmailLink = (c: Context) =>
    c.html(notice(copy.emailSignIn.invalidTitle, html`<p class="sub">${copy.emailSignIn.invalid}</p>`), 404);

  // Mail scanners fetch links before the person opens them, so opening one changes nothing: a form post signs in.
  web.get('/auth/email/:token', (c) => {
    if (!klatsch.signInMailer) return c.notFound();
    const known = getCookie(c, knownCookie.name);
    const login = findEmailLogin(db, secret, c.req.param('token'), [formKey(formNonce(c)), ...(known ? [knownKey(known)] : [])]);
    if (!login) return invalidEmailLink(c);
    const t = copy.emailSignIn;
    return c.html(
      dialog(
        t.confirmTitle,
        undefined,
        html`${icon()}
          <h1 id="title">${t.confirmTitle}</h1>
          <p class="sub">${t.confirmLine}</p>
          ${login.sameBrowser ? '' : html`<p class="flag">${t.otherBrowser}</p>`}
          ${button(`${EMAIL_PATH}/${c.req.param('token')}`, t.confirm(login.email), formToken(c), 'primary')}`,
      ),
    );
  });

  const allowCodeFrom = perKeyLimit(CODE_TRIES_PER_KEY, HOUR_MS);
  const codeFailed = (c: Context) =>
    c.html(notice(copy.emailSignIn.codeFailedTitle, html`<p class="sub">${copy.emailSignIn.codeFailed}</p>${codeForm(c)}`), 400);

  // Only the newest link this browser asked for, by the keys it asked with: a code typed elsewhere finds nothing.
  // Registered before `/auth/email/:token`, which would take this path too.
  web.post('/auth/email/code', async (c) => {
    if (!klatsch.signInMailer) return c.notFound();
    const refused = await refusedForm(c);
    if (refused) return refused;
    const nonce = formNonce(c)!;
    if (!allowCodeFrom(`code ${addressKey(address(c))}`) || !allowCodeFrom(`code-browser ${nonce}`)) return emailBusy(c);
    const typed = (await c.req.parseBody()).code;
    const code = typeof typed === 'string' ? normalCode(typed) : undefined;
    const known = getCookie(c, knownCookie.name);
    const login = code ? claimEmailLoginByCode(db, secret, [formKey(nonce), ...(known ? [knownKey(known)] : [])], code) : undefined;
    return login ? signInByEmail(c, login) : codeFailed(c);
  });

  // Registered before `/auth/email/:token`, which would take this path too.
  web.post('/auth/email/join', async (c) => {
    if (!klatsch.signInMailer) return c.notFound();
    const refused = await refusedForm(c);
    if (refused) return refused;
    const at = emailJoinOf(c, false);
    if (!at) return invalidEmailLink(c);
    const view = joinView(at.target, at.email);
    if (!view) {
      emailJoinOf(c, true);
      return c.html(invalidTarget(at.target), 404);
    }
    if (at.target.kind === 'public' && !allowJoinFrom(`join ${addressKey(address(c))}`)) return emailBusy(c);
    const typed = (await c.req.parseBody()).handle;
    let joined: string | 'taken';
    try {
      joined = klatsch.joinWithEmail(at.email, typeof typed === 'string' ? typed.trim().toLowerCase() : '', view.accept, view.circle);
    } catch (error) {
      if (!(error instanceof KlatschError)) throw error;
      emailJoinOf(c, true);
      return at.target.kind !== 'public' ? c.html(invalidTarget(at.target), 404) : c.html(notice(copy.layout.notPossible, html`<p class="sub">${error.message}</p>`), 409);
    }
    if (joined === 'taken') {
      if (++at.tries >= HANDLE_TRIES) {
        emailJoinOf(c, true);
        return c.html(notice(copy.emailSignIn.handleTriesTitle, html`<p class="sub">${copy.emailSignIn.handleTries}</p>`), 429);
      }
      return emailJoinPage(c, at.email, view, true);
    }
    emailJoinOf(c, true);
    return signIn(c, joined);
  });

  web.post('/auth/email/:token', async (c) => {
    if (!klatsch.signInMailer) return c.notFound();
    const refused = await refusedForm(c);
    if (refused) return refused;
    const login = claimEmailLogin(db, secret, c.req.param('token'));
    if (!login) return invalidEmailLink(c);
    return signInByEmail(c, login);
  });

  /** A used link or code: signs in the person whose address it is, or starts a new address's join step. */
  const signInByEmail = (c: Context, login: EmailLogin) => {
    // Who the address belongs to is decided now, not when the link was sent: a changed address signs nobody in.
    const people = klatsch.usersByEmail(login.email);
    if (people.length === 1) {
      const id = people[0]!;
      // Content-free, so a sign-in that was not the person shows: a notification, and a mail to the address that
      // signed in unless their notifications already go there by mail.
      if (!allowSignInNotice(id)) klatsch.audit(id, 'web', 'email.signin');
      else if (!klatsch.noteEmailSignIn(id)) klatsch.signInMailer!.notice(login.email, `${base(c)}/ui/settings`);
      return signIn(c, id);
    }
    const target = people.length === 0 && login.join ? targetOfRef(login.join) : undefined;
    const view = target && joinView(target, login.email);
    if (!target || !view) return target ? c.html(invalidTarget(target), 404) : invalidEmailLink(c);
    // Joining ends at /ui, not back at the invite this browser remembered, which will have been used.
    const key = getCookie(c, NEXT_COOKIE);
    if (key !== undefined) deleteCookie(c, NEXT_COOKIE, { path: '/ui' });
    returns.take(key);
    setCookie(c, joinCookie.name, emailJoins.put({ email: login.email, target, tries: 0 }), {
      httpOnly: true,
      sameSite: 'Lax',
      secure,
      path: joinCookie.path,
      maxAge: NEXT_TTL_MS / 1000,
    });
    return emailJoinPage(c, login.email, view, false);
  };

  // ---------- passkeys ----------

  /**
   * Where passkeys work: on the public https URL (its host is the relying party), or a local relay opened as
   * `localhost`. Not at 127.0.0.1: an IP address cannot be a relying party, and not over plain http elsewhere.
   */
  const passkeyAt = (c: Context): { rpID: string; origin: string } | undefined => {
    const at = base(c);
    const url = new URL(at);
    if (url.hostname === 'localhost' || (url.protocol === 'https:' && at === config.publicUrl)) return { rpID: url.hostname, origin: at };
    return undefined;
  };
  /** A challenge handed out once, kept in memory for five minutes and bound to who asked (a session or a form cookie). */
  const challenges = shortLived<{ challenge: string; owner: string; origin: string }>(PASSKEY_CHALLENGE_MS);
  const takeChallenge = (key: unknown, owner: string, origin: string): string | undefined => {
    const entry = typeof key === 'string' ? challenges.take(key) : undefined;
    return entry && entry.owner === owner && entry.origin === origin ? entry.challenge : undefined;
  };
  /** What the passkey script posted, as JSON in its `data` field; anything else is nothing. */
  const passkeyData = async (c: Context): Promise<{ key?: unknown; credential?: unknown; back?: unknown } | undefined> => {
    const data = (await c.req.parseBody()).data;
    if (typeof data !== 'string' || data.length > 16_384) return undefined;
    try {
      const parsed: unknown = JSON.parse(data);
      return parsed && typeof parsed === 'object' ? (parsed as { key?: unknown; credential?: unknown; back?: unknown }) : undefined;
    } catch {
      return undefined;
    }
  };
  /** The id the relying party knows a person by: their Klatsch id, never the handle. */
  const passkeyUserId = (userId: string) => new TextEncoder().encode(userId);
  const allowPasskeyFrom = perKeyLimit(PASSKEY_TRIES_PER_ADDRESS, HOUR_MS);
  // Every refusal of a passkey sign-in is the same answer: it tells nobody whether a passkey is known here.
  const passkeyFailed = (c: Context) => c.json({ error: copy.passkeys.failed }, 400);

  web.get('/passkey.js', (c) => {
    c.header('Content-Type', 'text/javascript; charset=utf-8');
    return c.body(PASSKEY_SCRIPT);
  });

  // Notifications on a phone or browser (Web Push): the page script, the service worker, and what a home screen needs.
  web.get('/record.js', (c) => {
    c.header('Content-Type', 'text/javascript; charset=utf-8');
    return c.body(RECORD_SCRIPT);
  });
  web.get('/push.js', (c) => {
    c.header('Content-Type', 'text/javascript; charset=utf-8');
    return c.body(PUSH_SCRIPT);
  });
  web.get('/sw.js', (c) => {
    c.header('Content-Type', 'text/javascript; charset=utf-8');
    c.header('Cache-Control', 'no-cache');
    return c.body(SERVICE_WORKER);
  });
  web.get('/manifest.webmanifest', (c) => {
    c.header('Content-Type', 'application/manifest+json');
    return c.body(MANIFEST);
  });
  web.get('/icon.svg', (c) => {
    c.header('Content-Type', 'image/svg+xml');
    return c.body(ICON_SVG);
  });

  web.post('/auth/passkey/options', async (c) => {
    const at = passkeyAt(c);
    if (!at) return c.notFound();
    const refused = await refusedForm(c);
    if (refused) return refused;
    if (!allowPasskeyFrom(`passkey ${addressKey(address(c))}`)) return c.json({ error: copy.signIn.busy }, 429);
    const options = await generateAuthenticationOptions({ rpID: at.rpID, userVerification: 'required', timeout: PASSKEY_CHALLENGE_MS });
    const key = challenges.put({ challenge: options.challenge, owner: formKey(formNonce(c)), origin: at.origin });
    return c.json({ key, options });
  });

  web.post('/auth/passkey', async (c) => {
    const at = passkeyAt(c);
    if (!at) return c.notFound();
    const refused = await refusedForm(c);
    if (refused) return refused;
    if (!allowPasskeyFrom(`passkey ${addressKey(address(c))}`)) return c.json({ error: copy.signIn.busy }, 429);
    const data = await passkeyData(c);
    // Used up first, whatever follows: a challenge never checks a second answer.
    const challenge = takeChallenge(data?.key, formKey(formNonce(c)), at.origin);
    const response = data?.credential as AuthenticationResponseJSON | undefined;
    const passkey = challenge && typeof response?.id === 'string' ? passkeyById(db, response.id) : undefined;
    if (!challenge || !response || !passkey) return passkeyFailed(c);
    // The browser says whose passkey it is; it must be the person the relay has it for.
    const handle = response.response?.userHandle;
    if (handle !== undefined && handle !== Buffer.from(passkeyUserId(passkey.user_id)).toString('base64url')) return passkeyFailed(c);
    let verified;
    try {
      verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: at.origin,
        expectedRPID: at.rpID,
        requireUserVerification: true,
        credential: { id: passkey.id, publicKey: new Uint8Array(passkey.public_key), counter: passkey.counter, transports: transportsOf(passkey) as never },
      });
    } catch {
      return passkeyFailed(c);
    }
    if (!verified.verified) return passkeyFailed(c);
    klatsch.usePasskey(passkey.id, passkey.user_id, verified.authenticationInfo.newCounter);
    const earlier = getCookie(c, COOKIE);
    if (earlier) endSession(db, secret, earlier);
    return c.json({ next: arrive(c, startSession(db, secret, passkey.user_id).session, passkey.user_id) });
  });

  // ---------- klatsch connect without a token: the waiting command's side (no session, no page) ----------

  const allowConnectStart = perKeyLimit(CONNECT_STARTS_PER_ADDRESS, NEXT_TTL_MS);
  const allowConnectPoll = perKeyLimit(CONNECT_POLLS_PER_ADDRESS, NEXT_TTL_MS);
  /** The command sends JSON and no Origin. A page on another site always sends one, and gets nothing here. */
  const fromCommand = (c: Context) => !c.req.header('Origin') && (c.req.header('Content-Type') ?? '').startsWith('application/json');
  const jsonField = async (c: Context, name: string): Promise<string> => {
    const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    const value = body?.[name];
    return typeof value === 'string' ? value : '';
  };

  web.post('/connect/start', async (c) => {
    if (!fromCommand(c)) return c.json({ error: 'refused' }, 403);
    if (!allowConnectStart(addressKey(address(c)))) return c.json({ error: 'too_many' }, 429);
    const started = startConnect(db, secret, await jsonField(c, 'client'));
    if (!started) return c.json({ error: 'refused' }, 400);
    return c.json({
      device_code: started.device,
      user_code: started.code,
      // Without the code: it is typed, so a link someone else sent can never connect anything by a click.
      verification_url: `${base(c)}/ui/connect`,
      expires_at: new Date(started.expiresAt).toISOString(),
      interval_seconds: CONNECT_INTERVAL_S,
    });
  });

  web.post('/connect/poll', async (c) => {
    if (!fromCommand(c)) return c.json({ error: 'refused' }, 403);
    if (!allowConnectPoll(addressKey(address(c)))) return c.json({ error: 'too_many' }, 429);
    const outcome = pollConnect(db, secret, await jsonField(c, 'device_code'), config.tokenTtlDays, (id) => klatsch.inAnyCircle(id));
    if (outcome.state !== 'connected') return c.json({ state: outcome.state });
    klatsch.audit(outcome.userId, 'web', 'token.create', outcome.tokenId);
    return c.json({ state: outcome.state, token: outcome.token });
  });

  // Everything below needs a human session.
  web.use('*', async (c, next) => {
    // Guests whose hours are up go before anything is read, with their sessions.
    klatsch.sweepGuests();
    const session = getCookie(c, COOKIE);
    const found = session ? readSession(db, secret, session) : undefined;
    if (!found || !session) {
      // Back to this page after the login link, for ten minutes; same cookie rules as the session.
      // The consent page is reached from the app being connected (another site), with its request in the query;
      // landing there after signing in only shows the question, so it may come back from anywhere, query and all.
      const consent = c.req.method === 'GET' && c.req.path === '/ui/oauth/authorize';
      if (consent || (c.req.method === 'GET' && isPage(c.req.path) && navigatedHere(c))) {
        const back = consent ? `${c.req.path}${new URL(c.req.url).search}` : c.req.path;
        setCookie(c, NEXT_COOKIE, returns.put(back), { httpOnly: true, sameSite: 'Lax', secure, path: '/ui', maxAge: NEXT_TTL_MS / 1000 });
      }
      const t = copy.signIn;
      // At a public join link, the page says which circle; anyone may join it, so that is no secret.
      const target = c.req.method === 'GET' ? joinTargetOf(c.req.path) : undefined;
      const open = target?.kind === 'public' ? klatsch.publicCircle(target.token) : undefined;
      // A guest's friend link: the visitor joins as a guest with one click; accounts cannot join it anyway.
      const fromGuest = config.guest && target?.kind === 'invite' ? findInvite(db, secret, target.token) : undefined;
      if (fromGuest && klatsch.isGuest(fromGuest.createdBy)) {
        return c.html(
          signInScreen(
            copy.guest.invited(fromGuest.inviterName),
            html`<p class="lead">${copy.guest.invitedLine(GUEST_HOURS)}</p>
              <form class="mail" method="post" action="/ui/guest">
                <input type="hidden" name="csrf" value="${formToken(c)}" />
                <input type="hidden" name="invite" value="${(target as { token: string }).token}" />
                <button class="primary">${copy.guest.join}</button>
              </form>
              <p>${copy.guest.accountsHere}</p>`,
          ),
        );
      }
      const passkey = passkeyAt(c);
      if (github(c) || google(c) || klatsch.signInMailer || passkey) {
        // One form token for the page: a browser without the cookie yet would otherwise get two values.
        const token = formToken(c);
        if (passkey) c.header('Content-Security-Policy', SCRIPT_CSP);
        return c.html(
          signInScreen(
            open ? copy.commons.heading(open.name) : t.knock,
            // A chat: the ways in are quick replies, the email a message to send; the fine print folds away.
            html`${open ? html`<p class="lead">${copy.commons.line(open.people)}</p><p>${copy.commons.signIn}</p>` : ''}
              <div class="replies" role="group" aria-label="${t.ways}">
                ${passkey ? html`<span data-passkey-box hidden><button type="button" data-passkey="signin" data-csrf="${token}" aria-label="${copy.passkeys.signIn}">${KEY_ICON()}<span>${t.chipPasskey}</span></button></span>` : ''}
                ${github(c) ? chip(GITHUB_PATH, t.chipGitHub, t.github, GITHUB_ICON()) : ''}
                ${google(c) ? chip(GOOGLE_PATH, t.chipGoogle, t.google, GOOGLE_ICON()) : ''}
              </div>
              ${klatsch.signInMailer
                ? html`<form class="composer" method="post" action="${EMAIL_PATH}">
                    <input type="hidden" name="csrf" value="${token}" />
                    <input type="email" name="email" maxlength="254" required autocomplete="email" autocapitalize="none" spellcheck="false" placeholder="${t.composer}" aria-label="${t.emailLabel}" />
                    <button class="primary send" aria-label="${t.email}">➤</button>
                  </form>`
                : ''}
              ${passkey ? passkeyScript() : ''}
              <div class="more">${config.guest && !target ? html`<a href="/ui/guest">${copy.guest.link}</a>` : ''}<details class="keeps"><summary>${t.keeps}</summary>
                ${github(c) ? html`<p>${t.githubNote}</p>` : ''}${google(c) ? html`<p>${t.googleNote}</p>` : ''}${klatsch.signInMailer ? html`<p>${t.emailNote}</p>` : ''}
                <p>${t.loginLink}</p>${open ? '' : html`<p>${t.inviteNeeded}</p>`}${isHosted(config) ? '' : html`<p>${t.help}</p>`}
                ${klatsch.hasReviewAccounts() ? html`<p><a href="/ui/review-login">${copy.review.link}</a></p>` : ''}
              </details></div>`,
            open ? '' : t.whosThere,
          ),
          401,
        );
      }
      return c.html(signInScreen(t.notSignedInTitle, html`<p class="lead">${t.notSignedIn}</p><p>${t.help}</p><p>${t.inviteNeeded}</p>${config.guest && !target ? html`<p><a href="/ui/guest">${copy.guest.link}</a></p>` : ''}${klatsch.hasReviewAccounts() ? html`<p><a href="/ui/review-login">${copy.review.link}</a></p>` : ''}`), 401);
    }
    // A renewed session gets a cookie that lives as long as it now does.
    if (found.expiresAt) setCookie(c, COOKIE, session, { httpOnly: true, sameSite: 'Lax', secure, path: '/ui', maxAge: Math.floor((found.expiresAt - Date.now()) / 1000) });
    c.set('userId', found.userId);
    c.set('csrf', found.csrf);
    c.set('session', session);
    // A guest reaches only the pages it can use; everything else (adding a sign-in, friends, circles, files) says so.
    if (klatsch.isGuest(found.userId) && !guestMay(c.req.method, c.req.path)) {
      return c.html(notice(copy.guest.notHere, html`<p class="sub">${copy.guest.notHereLine}</p>${homeLink}`), 403);
    }
    // Someone in no circle (removed from all, or never joined) decides and sends nothing until they accept an invite.
    if (/^\/ui\/(approvals|device|connect|sips|intros|notes|grants)(\/|$)/.test(c.req.path) && !klatsch.inAnyCircle(found.userId)) {
      return c.html(notice(copy.noCircle.title, html`<p class="sub">${copy.noCircle.line}</p>${homeLink}`), 409);
    }
    if (c.req.method === 'POST') {
      // Browsers send Origin on every form post; a post without it did not come from our page.
      if (c.req.header('Origin') !== new URL(base(c)).origin) return c.text(copy.layout.crossOrigin, 403);
      const form = await c.req.parseBody();
      if (typeof form.csrf !== 'string' || !safeEqual(form.csrf, found.csrf)) return c.text(copy.layout.badFormToken, 403);
    }
    await next();
  });

  /** The signed-in person, for the top bar. */
  const viewer = (c: Context<Env>): Viewer => ({ name: klatsch.user(c.get('userId')).display_name, csrf: c.get('csrf') });
  const show = (c: Context<Env>, title: string, tab: Tab, body: unknown) => c.html(screen(title, viewer(c), tab, body));

  web.get('/', (c) => {
    const userId = c.get('userId');
    const user = klatsch.user(userId);
    // A guest without a friend yet: how long it has, and the link to bring one.
    const guestAt = klatsch.guestExpiresAt(userId);
    if (guestAt !== undefined && !klatsch.inAnyCircle(userId)) {
      return show(
        c,
        user.display_name,
        'home',
        html`${guestBanner(guestAt, c.get('csrf'))}
          <div class="ph"><h1>${copy.guest.noFriendTitle}</h1></div>
          <section class="sec"><p class="hint">${copy.guest.noFriend}</p><p class="hint">${button('/ui/friends/invite', copy.circle.addFriend, c.get('csrf'), 'primary')}</p></section>`,
      );
    }
    // Signed in, but circles grow by invite only: nothing to show until one is accepted.
    if (!klatsch.inAnyCircle(userId)) {
      return c.html(
        dialog(
          copy.noCircle.title,
          viewer(c),
          html`${icon()}
            <h1 id="title">${copy.noCircle.title}</h1>
            <p class="sub">${copy.settings.signedInAs(user.display_name, user.handle)}</p>
            <p class="sub">${copy.noCircle.line}</p>
            <p class="sub">${copy.noCircle.friend}</p>
            ${button('/ui/friends/invite', copy.circle.addFriend, c.get('csrf'), 'primary')}
            ${button('/ui/logout', copy.dashboard.signOut, c.get('csrf'))}
            <p class="fine">${copy.noCircle.selfHost} <a href="${copy.landing.links.selfHosting}">${copy.noCircle.selfHostLink}</a></p>`,
        ),
      );
    }
    // Saving a passkey is offered once, where it can work, until there is one or the person says "Not now".
    const guestLeft = klatsch.guestExpiresAt(userId);
    const offer = guestLeft === undefined && Boolean(passkeyAt(c)) && user.passkey_offer_dismissed_at === null && passkeysOf(db, userId).length === 0;
    // Notifications are offered once on Home, when no device has them and the passkey offer is not showing.
    const pushOffer = !offer && user.push_offer_dismissed_at === null && klatsch.pushSubscriptionsOf(userId).length === 0;
    // A device that has them re-sends its subscription from Home, so one the relay lost comes back by itself.
    const pushSync = !pushOffer && klatsch.pushSubscriptionsOf(userId).length > 0;
    if (offer || pushOffer || pushSync) c.header('Content-Security-Policy', SCRIPT_CSP);
    const conversations = klatsch.conversationsOf(userId);
    const asks = klatsch.asksOf(userId);
    return c.html(messenger(
      user.display_name,
      chatSide(conversations, asks, c.get('csrf'), undefined, getCookie(c, THEME_COOKIE) ?? 'auto'),
      // On the first Home after signing in, the script opens the browser's own passkey dialog by itself, once.
      html`<div class="scroll"><div class="inner"><div class="pick"><h1>${copy.chat.pick}</h1><p>${copy.chat.pickLine}</p></div>${guestLeft !== undefined ? guestBanner(guestLeft, c.get('csrf')) : ''}${offer ? passkeyOffer(c.get('csrf'), takeFirstHome(db, secret, c.get('session'))) : ''}${pushOffer ? pushOfferBox(vapidFromSecret(secret).publicKey, c.get('csrf')) : ''}${pushSync ? html`<span data-push-sync data-key="${vapidFromSecret(secret).publicKey}" data-csrf="${c.get('csrf')}" hidden></span><script src="/ui/push.js" defer></script>` : ''}${dashboard(
        user,
        klatsch.sipsOf(userId),
        klatsch.introsOf(userId),
        klatsch.visibleNotes(userId),
        { ...klatsch.helped(userId), byAgent: klatsch.agentThanksOf(userId) },
        klatsch.sharingCircles(userId),
        config.connectedTextHours,
        // A friend's question is in their conversation; Home keeps the ones from people who are not friends.
        asks.filter((k) => !conversations.some((x) => x.other.handle === k.other.handle)),
        c.get('csrf'),
        klatsch.circlesOf(userId).filter((circle) => circle.pair && circle.people === 2).length,
        conversations,
        guestLeft === undefined,
      )}</div></div>`,
      false,
    ));
  });

  web.post('/push/subscribe', async (c) => {
    const form = await c.req.parseBody();
    const field = (name: string) => (typeof form[name] === 'string' ? (form[name] as string) : '');
    try {
      klatsch.savePushSubscription(c.get('userId'), { endpoint: field('endpoint'), p256dh: field('p256dh'), auth: field('auth') });
    } catch (error) {
      if (error instanceof KlatschError) return c.text(error.message, 400);
      throw error;
    }
    return c.text('ok');
  });
  // Every visit re-sends this browser's subscription: a device the relay lost (a restore, the ten-device limit)
  // gets notifications again without anyone noticing it had stopped. "off": turned off from another device.
  web.post('/push/sync', async (c) => {
    const form = await c.req.parseBody();
    const field = (name: string) => (typeof form[name] === 'string' ? (form[name] as string) : '');
    try {
      return c.text(klatsch.savePushSubscription(c.get('userId'), { endpoint: field('endpoint'), p256dh: field('p256dh'), auth: field('auth') }, true));
    } catch (error) {
      if (error instanceof KlatschError) return c.text(error.message, 400);
      throw error;
    }
  });
  web.post('/push/test', async (c) => {
    const t = copy.push;
    try {
      const { sent, failed, gone } = await klatsch.testPush(c.get('userId'));
      const body = sent + failed + gone === 0 ? html`<p class="sub">${t.testNone}</p>` : html`<p class="sub">${t.testSent(sent, failed, gone)}</p>${pushChecks()}`;
      return c.html(notice(t.testTitle, html`${body}<p><a href="/ui/settings#notifications">${copy.settings.title}</a></p>`, false));
    } catch (error) {
      if (error instanceof KlatschError) return c.html(notice(t.testTitle, html`<p class="sub">${error.message}</p>`, false), 429);
      throw error;
    }
  });
  web.post('/push/off', (c) => attempt(c, () => klatsch.pushOff(c.get('userId')), '/ui/settings#notifications'));
  // "Turn off here": this browser's own subscription only.
  web.post('/push/unsubscribe', async (c) => {
    const form = await c.req.parseBody();
    klatsch.forgetOwnPushSubscription(c.get('userId'), typeof form.endpoint === 'string' ? form.endpoint : '');
    return c.text('ok');
  });

  web.get('/settings', (c) => {
    const userId = c.get('userId');
    // Settings runs the passkey and the notifications scripts, both same-origin.
    c.header('Content-Security-Policy', SCRIPT_CSP);
    const user = klatsch.user(userId);
    const guestLeft = klatsch.guestExpiresAt(userId);
    if (guestLeft !== undefined) return show(c, copy.settings.title, 'settings', guestBanner(guestLeft, c.get('csrf')));
    const badge = user.badge_id ? `${config.publicUrl}/badge/${user.badge_id}.svg` : undefined;
    return show(
      c,
      copy.settings.title,
      'settings',
      settingsPage(user, otherSessions(db, secret, userId, c.get('session')), { list: passkeysOf(db, userId), here: Boolean(passkeyAt(c)) }, Boolean(klatsch.mailer), Boolean(github(c)), Boolean(google(c)), klatsch.grantsOf(userId), { ...klatsch.helped(userId), badge, home: config.publicUrl }, c.get('csrf'), { devices: klatsch.pushSubscriptionsOf(userId).length, key: vapidFromSecret(secret).publicKey }),
    );
  });

  // Connecting GitHub to the signed-in person: only by this form, then confirmed again after GitHub. A page with
  // a link to GitHub, not a redirect: the CSP lets a form post land only on this relay.
  web.post('/auth/github/connect', (c) => {
    const app = github(c);
    if (!app) return c.notFound();
    const userId = c.get('userId');
    if (klatsch.user(userId).github_id !== null) return c.redirect('/ui/settings', 303);
    if (!allowAddress(`start ${addressKey(address(c))}`)) return tooMany(c);
    const { state, verifier } = newAttempt();
    setStep(c, { kind: 'attempt', state, verifier, linkTo: userId });
    return c.html(
      dialog(
        copy.settings.connectTitle,
        viewer(c),
        html`${icon()}
          <h1 id="title">${copy.settings.connectTitle}</h1>
          <p class="sub">${copy.settings.connectLead}</p>
          <a class="button primary" href="${authorizeUrl(app, callbackUrl, state, verifier)}">${copy.settings.continueToGitHub}</a>`,
      ),
    );
  });

  web.post('/auth/github/link', (c) => {
    const at = stepOf(c, true);
    if (at?.kind !== 'link' || at.userId !== c.get('userId')) return githubFailed(c);
    if (!klatsch.linkGitHub(at.userId, at.identity)) return githubFailed(c, copy.signIn.inUseTitle, copy.signIn.inUse, 409);
    return c.redirect('/ui/settings', 303);
  });

  web.post('/auth/github/cancel', (c) => {
    stepOf(c, true);
    return c.redirect('/ui/settings', 303);
  });

  web.post('/settings/github/disconnect', (c) => {
    klatsch.unlinkGitHub(c.get('userId'));
    return c.redirect('/ui/settings', 303);
  });

  // Connecting Google, as for GitHub: only by this form, then confirmed again after Google.
  web.post('/auth/google/connect', (c) => {
    const app = google(c);
    if (!app) return c.notFound();
    const userId = c.get('userId');
    if (klatsch.user(userId).google_sub !== null) return c.redirect('/ui/settings', 303);
    if (!allowAddress(`gstart ${addressKey(address(c))}`)) return googleFailed(c, copy.signIn.busyTitle, copy.signIn.busy, 429);
    const attempt = newGoogleAttempt();
    setGoogleStep(c, { kind: 'attempt', ...attempt, linkTo: userId });
    return c.html(
      dialog(
        copy.settings.googleConnectTitle,
        viewer(c),
        html`${icon()}
          <h1 id="title">${copy.settings.googleConnectTitle}</h1>
          <p class="sub">${copy.settings.googleConnectLead}</p>
          <a class="button primary" href="${googleAuthorizeUrl(app, googleCallback, attempt)}">${copy.settings.continueToGoogle}</a>`,
      ),
    );
  });

  web.post('/auth/google/link', (c) => {
    const at = googleStepOf(c, true);
    if (at?.kind !== 'link' || at.userId !== c.get('userId')) return googleFailed(c);
    if (!klatsch.linkGoogle(at.userId, at.identity)) return googleFailed(c, copy.signIn.googleInUseTitle, copy.signIn.googleInUse, 409);
    return c.redirect('/ui/settings', 303);
  });

  web.post('/auth/google/cancel', (c) => {
    googleStepOf(c, true);
    return c.redirect('/ui/settings', 303);
  });

  web.post('/settings/google/disconnect', (c) => {
    klatsch.unlinkGoogle(c.get('userId'));
    return c.redirect('/ui/settings', 303);
  });

  // Off by default; on, a public image with a number only, at a new random link each time it is turned on.
  web.post('/settings/badge', async (c) => {
    const form = await c.req.parseBody();
    return attempt(c, () => klatsch.setBadge(c.get('userId'), form.on === '1'), '/ui/settings#thanks');
  });

  // On by default: the person's agent may thank the author of a note that fixed the problem. Off, it cannot.
  web.post('/settings/agent-thanks', async (c) => {
    const form = await c.req.parseBody();
    klatsch.setAgentThanks(c.get('userId'), form.on === '1');
    return c.redirect('/ui/settings#thanks', 303);
  });

  web.post('/grants/:id/revoke', (c) => attempt(c, () => klatsch.revokeGrant(c.get('userId'), c.req.param('id')), '/ui/settings'));

  // A new address gets one confirmation link, mailed only to that address; without SMTP it stays unconfirmed.
  web.post('/email', async (c) => {
    const form = await c.req.parseBody();
    const userId = c.get('userId');
    const email = typeof form.email === 'string' ? form.email : '';
    return attempt(
      c,
      () => {
        if (!klatsch.setEmail(userId, email) || !klatsch.mailer) return;
        const link = createEmailConfirmation(db, secret, userId, email, base(c));
        if (!link) throw new KlatschError('forbidden', copy.email.tooManyLinks);
        klatsch.mailer(email, link);
        klatsch.audit(userId, 'web', 'email.confirmation.send');
      },
      '/ui/settings',
    );
  });

  // Unknown, used, expired, replaced and other people's links all get the same page.
  const invalidConfirmation = (c: Context<Env>) =>
    c.html(notice(copy.email.invalidTitle, html`<p class="sub">${copy.email.invalid}</p>${homeLink}`), 404);

  web.get('/email/confirm/:token', (c) => {
    const confirmation = findEmailConfirmation(db, secret, c.req.param('token'), c.get('userId'));
    if (!confirmation) return invalidConfirmation(c);
    return c.html(
      dialog(
        copy.email.confirmTitle,
        viewer(c),
        html`${icon()}
          <h1 id="title">${copy.email.confirmTitle}</h1>
          <p class="sub">${copy.email.confirmQuestion(confirmation.email)}</p>
          ${button(`/ui/email/confirm/${c.req.param('token')}`, copy.email.confirm, c.get('csrf'), 'primary')}`,
      ),
    );
  });

  web.post('/email/confirm/:token', (c) => {
    const confirmation = findEmailConfirmation(db, secret, c.req.param('token'), c.get('userId'));
    if (!confirmation) return invalidConfirmation(c);
    try {
      klatsch.confirmEmail(c.get('userId'), confirmation);
    } catch (error) {
      if (error instanceof KlatschError) return invalidConfirmation(c);
      throw error;
    }
    return c.html(
      notice(copy.email.confirmedTitle, html`<p class="sub">${copy.email.confirmedLine(confirmation.email)}</p><p><a href="/ui/settings">${copy.layout.settings}</a></p>`, false),
    );
  });

  web.post('/notifications/email', async (c) => {
    const form = await c.req.parseBody();
    klatsch.setEmailNotifications(c.get('userId'), form.on === '1');
    return c.redirect('/ui/settings', 303);
  });

  // ---------- circles and invites ----------

  web.get('/notes', (c) => show(c, copy.notesPage.title, 'notes', notesPage(klatsch.feedNotes(c.get('userId')), c.get('csrf'))));

  web.get('/circle', (c) => show(c, copy.circle.title, 'circle', circlePage(c.get('userId'), klatsch.circlesOf(c.get('userId')), base(c), c.get('csrf'))));

  // The owner turns the public join link off (new joins stop, members stay). Only the operator turns one on.
  web.post('/circles/:id/public', (c) => attempt(c, () => void klatsch.setJoinLink(c.get('userId'), c.req.param('id'), false), '/ui/circle'));

  // A public circle's join link: anyone signed in joins, as often as the link is on; a removal still sticks.
  web.get('/join/:token', (c) => {
    const target: JoinTarget = { kind: 'public', token: c.req.param('token') };
    const circle = klatsch.publicCircle(target.token);
    // Removed by the owner: the same page as an unknown link, as Join would answer.
    if (!circle || klatsch.isRemoved(c.get('userId'), circle.id)) return c.html(invalidTarget(target), 404);
    if (klatsch.memberRole(c.get('userId'), circle.id)) {
      return c.html(notice(copy.invite.title, html`<p class="sub">${copy.invite.alreadyMember(circle.name)}</p>${circlesLink}`, false));
    }
    if (circle.cap !== null && circle.people >= circle.cap) return c.html(notice(copy.layout.notPossible, html`<p class="sub">${copy.commons.full}</p>${homeLink}`), 409);
    const view = joinView(target, viewer(c).name)!;
    return c.html(
      dialog(
        view.heading,
        viewer(c),
        html`${view.top}
          <h1 id="title">${view.heading}</h1>
          <p class="sub">${view.line}</p>
          ${button(`/ui/join/${target.token}`, copy.commons.join, c.get('csrf'), 'primary')}
          <p class="fine">${view.note}</p>`,
      ),
    );
  });

  web.post('/join/:token', (c) => {
    const userId = c.get('userId');
    if (!allowJoinFrom(`join ${addressKey(address(c))}`) || !allowJoinBy(`join ${userId}`)) return tooMany(c);
    const target: JoinTarget = { kind: 'public', token: c.req.param('token') };
    const name = klatsch.publicCircle(target.token)?.name ?? '';
    let joined: 'joined' | 'already-member';
    try {
      joined = klatsch.joinPublic(userId, target.token);
    } catch (error) {
      if (!(error instanceof KlatschError)) throw error;
      if (error.message === copy.commons.full) return c.html(notice(copy.layout.notPossible, html`<p class="sub">${copy.commons.full}</p>${homeLink}`), 409);
      return c.html(invalidTarget(target), 404);
    }
    const text = joined === 'joined' ? copy.commons.joined(name) : copy.invite.alreadyMember(name);
    return c.html(notice(copy.invite.title, html`<p class="sub">${text}</p>${circlesLink}`, false));
  });

  // The link is shown once, to the inviter; only its keyed hash is stored.
  web.post('/circles/:id/invites', (c) => {
    const userId = c.get('userId');
    const circleId = c.req.param('id');
    if (!klatsch.mayInvite(userId, circleId) || klatsch.isFriendship(circleId)) {
      const why = klatsch.memberRole(userId, circleId) ? copy.commons.ownerInvites : copy.circle.notMember;
      return c.html(notice(copy.layout.notPossible, html`<p class="sub">${why}</p><p><a href="/ui/circle">${copy.layout.back}</a></p>`), 409);
    }
    const invite = createInvite(db, secret, circleId, userId, base(c));
    klatsch.audit(userId, 'web', 'invite.create', invite.inviteId);
    return show(
      c,
      copy.circle.inviteTitle,
      'circle',
      html`<div class="ph"><h1>${copy.circle.inviteTitle}</h1></div>
        <section class="sec">
          <code class="cmd">${invite.link}</code>
          <p class="hint">${copy.circle.inviteNote}</p>
          <p class="hint"><a href="/ui/circle">${copy.circle.backToCircles}</a></p>
        </section>`,
    );
  });

  // "Add a friend": a new circle of two and its one invite, the link shown once to the inviter.
  web.post('/friends/invite', (c) => {
    const userId = c.get('userId');
    let circleId: string;
    try {
      circleId = klatsch.friendCircle(userId);
    } catch (error) {
      if (!(error instanceof KlatschError)) throw error;
      return c.html(notice(copy.layout.notPossible, html`<p class="sub">${error.message}</p><p><a href="/ui/circle">${copy.layout.back}</a></p>`), 409);
    }
    const invite = createInvite(db, secret, circleId, userId, base(c));
    klatsch.audit(userId, 'web', 'invite.create', invite.inviteId);
    return show(
      c,
      copy.circle.friendInviteTitle,
      'circle',
      html`<div class="ph"><h1>${copy.circle.friendInviteTitle}</h1></div>
        <section class="sec">
          <code class="cmd">${invite.link}</code>
          <p class="hint">${copy.circle.friendInviteNote}</p>
          <p class="hint">${copy.push.hint} <a href="/ui/settings#notifications">${copy.push.hintLink}</a></p>
          <p class="hint"><a href="/ui/circle">${copy.circle.backToCircles}</a></p>
        </section>`,
    );
  });

  web.post('/friends/:id/end', (c) => attempt(c, () => klatsch.endFriendship(c.get('userId'), c.req.param('id')), '/ui/circle'));

  web.post('/circles/:id/members/:member/remove', (c) =>
    attempt(c, () => klatsch.removeMember(c.get('userId'), c.req.param('id'), c.req.param('member')), '/ui/circle'),
  );

  // Unknown, used and expired invites all get the same page.
  const invalidInvite = (c: Context<Env>) =>
    c.html(notice(copy.invite.invalidTitle, html`<p class="sub">${copy.invite.invalid}</p>${homeLink}`), 404);

  web.get('/invite/:token', (c) => {
    const invite = findInvite(db, secret, c.req.param('token'));
    if (!invite) return invalidInvite(c);
    if (klatsch.memberRole(c.get('userId'), invite.circleId)) {
      return c.html(notice(copy.invite.title, html`<p class="sub">${copy.invite.alreadyMember(invite.circleName)}</p>${circlesLink}`, false));
    }
    if (!klatsch.inviteOpenTo(c.get('userId'), invite)) return invalidInvite(c);
    // A guest's link joins guests only, and a guest joins no one else's.
    if (klatsch.isGuest(invite.createdBy) !== klatsch.isGuest(c.get('userId'))) {
      return c.html(notice(copy.invite.title, html`<p class="sub">${klatsch.isGuest(c.get('userId')) ? GUEST.guestsOnly : GUEST.linkFromGuest}</p>${homeLink}`, false), 403);
    }
    return c.html(
      dialog(
        copy.invite.heading,
        viewer(c),
        invite.pair
          ? html`${pair(invite.inviterName, viewer(c).name, { leftBlue: true, rightBlue: false })}
              <h1 id="title">${copy.invite.friendHeading}</h1>
              <p class="sub">${copy.invite.friendLine(invite.inviterName, invite.inviterHandle)}</p>
              ${button(`/ui/invite/${c.req.param('token')}`, copy.invite.friendJoin, c.get('csrf'), 'primary')}
              <p class="fine">${copy.invite.friendNote}</p>`
          : html`${pair(invite.inviterName, viewer(c).name, { leftBlue: true, rightBlue: false })}
              <h1 id="title">${copy.invite.heading}</h1>
              <p class="sub">${copy.invite.line(invite.inviterName, invite.inviterHandle, invite.circleName)}</p>
              ${button(`/ui/invite/${c.req.param('token')}`, copy.invite.join, c.get('csrf'), 'primary')}
              <p class="fine">${copy.invite.note}</p>`,
      ),
    );
  });

  web.post('/invite/:token', (c) => {
    const invite = findInvite(db, secret, c.req.param('token'));
    if (!invite) return invalidInvite(c);
    let joined: 'joined' | 'already-member' | 'already-friends';
    try {
      joined = klatsch.acceptInvite(c.get('userId'), invite);
    } catch (error) {
      if (error instanceof KlatschError) return invalidInvite(c);
      throw error;
    }
    const text =
      joined === 'already-friends' ? copy.invite.alreadyFriends(invite.inviterHandle) : joined === 'joined' ? copy.invite.joined(invite.circleName) : copy.invite.alreadyMember(invite.circleName);
    return c.html(notice(copy.invite.title, html`<p class="sub">${text}</p>${joined === 'joined' ? html`<p class="sub">${copy.invite.chatAppAgain}</p><p class="sub">${copy.push.hint} <a href="/ui/settings#notifications">${copy.push.hintLink}</a></p>` : ''}${circlesLink}`, false));
  });

  // ---------- agent tokens ----------

  /** The client picked on the Tokens page (`?client=`, or the Connect form's field); Claude Code unless it is another we know. */
  const pickedClient = (value: unknown): Pick => (typeof value === 'string' && Object.hasOwn(copy.tokens.pick, value) ? (value as Pick) : 'claude');

  web.get('/tokens', (c) => {
    const user = klatsch.user(c.get('userId'));
    const setup = { hosted: isHosted(config), url: config.publicUrl, handle: user.handle };
    return show(c, copy.tokens.title, 'tokens', tokensPage(tokensOf(db, user.id), pickedClient(c.req.query('client')), setup, c.get('csrf')));
  });

  // Shown once, with the command that hands it to the client; only its keyed hash is stored.
  web.post('/tokens', async (c) => {
    const userId = c.get('userId');
    if (!klatsch.inAnyCircle(userId)) {
      return c.html(notice(copy.layout.notPossible, html`<p class="sub">${copy.tokens.noCircle}</p><p><a href="/ui">${copy.layout.back}</a></p>`), 409);
    }
    const client = pickedClient((await c.req.parseBody()).client);
    const label = `web:${day(Date.now())}`;
    const { token, tokenId } = createToken(db, secret, userId, { ttlDays: config.tokenTtlDays, label });
    klatsch.audit(userId, 'web', 'token.create', tokenId);
    const t = copy.tokens;
    return show(
      c,
      t.createdTitle,
      'tokens',
      html`<div class="ph"><h1>${t.createdTitle}</h1></div>
        <section class="sec">
          ${isHosted(config)
            ? html`<p class="hint">${t.hostedNote(config.tokenTtlDays, t.pick[client])}</p>
                ${connectCommands(client, hostedCommand(config.publicUrl))}
                <p class="hint">${t.tokenLine}</p>
                <code class="cmd">${token}</code>
                ${client === 'claude' ? html`<p class="hint">${t.withoutCli}</p><code class="cmd">${mcpAddCommand(config.publicUrl, token)}</code>` : ''}`
            : html`<p class="hint">${t.createdNote(config.tokenTtlDays)}</p>
                <code class="cmd">${mcpAddCommand(base(c), token)}</code>`}
          <p class="hint"><a href="/ui/tokens">${t.backToTokens}</a></p>
        </section>`,
    );
  });

  web.post('/tokens/:id/revoke', (c) =>
    attempt(
      c,
      () => {
        if (!revokeToken(db, c.get('userId'), c.req.param('id'))) throw new KlatschError('not-found', copy.tokens.notLive);
        klatsch.audit(c.get('userId'), 'web', 'token.revoke', c.req.param('id'));
      },
      '/ui/tokens',
    ),
  );

  // klatsch connect without a token: the person types the code from their terminal and reads what it means.
  const connectForm = (c: Context<Env>, wrong: boolean) => {
    const t = copy.connect;
    return dialog(
      t.title,
      viewer(c),
      html`<h1 id="title">${t.title}</h1>
        <p class="sub">${t.prompt}</p>
        ${wrong ? html`<p class="flag">${t.wrongCode}</p>` : ''}
        <form method="post" action="/ui/connect">
          <input type="hidden" name="csrf" value="${c.get('csrf')}" />
          <input name="code" aria-label="${t.title}" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="${copy.device.placeholder}" maxlength="9" required autofocus />
          <button class="primary">${copy.device.continue}</button>
        </form>
        <p class="fine">${t.fine}</p>`,
    );
  };

  web.get('/connect', (c) => c.html(connectForm(c, false)));

  web.post('/connect', async (c) => {
    const session = c.get('session');
    if (tooManyTries(session)) return c.html(notice(copy.device.tooManyTitle, html`<p class="sub">${copy.device.tooMany}</p>`), 429);
    const form = await c.req.parseBody();
    const code = typeof form.code === 'string' ? normalizeCode(form.code) : '';
    const request = findConnect(db, secret, code);
    if (!request) {
      tries.get(session)!.count++;
      return c.html(connectForm(c, true), 404);
    }
    const t = copy.connect;
    const choice = (decision: string, label: string, primary: boolean) =>
      html`<form method="post" action="/ui/connect/decide"><input type="hidden" name="csrf" value="${c.get('csrf')}" /><input type="hidden" name="code" value="${code}" /><input type="hidden" name="decision" value="${decision}" /><button${primary ? html` class="primary"` : ''}>${label}</button></form>`;
    return c.html(
      dialog(
        t.title,
        viewer(c),
        html`${icon()}<h1 id="title">${t.sure(copy.tokens.clientNames[request.client] ?? t.title)}</h1>
          <p class="sub">${t.what}</p>
          <p class="flag">${t.warning}</p>
          <div class="two">${choice('declined', t.decline, false)}${choice('approved', t.allow, true)}</div>`,
      ),
    );
  });

  // The decision carries the code again, so only someone who entered it can decide.
  web.post('/connect/decide', async (c) => {
    const userId = c.get('userId');
    const form = await c.req.parseBody();
    const request = typeof form.code === 'string' ? findConnect(db, secret, normalizeCode(form.code)) : undefined;
    const allow = form.decision === 'approved';
    if (!request || !decideConnect(db, request.id, userId, allow)) return expired(c, 409);
    klatsch.audit(userId, 'web', allow ? 'connect.approve' : 'connect.decline', request.id);
    if (allow) klatsch.notifyUser(userId, copy.notifications.agentConnected);
    const t = copy.connect;
    return c.html(notice(allow ? t.doneTitle : t.declinedTitle, html`<p class="sub">${allow ? t.done : t.declined}</p>${homeLink}`));
  });

  // Approvals by code (RFC 8628 style): the agent shows a code, the human enters it here.
  const tries = new Map<string, { start: number; count: number }>();
  const tooManyTries = (session: string): boolean => {
    const now = Date.now();
    const current = tries.get(session);
    if (!current || now - current.start > 10 * 60 * 1000) {
      tries.set(session, { start: now, count: 0 });
      return false;
    }
    return current.count >= 10;
  };

  // A wrong code gets one line whatever the reason (unknown, used, expired, someone else's), and the form again.
  const codePage = (c: Context<Env>, wrong: boolean) =>
    dialog(
      copy.device.title,
      viewer(c),
      html`<h1 id="title">${copy.device.title}</h1>
        <p class="sub">${copy.device.prompt}</p>
        ${wrong ? html`<p class="flag">${copy.device.wrongCode}</p>` : ''}
        <form method="post" action="/ui/device">
          <input type="hidden" name="csrf" value="${c.get('csrf')}" />
          <input name="code" aria-label="${copy.device.title}" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="${copy.device.placeholder}" maxlength="9" required autofocus />
          <button class="primary">${copy.device.continue}</button>
        </form>
        <p class="fine">${copy.device.fine}</p>`,
    );

  web.get('/device', (c) => c.html(codePage(c, false)));

  // Unknown, used, expired and other people's requests and codes all get the same words.
  const expired = (c: Context<Env>, status: 404 | 409) =>
    c.html(notice(copy.approval.expiredTitle, html`<p class="sub">${copy.approval.expired}</p>${homeLink}`), status);

  // Opened by the MCP client (URL-mode elicitation). The approval must belong to the signed-in human:
  // MCP requires the user who completes the page to be the user behind the request.
  web.get('/approvals/:id', (c) => {
    const approval = getApproval(db, c.get('userId'), c.req.param('id'));
    if (!approval || approval.state !== 'pending') return expired(c, 404);
    return approvalPage(c, approval, `/ui/approvals/${approval.id}/decide`, '');
  });

  web.post('/approvals/:id/decide', async (c) => {
    const form = await c.req.parseBody();
    const approval = getApproval(db, c.get('userId'), c.req.param('id'));
    if (!approval || approval.state !== 'pending') return expired(c, 409);
    return decided(c, approval, form);
  });

  web.post('/device', async (c) => {
    const session = c.get('session');
    if (tooManyTries(session)) return c.html(notice(copy.device.tooManyTitle, html`<p class="sub">${copy.device.tooMany}</p>`), 429);
    const form = await c.req.parseBody();
    const code = typeof form.code === 'string' ? normalizeCode(form.code) : '';
    const approval = findByCode(db, secret, c.get('userId'), code);
    if (!approval) {
      tries.get(session)!.count++;
      return c.html(codePage(c, true), 404);
    }
    return approvalPage(c, approval, '/ui/device/decide', code);
  });

  // The decision carries the code again, so only someone who entered it can decide.
  web.post('/device/decide', async (c) => {
    const form = await c.req.parseBody();
    const approval = typeof form.code === 'string' ? findByCode(db, secret, c.get('userId'), form.code) : undefined;
    if (!approval) return expired(c, 409);
    return decided(c, approval, form);
  });

  /** The exact action, as the human approves it. `code` is carried when the page was reached by code. */
  function approvalPage(c: Context<Env>, approval: Approval, action: string, code: string) {
    let what: ApprovalView;
    try {
      what = klatsch.describeApproval(c.get('userId'), approval);
    } catch (error) {
      if (error instanceof KlatschError) return c.html(notice(copy.layout.notPossible, html`<p class="sub">${error.message}</p>`), 409);
      throw error;
    }
    const carried = html`<input type="hidden" name="csrf" value="${c.get('csrf')}" />${code ? html`<input type="hidden" name="code" value="${code}" />` : ''}`;
    const decide = (decision: string, label: string, primary: boolean) =>
      html`<form method="post" action="${action}">${carried}<input type="hidden" name="decision" value="${decision}" /><button${primary ? html` class="primary"` : ''}>${label}</button></form>`;
    // Secondary on the left, primary on the right, as in a macOS dialog.
    const choices = (yes: string, no: string) => html`<div class="two">${decide('declined', no, false)}${decide('approved', yes, true)}</div>`;
    const card = (heading: string, top: unknown, body: unknown) => c.html(dialog(heading, viewer(c), html`${top}<h1 id="title">${heading}</h1>${body}`));
    if (what.action === 'share_sip') {
      const t = copy.approval.share;
      const tried = what.status === 'tried';
      const solved = what.status === 'solved' || tried;
      // Where it is shared, and for a solved sip who reads it, are decided here, in the same form as Share. The
      // agent's proposal is only preselected; public circles are shared in only when ticked here.
      const choose = choosesCircles(what.circles);
      const form = html`<form method="post" action="${action}">
        ${carried}${solved ? visibilityChoice(what.visibility, undefined, tried) : ''}${matchInChoice(what.circles, solved ? 'solved' : what.status)}
        <div class="two"><button name="decision" value="declined">${t.no}</button><button class="primary" name="decision" value="approved">${t.yes}</button></div>
      </form>`;
      return card(
        tried ? t.triedHeading : solved ? t.solvedHeading : t.heading,
        icon(),
        html`<p class="sub">${t.line(what.status)}</p>
          <p class="quote">“${what.summary}”</p>
          ${what.source ? sourceCard(what.source) : ''}
          ${tagList(what.tags)} ${flagList(what.flags)} ${what.askForIntro ? html`<p class="fine">${choose ? t.askForIntroIn : t.askForIntro}</p>` : ''} ${solved || choose ? form : choices(t.yes, t.no)}
          ${what.source ? html`<p class="fine">${copy.source.fine}</p>` : ''}
          ${klatsch.semanticOn && what.status !== 'want-to-discuss' ? html`<p class="fine">${copy.approval.share.semantic}</p>` : ''}`,
      );
    }
    if (what.action === 'send_intro') {
      const t = copy.approval.sendIntro;
      return card(
        t.heading,
        icon(),
        html`<p class="sub">${t.lead}</p>
          <p class="quote">“${what.summary}”</p>
          ${tagList(what.tags)}
          <p class="fine">${t.note}</p>
          ${choices(t.yes, t.no)}`,
      );
    }
    if (what.action === 'ask_person') {
      const t = copy.approval.askPerson;
      return card(
        t.heading(what.to.name),
        pair(what.to.name, viewer(c).name, { leftBlue: true }),
        html`<p class="sub">${t.lead(what.to.name, what.to.handle)}</p>
          <p class="quote">“${what.question}”</p>
          ${tagList(what.tags)} ${flagList(what.flags)}
          ${choices(t.yes, t.no)}`,
      );
    }
    if (what.action === 'send_message') {
      const t = copy.approval.sendMessage;
      return card(
        t.heading(what.to.name),
        pair(what.to.name, viewer(c).name, { leftBlue: true }),
        html`<p class="sub">${t.lead(what.to.name, what.to.handle)}</p>
          <p class="quote">“${what.text}”</p>
          ${flagList(what.flags)}
          ${choices(t.yes, t.no)}`,
      );
    }
    if (what.action === 'answer_ask') {
      const t = copy.approval.answerAsk;
      return card(
        t.heading(what.from.name),
        pair(what.from.name, viewer(c).name, { leftBlue: true }),
        html`<p class="sub">${t.lead}</p>
          <p class="quote"><span class="m">${t.question}</span>“${what.question}”</p>
          <p class="quote"><span class="m">${t.answer}</span>“${what.answer}”</p>
          ${what.tried ? html`<p class="fine">${t.tried}</p>` : ''}
          ${tagList(what.tags)} ${flagList(what.flags)}
          ${choices(t.yes, t.no)}`,
      );
    }
    const t = copy.incomingIntro;
    return card(
      t.heading,
      pair('?', viewer(c).name),
      html`<p class="sub">${t.lead}</p>
        <p class="quote">“${what.request}”</p>
        ${tagList(what.tags)}
        ${choices(t.accept, t.decline)}
        ${decide('always', copy.consent.allowAlways, false)}
        <p class="fine">${t.note} ${what.circle ? copy.consent.allowAlwaysIn(what.circle) : copy.consent.allowAlwaysNote}</p>`,
    );
  }

  /** The decision and what the human chose with it: who reads a solved sip, and "always" on an intro. */
  function decided(c: Context<Env>, approval: Approval, form: Record<string, unknown>) {
    const userId = c.get('userId');
    const decision = form.decision === 'approved' || form.decision === 'always' ? 'approved' : 'declined';
    const matchIn = matchInOf(form);
    // A tab opened before the person joined another circle: it asked nothing, so nothing is guessed.
    if (decision === 'approved' && approval.action === 'share_sip' && !matchIn && choosesCircles(klatsch.sharingCircles(userId))) {
      return c.html(notice(copy.layout.notPossible, html`<p class="sub">${copy.consent.stale}</p>`), 409);
    }
    const choice: Choice = {
      ...(form.visibility === 'open' || form.visibility === 'ask' ? { visibility: form.visibility } : {}),
      ...(form.decision === 'always' && approval.action === 'answer_intro' ? { always: true } : {}),
      ...(matchIn ? { matchIn } : {}),
      ...(form.feed === '1' && form.visibility === 'open' ? { feed: true } : {}),
    };
    try {
      klatsch.decideApproval(userId, approval, decision, choice);
    } catch (error) {
      if (error instanceof KlatschError) return c.html(notice(copy.layout.notPossible, html`<p class="sub">${error.message}</p>`), 409);
      throw error;
    }
    const t = copy.approval;
    const done = (title: string, line: unknown, good: boolean) =>
      c.html(notice(title, html`<p class="sub">${line}</p><p class="fine">${t.closeNote}</p>${homeLink}`, !good));
    if (decision === 'declined') return done(t.declinedTitle, t.declined, false);
    if (approval.action === 'share_sip') return done(t.sharedTitle, t.shared, true);
    if (approval.action === 'send_intro') return done(t.askedTitle, t.asked, true);
    if (approval.action === 'ask_person') return done(t.askSentTitle, t.askSent, true);
    if (approval.action === 'send_message') return done(t.messageSentTitle, t.messageSent, true);
    if (approval.action === 'answer_ask') return done(t.answerSentTitle, t.answerSent, true);
    const introId = approval.payload.intro_id!;
    const intro = klatsch.introOf(userId, introId);
    const other = intro.other;
    if (!other) return done(copy.connected.heading, '', true);
    // Their sip while it is readable, and the one way to hand it to your agent: your own click.
    const sip =
      other.shared && other.summary
        ? html`<p class="quote"><span class="m">${copy.connected.theirSip}</span>“${other.summary}”</p>
            ${other.source ? sourceCard(other.source) : ''}
            ${intro.mine ? html`<p class="quote"><span class="m">${copy.connected.yourSip}</span>${intro.mine.summary}</p>` : ''}
            ${other.canThank
              ? html`<div class="two">${thanksButton(`/ui/intros/${introId}`, other.thanked, c.get('csrf'), true)}${button(`/ui/intros/${introId}/send`, copy.handoff.sendToAgent, c.get('csrf'), 'primary')}</div>`
              : button(`/ui/intros/${introId}/send`, copy.handoff.sendToAgent, c.get('csrf'), 'primary')}
            ${other.sends ? '' : button(`/ui/intros/${introId}/send-always`, copy.consent.sendAlways(other.handle), c.get('csrf'))}
            <p class="fine">${copy.handoff.visibleUntil(until(other.visibleUntil))} ${copy.handoff.note}</p>
            <p class="fine">${other.sends ? copy.consent.sendsAlways(other.handle) : copy.consent.sendAlwaysNote}</p>
            ${other.canThank ? html`<p class="fine">${copy.thanks.connectedNote(other.displayName)}</p>` : ''}`
        : html`<p class="fine">${copy.handoff.noLongerShared(other.handle)}</p>`;
    return c.html(
      dialog(
        copy.connected.heading,
        undefined,
        html`${pair(other.displayName, viewer(c).name, { leftBlue: true })}
          <h1 id="title">${copy.connected.headingWith(other.displayName)}</h1>
          <p class="sub">${copy.connected.who(other.displayName, other.handle)}</p>
          ${sip}${homeLink}`,
      ),
    );
  }

  /** Runs a change: a refusal shows "Not possible" with a way back; success redirects there, or shows `done`. */
  function attempt(c: Context<Env>, fn: () => void, back: string, done?: () => Response | Promise<Response>) {
    try {
      fn();
    } catch (error) {
      if (error instanceof KlatschError) {
        return c.html(notice(copy.layout.notPossible, html`<p class="sub">${error.message}</p><p><a href="${back}">${copy.layout.back}</a></p>`), 409);
      }
      throw error;
    }
    return done ? done() : c.redirect(back, 303);
  }

  const act = (fn: (userId: string, id: string) => void) => (c: Context<Env>) => attempt(c, () => fn(c.get('userId'), c.req.param('id') ?? ''), '/ui');

  // A draft is shared in the circles ticked next to Share; a solved one opens only when the human picked that there.
  web.post('/sips/:id/approve', async (c) => {
    const form = await c.req.parseBody();
    const userId = c.get('userId');
    return attempt(
      c,
      () => {
        const matchIn = matchInOf(form);
        if (!matchIn && choosesCircles(klatsch.sharingCircles(userId))) throw new KlatschError('invalid', copy.consent.stale);
        klatsch.approveSip(userId, c.req.param('id'), 'web', form.visibility === 'open' ? 'open' : 'ask', matchIn, form.visibility === 'open' && form.feed === '1');
      },
      '/ui',
    );
  });
  web.post('/sips/:id/reject', act((u, id) => klatsch.rejectSip(u, id)));
  web.post('/sips/:id/retire', act((u, id) => klatsch.retireSip(u, id)));
  web.post('/sips/:id/confirm', act((u, id) => klatsch.confirmSip(u, id)));
  web.post('/intros/:id/approve', act((u, id) => void klatsch.approveIntro(u, id)));
  web.post('/intros/:id/allow-always', act((u, id) => void klatsch.approveIntro(u, id, 'web', true)));
  web.post('/intros/:id/decline', act((u, id) => klatsch.declineIntro(u, id)));
  // Only a party to an accepted intro, or a reader of a note open to them, by a form post in their own
  // session (form token, Origin), hands the other person's note to their own agent, once or always; no
  // tool can ask for it or for an "always".
  const send = (fn: (userId: string, id: string, always: boolean) => { from: string }, always: boolean) => (c: Context<Env>) => {
    let from = '';
    return attempt(
      c,
      () => void (from = fn(c.get('userId'), c.req.param('id') ?? '', always).from),
      '/ui',
      () => c.html(notice(copy.handoff.sentTitle, html`<p class="sub">${always ? copy.consent.sentAlways(from) : copy.handoff.sent(from)}</p>${homeLink}`, false)),
    );
  };
  const sendQuote = (u: string, id: string, always: boolean) => klatsch.sendQuote(u, id, always);
  const sendNote = (u: string, id: string, always: boolean) => klatsch.sendNote(u, id, always);
  web.post('/intros/:id/send', send(sendQuote, false));
  web.post('/intros/:id/send-always', send(sendQuote, true));
  web.post('/notes/:id/send', send(sendNote, false));
  // Direct questions: only the two people in it act on it, each in their own session.
  /** The person's optional word on how their AI should answer, from the form next to "Brew a reply". */
  const howOf = async (c: Context<Env>) => {
    const how = (await c.req.parseBody()).how;
    return typeof how === 'string' ? how : undefined;
  };
  web.post('/asks/:id/send', async (c) => {
    let from = '';
    const how = await howOf(c);
    return attempt(
      c,
      () => void (from = klatsch.sendAskToAgent(c.get('userId'), c.req.param('id'), how).from),
      '/ui',
      () => c.html(notice(copy.asks.sentTitle, html`<p class="sub">${copy.asks.sent(from)}</p>${homeLink}`)),
    );
  });
  // The person asked types the answer on their page; it goes to the asker's agent at once (the page says so).
  /** The files a form sent (input `file`, one or several), read into memory: the body limit keeps them small. */
  const formFiles = async (form: Record<string, unknown>) => {
    const sent = ([] as unknown[]).concat(form.file ?? form['file[]'] ?? []).filter((f): f is File => typeof f === 'object' && f !== null && 'arrayBuffer' in f && (f as File).size > 0);
    return Promise.all(sent.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
  };
  web.post('/asks/:id/answer', async (c) => {
    const form = await c.req.parseBody({ all: true });
    const answer = typeof form.answer === 'string' ? form.answer : '';
    const files = await formFiles(form);
    return attempt(
      c,
      () =>
        transaction(db, () => {
          klatsch.answerByHand(c.get('userId'), c.req.param('id'), answer);
          for (const file of files) klatsch.attach(c.get('userId'), c.req.param('id'), file);
        }),
      '/ui',
      // Answered from the conversation: back to it, like any reply. Only a path to a conversation is followed.
      () =>
        typeof form.back === 'string' && /^\/ui\/chat\/[\w%.-]+$/.test(form.back)
          ? c.redirect(`${form.back}#end`, 303)
          : c.html(notice(copy.asks.answeredTitle, html`<p class="sub">${copy.asks.answered}</p>${homeLink}`)),
    );
  });
  // A file with one's own waiting question.
  web.post('/asks/:id/attach', async (c) => {
    const files = await formFiles(await c.req.parseBody({ all: true }));
    return attempt(
      c,
      () =>
        transaction(db, () => {
          if (!files.length) throw new KlatschError('invalid', copy.asks.noFile);
          for (const file of files) klatsch.attach(c.get('userId'), c.req.param('id'), file);
        }),
      '/ui',
    );
  });
  // A file, for one of the two people: shown in the browser only where that is safe, sandboxed and never sniffed.
  web.get('/attachments/:id', (c) => {
    let file: { name: string; mime: string; bytes: Buffer };
    try {
      file = klatsch.openAttachment(c.get('userId'), c.req.param('id'));
    } catch (error) {
      if (error instanceof KlatschError) return c.html(notice(copy.layout.notPossible, html`<p class="sub">${error.message}</p>${homeLink}`), 404);
      throw error;
    }
    // A PDF downloads: browsers' PDF viewers do not run under a sandbox policy. Photos and voice notes show inline.
    const inline = file.mime.startsWith('image/') || file.mime.startsWith('audio/');
    c.header('Content-Type', file.mime);
    c.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    c.header('Content-Security-Policy', FILE_CSP);
    c.header('Cache-Control', 'private, no-store');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    return c.body(new Uint8Array(file.bytes));
  });
  // One conversation per friend: read (which marks their messages read), write with files, or hand it to one's AI.
  web.get('/chat/:handle', (c) => {
    let view: ConversationView;
    try {
      view = klatsch.conversation(c.get('userId'), c.req.param('handle'), { markRead: true });
    } catch (error) {
      if (error instanceof KlatschError) return c.html(notice(copy.layout.notPossible, html`<p class="sub">${error.message}</p>${homeLink}`), 404);
      throw error;
    }
    const files = !klatsch.isGuest(c.get('userId'));
    // The voice note button runs /ui/record.js, and voice notes play inline: both same-origin.
    c.header('Content-Security-Policy', CHAT_CSP);
    const userId = c.get('userId');
    const asks = klatsch.asksOf(userId);
    const between = asks.filter((k) => (k.state === 'open' || k.state === 'answered') && k.other.handle === view.other.handle).sort((x, y) => x.createdAt - y.createdAt);
    return c.html(messenger(view.other.name, chatSide(klatsch.conversationsOf(userId), asks, c.get('csrf'), view.other.handle, getCookie(c, THEME_COOKIE) ?? 'auto'), chatPane(view, c.get('csrf'), files, between), true));
  });
  web.post('/chat/:handle', async (c) => {
    const form = await c.req.parseBody({ all: true });
    const typed = typeof form.text === 'string' ? form.text : '';
    const files = await formFiles(form);
    // A voice note or a file alone, like in a messenger: the message says what it is, for Home and the friend's AI.
    const text = typed.trim() || !files.length ? typed : form.voice === '1' ? copy.chat.voiceNote : copy.chat.fileOnly;
    const back = `/ui/chat/${encodeURIComponent(normalHandle(c.req.param('handle')))}`;
    return attempt(
      c,
      () =>
        transaction(db, () => {
          const id = klatsch.sendMessage(c.get('userId'), c.req.param('handle'), text, 'web');
          for (const file of files) klatsch.attachToMessage(c.get('userId'), id, file);
        }),
      back,
      () => c.redirect(`${back}#end`, 303),
    );
  });
  web.post('/chat/:handle/agent', async (c) => {
    let from = '';
    const how = await howOf(c);
    return attempt(
      c,
      () => void (from = klatsch.sendConversationToAgent(c.get('userId'), c.req.param('handle'), 'web', how).from),
      '/ui',
      () => c.html(notice(copy.chat.sentToAgentTitle, html`<p class="sub">${copy.chat.sentToAgent(from)}</p>${homeLink}`)),
    );
  });
  web.post('/asks/:id/decline', act((u, id) => klatsch.declineAsk(u, id)));
  web.post('/asks/:id/withdraw', act((u, id) => klatsch.withdrawAsk(u, id)));
  web.post('/notes/:id/send-always', send(sendNote, true));
  // "Thanks, this helped": a human's click only (form token, Origin), for a note that reached them or an intro
  // they are part of. Once each; the author sees a count, no names. The agent's own thanks (`thank_note`) the
  // human sees on Home and can take back here; a thanks the human gave is final.
  web.post('/notes/:id/thanks', act((u, id) => klatsch.thankNote(u, id)));
  web.post('/intros/:id/thanks', act((u, id) => klatsch.thankIntro(u, id)));
  web.post('/thanks/:id/undo', act((u, id) => klatsch.undoAgentThanks(u, id)));
  // Adding a passkey: the challenge is bound to this session and this origin, good once for five minutes.
  web.post('/passkeys/options', async (c) => {
    const at = passkeyAt(c);
    if (!at) return c.notFound();
    const userId = c.get('userId');
    const user = klatsch.user(userId);
    const options = await generateRegistrationOptions({
      rpName: copy.layout.brand,
      rpID: at.rpID,
      userID: passkeyUserId(userId),
      userName: `@${user.handle}`,
      userDisplayName: user.display_name,
      attestationType: 'none',
      timeout: PASSKEY_CHALLENGE_MS,
      excludeCredentials: passkeysOf(db, userId).map((passkey) => ({ id: passkey.id })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const key = challenges.put({ challenge: options.challenge, owner: `session ${keyedHash(secret, c.get('session'))}`, origin: at.origin });
    return c.json({ key, options });
  });

  web.post('/passkeys', async (c) => {
    const at = passkeyAt(c);
    if (!at) return c.notFound();
    const data = await passkeyData(c);
    const challenge = takeChallenge(data?.key, `session ${keyedHash(secret, c.get('session'))}`, at.origin);
    if (!challenge || !data?.credential) return c.json({ error: copy.passkeys.error }, 400);
    let verified;
    try {
      verified = await verifyRegistrationResponse({
        response: data.credential as RegistrationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: at.origin,
        expectedRPID: at.rpID,
        requireUserVerification: true,
      });
    } catch {
      return c.json({ error: copy.passkeys.error }, 400);
    }
    if (!verified.verified) return c.json({ error: copy.passkeys.error }, 400);
    const { credential, credentialBackedUp } = verified.registrationInfo;
    try {
      klatsch.addPasskey(c.get('userId'), {
        id: credential.id,
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: (credential.transports ?? []).filter((t) => /^[a-z-]{1,16}$/.test(t)),
        synced: credentialBackedUp,
      });
    } catch (error) {
      if (!(error instanceof KlatschError)) throw error;
      return c.json({ error: error.message }, 409);
    }
    // Saved from Home's offer: back to Home (one fixed path), where the offer is then gone.
    return c.json({ next: data.back === 'home' ? '/ui' : '/ui/settings#passkeys' });
  });

  web.post('/push/offer/dismiss', (c) => {
    klatsch.dismissPushOffer(c.get('userId'));
    return c.redirect('/ui', 303);
  });

  web.post('/passkeys/offer/dismiss', (c) => {
    klatsch.dismissPasskeyOffer(c.get('userId'));
    return c.redirect('/ui', 303);
  });

  web.post('/passkeys/:id/delete', (c) => attempt(c, () => klatsch.removePasskey(c.get('userId'), c.req.param('id')), '/ui/settings#passkeys'));

  web.post('/settings/sessions/end-others', (c) => {
    const ended = endOtherSessions(db, secret, c.get('userId'), c.get('session'));
    klatsch.audit(c.get('userId'), 'web', 'session.end-others', String(ended));
    return c.redirect('/ui/settings', 303);
  });

  // OAuth consent: an app (ChatGPT, claude.ai) asks to act as this person's agent. Nothing is approved here but
  // the connection itself; every share and answer still waits for the person, as with any agent.
  const oauthResources = [`${config.publicUrl}/mcp`, config.publicUrl];
  const oauthAnswer = (c: Context, read: ReturnType<typeof readAuthorize>) => {
    if ('fatal' in read) {
      const t = copy.oauth;
      return c.html(notice(t.badTitle, html`<p class="sub">${read.fatal === 'unknown-client' ? t.unknownClient : t.badRedirect}</p>${homeLink}`), 400);
    }
    if ('back' in read) {
      const { redirectUri, state, error, description } = read.back;
      return c.redirect(redirectTo(redirectUri, { error, error_description: description, state, iss: config.publicUrl }), 303);
    }
    return undefined;
  };
  web.get('/oauth/authorize', (c) => {
    const read = readAuthorize(db, c.req.query(), oauthResources);
    const answered = oauthAnswer(c, read);
    if (answered || !('ok' in read)) return answered!;
    const { client, redirectUri, state, challenge } = read.ok;
    const t = copy.oauth;
    const host = new URL(redirectUri).host;
    c.header('Content-Security-Policy', consentCsp(redirectUri));
    const hidden = (name: string, value: string | undefined) => (value === undefined ? '' : html`<input type="hidden" name="${name}" value="${value}" />`);
    return c.html(
      dialog(
        t.title(client.name),
        viewer(c),
        html`${icon()}
          <h1 id="title">${t.title(client.name)}</h1>
          <p class="sub">${t.lead(client.name, host)}</p>
          <ul class="sub">${t.points.map((line) => html`<li>${line}</li>`)}</ul>
          <p class="flag">${t.warn(host)}</p>
          ${guestEnds(c.get('userId')) ? html`<p class="sub">${copy.guest.consent(guestEnds(c.get('userId'))!)}</p>` : ''}
          <form method="post" action="/ui/oauth/authorize">
            <input type="hidden" name="csrf" value="${c.get('csrf')}" />
            ${hidden('client_id', client.id)}${hidden('redirect_uri', redirectUri)}${hidden('state', state)}${hidden('code_challenge', challenge)}
            ${hidden('code_challenge_method', 'S256')}${hidden('response_type', 'code')}${hidden('resource', c.req.query('resource'))}
            <div class="two"><button name="decision" value="deny">${t.deny}</button><button class="primary" name="decision" value="allow">${t.allow}</button></div>
          </form>`,
      ),
    );
  });
  web.post('/oauth/authorize', async (c) => {
    const form = Object.fromEntries(Object.entries(await c.req.parseBody()).filter((e): e is [string, string] => typeof e[1] === 'string'));
    const read = readAuthorize(db, form, oauthResources);
    const answered = oauthAnswer(c, read);
    if (answered || !('ok' in read)) return answered!;
    const request = read.ok;
    if (form.decision !== 'allow') {
      return c.redirect(redirectTo(request.redirectUri, { error: 'access_denied', state: request.state, iss: config.publicUrl }), 303);
    }
    const code = issueCode(db, secret, c.get('userId'), request);
    klatsch.audit(c.get('userId'), 'web', 'oauth.authorize', request.client.id);
    return c.redirect(redirectTo(request.redirectUri, { code, state: request.state, iss: config.publicUrl }), 303);
  });

  web.get('/settings/delete', (c) => c.html(deletePage(c.get('userId'), c.get('csrf'), viewer(c))));

  web.post('/settings/delete', async (c) => {
    const userId = c.get('userId');
    const form = await c.req.parseBody();
    const typed = String(form.handle ?? '').trim().replace(/^@/, '').toLowerCase();
    if (typed !== klatsch.user(userId).handle.toLowerCase()) return c.html(deletePage(userId, c.get('csrf'), viewer(c), true), 400);
    klatsch.deleteAccount(userId, 'web');
    deleteCookie(c, COOKIE, { path: '/ui' });
    return c.html(notice(copy.settings.deletedTitle, html`<p class="sub">${copy.settings.deletedLine}</p>`, false));
  });

  /** What deleting takes, the circles that change hands, and a field for the handle: a second look, not a speed bump. */
  function deletePage(userId: string, csrf: string, who: ReturnType<typeof viewer>, mismatch = false) {
    const t = copy.settings;
    const handle = klatsch.user(userId).handle;
    const handedOn = (
      db
        .prepare(
          `SELECT c.name FROM memberships m JOIN circles c ON c.id = m.circle_id WHERE m.user_id = ? AND m.role = 'owner'
             AND EXISTS (SELECT 1 FROM memberships o WHERE o.circle_id = m.circle_id AND o.user_id <> m.user_id) ORDER BY c.name`,
        )
        .all(userId) as { name: string }[]
    ).map((r) => r.name);
    return dialog(
      t.deleteTitle,
      who,
      html`<h1 id="title">${t.deleteTitle}</h1>
        <ul class="sub">${t.deleteGoes.map((line) => html`<li>${line}</li>`)}</ul>
        ${handedOn.length ? html`<p class="sub">${t.deleteCircles(handedOn)}</p>` : ''}
        <p class="sub">${t.deleteBackups}</p>
        ${mismatch ? html`<p class="flag" role="alert">${t.deleteMismatch}</p>` : ''}
        <form method="post" action="/ui/settings/delete">
          <input type="hidden" name="csrf" value="${csrf}" />
          <label class="sub" for="handle">${t.deleteConfirmLabel(handle)}</label>
          <input id="handle" type="text" name="handle" autocomplete="off" autocapitalize="none" spellcheck="false" required />
          <div class="two"><a class="button" href="/ui/settings">${t.cancel}</a><button class="primary">${t.deleteConfirm}</button></div>
        </form>`,
    );
  }

  web.post('/guest/end', (c) => {
    const userId = c.get('userId');
    if (!klatsch.isGuest(userId)) return c.notFound();
    klatsch.endGuest(userId, 'web');
    deleteCookie(c, COOKIE, { path: '/ui' });
    return c.html(notice(copy.guest.ended, html`<p class="sub">${copy.guest.endedLine}</p><p><a href="/ui">${copy.signIn.title}</a></p>`, false));
  });

  /** How long a guest has left, as words; undefined for everyone else. */
  const guestEnds = (userId: string) => {
    const at = klatsch.guestExpiresAt(userId);
    return at === undefined ? undefined : copy.guest.left(at - Date.now());
  };
  /** Home and Settings for a guest: how long it has left, and the way out to a real account. */
  const guestBanner = (expiresAt: number, csrf: string) =>
    html`<section class="offer" aria-label="${copy.guest.end}"><p>${copy.guest.banner(copy.guest.left(expiresAt - Date.now()))}</p><p class="sub">${copy.guest.upgrade}</p>${button('/ui/guest/end', copy.guest.end, csrf, 'primary')}</section>`;

  // A message's own menu: star or unstar (for oneself), pin or unpin (for both), delete for oneself or for everyone.
  const MESSAGE_ACTIONS = ['star', 'unstar', 'pin', 'unpin', 'hide', 'delete'] as const;
  web.post('/messages/:id/:action', (c) => {
    const action = c.req.param('action') as (typeof MESSAGE_ACTIONS)[number];
    if (!MESSAGE_ACTIONS.includes(action)) return c.notFound();
    const userId = c.get('userId');
    const id = c.req.param('id');
    let other = '';
    return attempt(
      c,
      () => {
        other =
          action === 'star' || action === 'unstar'
            ? klatsch.starMessage(userId, id, action === 'star')
            : action === 'pin' || action === 'unpin'
              ? klatsch.pinMessage(userId, id, action === 'pin')
              : action === 'hide'
                ? klatsch.hideMessage(userId, id)
                : klatsch.deleteMessageForEveryone(userId, id);
      },
      '/ui',
      () => c.redirect(`/ui/chat/${encodeURIComponent(other)}${action === 'hide' || action === 'delete' ? '#end' : `#m-${id}`}`, 303),
    );
  });

  // The person's starred messages, in the messenger's pane.
  web.get('/starred', (c) => {
    const userId = c.get('userId');
    const t = copy.chat;
    const starred = klatsch.starredOf(userId);
    return c.html(
      messenger(
        t.starredTitle,
        chatSide(klatsch.conversationsOf(userId), klatsch.asksOf(userId), c.get('csrf'), undefined, getCookie(c, THEME_COOKIE) ?? 'auto'),
        html`<header class="chathead"><a class="iconbtn back" href="/ui" aria-label="${t.back}">‹</a><div class="who"><h1>${t.starredTitle}</h1></div></header>
          <div class="scroll"><div class="inner">${starred.length
            ? html`<ol class="starred">${starred.map(
                (m) => html`<li><a href="/ui/chat/${encodeURIComponent(m.other.handle)}#m-${m.id}"><span class="m">${m.mine ? t.you : m.other.name} · ${shortWhen(m.at)}</span><p>${m.text}</p></a></li>`,
              )}</ol>`
            : html`<p class="hint">${t.starredNone}</p>`}</div></div>`,
        true,
      ),
    );
  });

  // Night or day for this browser: a year, everywhere on the relay; Auto removes the choice.
  web.post('/theme', async (c) => {
    const theme = (await c.req.parseBody()).theme;
    if (theme === 'light' || theme === 'dark') setCookie(c, THEME_COOKIE, theme, { path: '/', maxAge: 365 * 24 * 60 * 60, sameSite: 'Lax', secure, httpOnly: true });
    else deleteCookie(c, THEME_COOKIE, { path: '/', secure });
    // Back to the page it was chosen on, when that is a page of this relay.
    const from = c.req.header('Referer');
    const back = from && from.startsWith(`${base(c)}/ui`) ? new URL(from).pathname : '/ui';
    return c.redirect(back, 303);
  });

  web.post('/logout', (c) => {
    endSession(db, secret, c.get('session'));
    deleteCookie(c, COOKIE, { path: '/ui' });
    return c.html(notice(copy.signIn.signedOutTitle, html`<p class="sub">${copy.signIn.signedOut}</p>`, false));
  });

  return web;
}

/**
 * A sheet with a title and a few lines: results, refusals and errors. A tick for good news, else a dash.
 * No name in the bar, so a neutral page is the same whoever opens it.
 */
function notice(title: string, body: unknown, muted = true) {
  return dialog(title, undefined, html`${outcome(!muted)}<h1 id="title">${title}</h1>${body}`);
}

const homeLink = html`<p><a href="/ui">${copy.layout.home}</a></p>`;

/**
 * "Brew a reply", with one optional line on what to say ("yes, 9 is fine, keep it short"): the line goes to the
 * person's own AI with the question or conversation. One box and one button, like writing a message.
 */
function howForm(action: string, label: string, how: string, placeholder: string, csrf: string, kind = 'reply') {
  return html`<form class="${kind}" method="post" action="${action}">
    <input type="hidden" name="csrf" value="${csrf}" />
    <div class="field"><input type="text" name="how" maxlength="300" autocomplete="off" aria-label="${how}" placeholder="${placeholder}" /><button>${label}</button></div>
  </form>`;
}

/**
 * What a guest may open and post: an allow-list, so a page added later is closed to guests until it is put here.
 * Home and conversations, questions, friend links (with other guests only, see `refuseGuest`), notifications,
 * connecting an agent or a chat app (tokens, the code page, approvals, the consent page), and the way out. Not:
 * email, passkeys, GitHub or Google, circles, files, intros, notes, deleting by handle.
 */
const GUEST_PAGES: Record<string, RegExp[]> = {
  GET: [/^\/ui\/?$/, /^\/ui\/chat\/[^/]+$/, /^\/ui\/settings$/, /^\/ui\/tokens$/, /^\/ui\/connect$/, /^\/ui\/device$/, /^\/ui\/approvals\/[^/]+$/, /^\/ui\/oauth\/authorize$/, /^\/ui\/circle$/, /^\/ui\/invite\/[^/]+$/, /^\/ui\/starred$/],
  POST: [
    /^\/ui\/chat\/[^/]+(\/agent)?$/,
    /^\/ui\/friends\/(invite|[^/]+\/end)$/,
    /^\/ui\/invite\/[^/]+$/,
    /^\/ui\/asks\/[^/]+\/(answer|decline|withdraw|send)$/,
    /^\/ui\/push\/(subscribe|sync|test|off|unsubscribe|offer\/dismiss)$/,
    /^\/ui\/passkeys\/offer\/dismiss$/,
    /^\/ui\/tokens(\/[^/]+\/revoke)?$/,
    /^\/ui\/(connect|device)(\/decide)?$/,
    /^\/ui\/approvals\/[^/]+\/decide$/,
    /^\/ui\/sips\/[^/]+\/(approve|reject|retire)$/,
    /^\/ui\/oauth\/authorize$/,
    /^\/ui\/guest\/end$/,
    /^\/ui\/theme$/,
    /^\/ui\/messages\/[^/]+\/(star|unstar|pin|unpin|hide|delete)$/,
    /^\/ui\/logout$/,
  ],
};
export const guestMay = (method: string, path: string) => (GUEST_PAGES[method] ?? []).some((page) => page.test(path));
const circlesLink = html`<p><a href="/ui/circle">${copy.invite.yourCircles}</a></p>`;

function flagList(flags: Flag[]) {
  if (!flags.length) return '';
  return html`<div class="flag">${copy.layout.flagged} ${flags.map((f) => html`<code>${f.kind}: ${f.text}</code> `)}</div>`;
}

/**
 * Who reads a solved sip: "Open to my circle" or "Ask me first", preselected as `current` (what the agent
 * proposed, or the draft holds), with what the picked one means. `form` ties the radios to a form elsewhere
 * on the page (a draft's Share button), which also keeps each draft's pair of radios its own group.
 */
function visibilityChoice(current: Visibility, form?: string, tried = false) {
  const t = copy.consent;
  const owner = form ? html` form="${form}"` : '';
  const option = (value: Visibility, label: string) =>
    html`<label><input type="radio" name="visibility" value="${value}"${owner}${current === value ? html` checked` : ''} /><span>${label}</span></label>`;
  return html`<fieldset class="choice">
    <legend>${t.visibility}</legend>
    <span class="options">${option('open', t.open)}${option('ask', t.ask)}</span>
    <p class="why why-open">${t.open}: ${t.openNote}</p>
    <p class="why why-open"><label><input type="checkbox" name="feed" value="1"${owner} checked /><span>${t.feedChoice}</span></label></p>
    <p class="why why-ask">${t.ask}: ${tried ? t.askNoteTried : t.askNote}</p>
  </fieldset>`;
}

/** Whether the person has a choice of circles to make: anything but exactly one private circle. */
const choosesCircles = (circles: SharingCircle[]) => !(circles.length === 1 && !circles[0]!.public);

/**
 * Where a sip is shared and matched: one checkbox per circle, private ones ticked and public ones not, with
 * what ticking a public one means for this sip (for a solved one, both meanings; the page shows the one that
 * fits the picked visibility where :has() works). Only where there is a choice. `form` as above.
 */
function matchInChoice(circles: SharingCircle[], status: SipRow['status'], form?: string) {
  if (!choosesCircles(circles)) return '';
  const t = copy.consent;
  const owner = form ? html` form="${form}"` : '';
  const why = (c: SharingCircle) =>
    status === 'solved'
      ? html`<p class="why why-open">${t.matchInPublic(c.name, c.people, 'open')}</p><p class="why why-ask">${t.matchInPublic(c.name, c.people, 'ask')}</p>`
      : html`<p class="why">${t.matchInPublic(c.name, c.people, 'looking')}</p>`;
  return html`<fieldset class="circles">
    <legend>${t.matchIn}</legend>
    <input type="hidden" name="scope" value="1"${owner} />
    ${circles.map(
      (c) => html`<label><input type="checkbox" name="in_${c.id}" value="1"${owner}${c.public || c.pair ? '' : html` checked`} /><span>${c.name} <span class="m">${copy.circle.people(c.people)}</span></span></label>
        ${c.public ? why(c) : ''}`,
    )}
  </fieldset>`;
}

/** The circles ticked for a sip, when the form asked (`scope`); otherwise none given, which means the private ones. */
function matchInOf(form: Record<string, unknown>): string[] | undefined {
  if (form.scope !== '1') return undefined;
  return Object.keys(form)
    .filter((key) => key.startsWith('in_') && form[key] === '1')
    .map((key) => key.slice(3));
}

/** A link opened from someone's note: a new tab, no referrer, no opener, and no endorsement for search engines. */
const SOURCE_REL = 'noopener noreferrer nofollow ugc';

/** Title and host apart, so a title cannot pass for another site; the host in full, punycode for IDN. */
const sourceMeta = (source: Source) => html`<span class="m"><b class="host">${sourceHost(source.url)}</b>${source.author ? ` · ${copy.source.by(source.author)}` : ''}</span>`;

/** A link card on a sheet (approval, connected): the title as a link, the host, the author, and the whole link to check. */
function sourceCard(source: Source) {
  return html`<div class="src">
    <span class="src-k">${copy.source.kicker}</span>
    <a href="${source.url}" rel="${SOURCE_REL}" target="_blank"><b>${source.title}</b></a>
    ${sourceMeta(source)}
    <code class="url">${source.url}</code>
  </div>`;
}

/** A link card in a list (Home): the title as a link, the host on its own line. */
const sourceLine = (source: Source) =>
  html`<span class="srcline"><a href="${source.url}" rel="${SOURCE_REL}" target="_blank"><span aria-hidden="true">↗ </span>${source.title}</a></span>${sourceMeta(source)}`;

/** Mail goes only to a confirmed address, so say whether this one is, and what confirms it. */
function emailState(user: UserRow) {
  if (user.email_verified_at !== null) return html`<p class="m">${copy.email.confirmed}</p>`;
  return html`<p class="flag">${copy.email.unconfirmed}</p>`;
}

const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/**
 * Passkey buttons are hidden until the passkey script finds the browser can use one (so without the script, or
 * without passkeys, nothing shows). This is the script and the line it shows when the prompt did not go through.
 */
const passkeyScript = () => html`<p id="passkey-error" class="flag" hidden>${copy.passkeys.error}</p><script src="/ui/passkey.js" defer></script>`;

const until = (ts: number) => `${new Date(ts).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** A name with the `@handle` beside it in grey. */
const named = (name: string, handle: string) => html`<span><span class="t">${name}</span> <span class="m">@${handle}</span></span>`;

/**
 * Members as a tree of who invited whom; someone whose inviter left the circle starts a new branch.
 * Members no root reaches (an invite cycle: B invited C, C later invited B back) start branches too,
 * so the owner always sees, and can remove, everyone.
 */
function memberTree(userId: string, circle: CircleView, csrf: string) {
  const ids = new Set(circle.members.map((m) => m.id));
  const shown = new Set<string>();
  type Member = CircleView['members'][number];
  const list = (members: Member[], top = false): unknown => (members.length ? html`<ul class="list">${members.map(item)}</ul>` : top ? html`<ul class="list"></ul>` : '');
  function item(m: Member): unknown {
    shown.add(m.id);
    const notes = [m.role === 'owner' ? copy.circle.owner : '', m.id === userId ? copy.circle.you : ''].filter(Boolean).join(' · ');
    return html`<li>
      <div class="item">
        ${avatar(m.displayName)}
        <div class="main">${named(m.displayName, m.handle)}${notes ? html`<span class="m">${notes}</span>` : ''}</div>
        ${circle.role === 'owner' && m.id !== userId ? html`<div class="acts">${button(`/ui/circles/${circle.id}/members/${m.id}/remove`, copy.circle.remove, csrf, 'link')}</div>` : ''}
      </div>
      ${list(circle.members.filter((child) => child.invitedBy === m.id && !shown.has(child.id)))}
    </li>`;
  }
  const roots = list(circle.members.filter((m) => !m.invitedBy || !ids.has(m.invitedBy)));
  const unreached: unknown[] = [];
  for (const m of circle.members) if (!shown.has(m.id)) unreached.push(item(m));
  return html`${roots}${unreached.length ? html`<ul class="list">${unreached}</ul>` : ''}`;
}

/**
 * A public circle's join link: members see it while it is on, the owner can turn it off. Only the relay's
 * operator turns one on (`klatsch circle public`), since that makes a circle public for good.
 */
function joinLink(circle: CircleView, base: string, csrf: string) {
  const t = copy.commons;
  const owner = circle.role === 'owner';
  if (!circle.public || (!circle.joinToken && !owner)) return '';
  return html`<div class="sec">
    <h2>${t.linkHeading}</h2>
    <div class="group">
      <div class="row">
        <div class="main">
          ${circle.joinToken ? html`<code class="cmd">${base}/join/${circle.joinToken}</code><span class="m">${t.linkOn(circle.joinCap)}</span>` : html`<span class="m">${t.linkOffPublic}</span>`}
        </div>
        ${owner && circle.joinToken ? button(`/ui/circles/${circle.id}/public`, t.turnOff, csrf) : ''}
      </div>
    </div>
  </div>`;
}

/** When a message was written: the time today, else the day. */
function when(at: number): string {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toISOString().slice(11, 16) + ' UTC' : d.toISOString().slice(0, 10);
}


/** A time in a chat list: the hour today, the day this week, else the date. */
function shortWhen(at: number): string {
  const d = new Date(at);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toISOString().slice(11, 16);
  if (now.getTime() - at < 6 * DAY_MS) return d.toUTCString().slice(0, 3);
  return d.toISOString().slice(0, 10);
}

/**
 * The left side of the messenger: the sign, "add a friend", a menu for the other pages, and the chats, newest
 * first. A friend's waiting question shows as the chat's last line.
 */
function chatSide(conversations: ConversationSummary[], asks: AskView[], csrf: string, current?: string, theme = 'auto') {
  const t = copy.chat;
  const nav = copy.layout.nav;
  const asking = new Map(asks.filter((k) => k.role === 'helper' && k.state === 'open').map((k) => [k.other.handle, k.question]));
  return html`<div class="head">
      <a class="lockup" href="/ui"><span class="cup" aria-hidden="true">${CUP_MARK}</span>${copy.layout.brand}</a>
      <form method="post" action="/ui/friends/invite"><input type="hidden" name="csrf" value="${csrf}" /><button class="iconbtn" aria-label="${copy.circle.addFriend}" title="${copy.circle.addFriend}">＋</button></form>
      <details class="menu"><summary aria-label="${t.menu}" title="${t.menu}">⋯</summary>
        <nav aria-label="${nav.label}"><a href="/ui/notes">${nav.notes}</a><a href="/ui/circle">${nav.circle}</a><a href="/ui/tokens">${nav.tokens}</a><a href="/ui/settings">${nav.settings}</a><a href="/ui/starred">${copy.chat.starred}</a><a href="/ui/device">${copy.chat.enterCode}</a>
          <form class="theme" method="post" action="/ui/theme" aria-label="${t.theme}"><input type="hidden" name="csrf" value="${csrf}" />${(['light', 'dark', 'auto'] as const).map(
            (v) => html`<button name="theme" value="${v}"${theme === v ? html` aria-pressed="true"` : ''} title="${t.themes[v]}" aria-label="${t.themes[v]}">${t.themeIcons[v]}</button>`,
          )}</form>
          <form method="post" action="/ui/logout"><input type="hidden" name="csrf" value="${csrf}" /><button>${copy.dashboard.signOut}</button></form></nav>
      </details>
    </div>
    ${conversations.length
      ? html`<ul class="chats">${conversations.map((x) => {
          const ask = asking.get(x.other.handle);
          const last = ask ? `${t.asksYou} ${ask}` : x.last ? (x.last.deleted ? t.deleted : `${x.last.mine ? `${t.you}: ` : ''}${x.last.text}`) : `@${x.other.handle}`;
          const fresh = x.unread > 0 || Boolean(ask);
          return html`<li><a class="row${fresh ? ' new' : ''}" href="/ui/chat/${encodeURIComponent(x.other.handle)}"${current === x.other.handle ? html` aria-current="page"` : ''}>
            ${avatar(x.other.name, { blue: true })}
            <span class="who"><span class="l1"><span class="name">${x.other.name}</span>${x.last ? html`<time>${shortWhen(x.last.at)}</time>` : ''}</span>
              <span class="l2"><span class="last">${last}</span>${x.unread ? html`<span class="badge" aria-label="${t.unread(x.unread)}">${x.unread}</span>` : ''}</span></span>
          </a></li>`;
        })}</ul>`
      : html`<p class="empty">${t.noChats}</p>`}`;
}

/**
 * A direct question between the two, in their conversation: the friend's waiting question with the answer box (and
 * "Brew a reply" folded below it), or the person's own question waiting for an answer.
 */
function askBubble(k: AskView, csrf: string) {
  const a = copy.asks;
  // Answered: the question and its answer as two bubbles, each on its own side, with what came of it.
  if (k.state === 'answered') {
    const mineAsked = k.role === 'asker';
    return html`<li class="msg ask${mineAsked ? ' mine' : ''}"><span class="m">${mineAsked ? a.fromYou(k.other.name) : a.toYou(k.other.name)}</span><p>${k.question}</p></li>
      <li class="msg ask${mineAsked ? '' : ' mine'}"><span class="m">${mineAsked ? a.answerLabel : a.youAnswered}</span><p>${k.answer ?? ''}</p>${mineAsked ? html`<span class="m">${a.answerSent}</span>` : ''}</li>`;
  }
  if (k.role === 'asker') return html`<li class="msg mine ask"><span class="m">${a.waiting}</span><p>${k.question}</p></li>`;
  // The answer is written in the bar below, like a reply in a messenger; the bubble keeps the question and the ways out.
  return html`<li class="msg ask">
    <span class="m">${a.toYou(k.other.name)}</span>
    <p>${k.question}</p>
    <div class="askacts">${button(`/ui/asks/${k.id}/decline`, a.decline, csrf, 'link')}
      <details class="chatmore"><summary>${copy.chat.draftMore}</summary>${howForm(`/ui/asks/${k.id}/send`, a.draft, a.how, a.howPlaceholder, csrf, 'answer')}</details></div>
  </li>`;
}

/**
 * A message's own menu (⌄): star or unstar, pin or unpin, and delete, which opens to its two choices (so one click
 * deletes nothing): for me, and for everyone on the sender's own messages within two days.
 */
function msgMenu(m: ConversationView['messages'][number], csrf: string) {
  const t = copy.chat;
  const act = (action: string, label: string) =>
    html`<form method="post" action="/ui/messages/${m.id}/${action}"><input type="hidden" name="csrf" value="${csrf}" /><button>${label}</button></form>`;
  const forAll = m.mine && !m.deleted && Date.now() - m.at < 2 * DAY_MS;
  return html`<details class="msgmenu"><summary aria-label="${t.options}" title="${t.options}">⌄</summary><div class="pop">
    ${m.deleted ? '' : html`${act(m.starred ? 'unstar' : 'star', m.starred ? t.unstar : t.star)}${act(m.pinned ? 'unpin' : 'pin', m.pinned ? t.unpin : t.pin)}`}
    <details class="del"><summary>${t.del}</summary>${act('hide', t.delForMe)}${forAll ? act('delete', t.delForAll) : ''}</details>
  </div></details>`;
}

/** The open conversation on the right: who, the messages (the newest at the bottom), and the bar to write in. */
function chatPane(view: ConversationView, csrf: string, files = true, asks: AskView[] = []) {
  const t = copy.chat;
  // The friend's waiting question, if any: the bar below answers it until it is answered or declined.
  const answering = asks.find((k) => k.role === 'helper' && k.state === 'open');
  const handle = encodeURIComponent(view.other.handle);
  return html`<header class="chathead">
      <a class="iconbtn back" href="/ui" aria-label="${t.back}">‹</a>
      ${avatar(view.other.name, { blue: true })}
      <div class="who"><h1>${view.other.name}</h1><span>@${view.other.handle}</span></div>
    </header>
    ${view.pinned && !view.pinned.deleted ? html`<a class="pinbar" href="#m-${view.pinned.id}"><span>📌 ${t.pinnedLabel}</span><q>${view.pinned.text}</q></a>` : ''}
    <div class="stream">
      ${view.messages.length
        ? html`<ol class="thread" aria-label="${t.heading}">
            ${view.messages.map(
              (m) => html`<li class="msg${m.mine ? ' mine' : ''}${m.deleted ? ' gone' : ''}" id="m-${m.id}">
                ${msgMenu(m, csrf)}
                <p>${m.deleted ? t.deleted : m.text}</p>
                ${m.files.length
                  ? html`<span class="files">${m.files.map((f) =>
                      f.mime.startsWith('audio/')
                        ? html`<audio controls preload="metadata" src="/ui/attachments/${f.id}" aria-label="${f.name}"></audio>`
                        : html`<a href="/ui/attachments/${f.id}">📎 ${f.name}</a> `,
                    )}</span>`
                  : ''}
                <time datetime="${new Date(m.at).toISOString()}">${m.pinned ? '📌 ' : ''}${m.starred ? '⭐ ' : ''}${shortWhen(m.at)}</time>
              </li>`,
            )}
            ${asks.map((k) => askBubble(k, csrf))}
          </ol>`
        : asks.length
          ? html`<ol class="thread" aria-label="${t.heading}">${asks.map((k) => askBubble(k, csrf))}</ol>`
          : html`<p class="hint">${t.empty(view.other.name)}</p>`}
    </div>
    ${view.messages.some((m) => !m.mine)
      ? html`<details class="chatmore"><summary>${t.draftMore}</summary>${howForm(`/ui/chat/${handle}/agent`, t.toAgent, t.how, t.howPlaceholder, csrf)}<p>${t.toAgentNote}</p></details>`
      : ''}
    ${files && !answering ? html`<p class="recstatus" data-record-status aria-live="polite"></p>` : ''}
    ${answering ? html`<div class="replyto"><span>↩ ${t.answering(view.other.name)}</span><q>${answering.question}</q><small>${copy.asks.answerGoes(view.other.handle)}</small></div>` : ''}
    <form id="end" class="typebar" method="post" action="${answering ? `/ui/asks/${answering.id}/answer` : `/ui/chat/${handle}`}" enctype="multipart/form-data">
      <input type="hidden" name="csrf" value="${csrf}" />
      ${answering ? html`<input type="hidden" name="back" value="/ui/chat/${handle}" />` : ''}
      ${files
        ? html`<label class="attach" title="${t.attach}">📎<input id="file" type="file" name="file" multiple aria-label="${t.attachLabel}" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,audio/*,.m4a,.mp3,.ogg,.wav,.webm" /></label>`
        : ''}
      ${answering
        ? html`<textarea id="text" name="answer" maxlength="500" required rows="1" placeholder="${copy.asks.yourAnswer}" aria-label="${copy.asks.yourAnswer}"></textarea>`
        : html`<textarea id="text" name="text" maxlength="2000" required rows="1" placeholder="${t.typeHere}" aria-label="${t.write}"></textarea>`}
      ${files && !answering
        ? html`<button type="button" class="mic" data-record data-action="/ui/chat/${handle}" data-csrf="${csrf}"
            data-hint="${t.recordHint}" data-recording="${t.recording}" data-locked="${t.recordLocked}" data-sending="${t.recordSending}" data-cancelled="${t.recordCancelled}"
            data-denied="${t.recordDenied}" data-failed="${t.recordFailed}" data-too-long="${t.recordTooLong}" aria-label="${t.record}" title="${t.record}">🎤</button>`
        : ''}
      ${files && !answering ? html`<button type="button" class="iconbtn reccancel" data-record-cancel hidden aria-label="${t.recordCancel}" title="${t.recordCancel}">✕</button>` : ''}
      <button class="primary send" aria-label="${answering ? copy.asks.sendAnswer : t.send}">➤</button>
    </form><script src="/ui/record.js" defer></script>`;
}


function circlePage(userId: string, allCircles: CircleView[], base: string, csrf: string) {
  const t = copy.circle;
  const friends = allCircles.filter((c) => c.pair);
  const circles = allCircles.filter((c) => !c.pair);
  return html`<div class="ph"><h1>${t.title}</h1><div class="end">${button('/ui/friends/invite', t.addFriend, csrf, 'primary')}</div></div>
    ${allCircles.length ? '' : html`<p class="hint">${t.none}</p>`}
    ${friends.length
      ? html`<section class="sec">
          <h2>${t.friendsHeading}</h2>
          <ul class="list">${friends.map((f) => {
            const other = f.members.find((m) => m.id !== userId);
            return html`<li class="item">
              ${avatar(other?.displayName ?? '?', { blue: true })}
              <div class="main">${other ? html`<span class="t">${other.displayName} <span class="m">@${other.handle}</span></span>` : html`<span class="m">${t.friendWaiting}</span>`}</div>
              <div class="acts">${other ? html`<a class="btn quiet" href="/ui/chat/${encodeURIComponent(other.handle)}">${t.message}</a>` : ''}${button(`/ui/friends/${f.id}/end`, t.endFriendship, csrf, 'link')}</div>
            </li>`;
          })}</ul>
          <p class="hint">${t.friendsNote}</p>
        </section>`
      : ''}
    ${circles.map((circle) => {
      // In a public circle only its owner sees everyone; a member sees the owner, themselves and a count.
      const others = circle.people - circle.members.length;
      return html`<section class="sec">
        <div class="ph">
          <h2 class="big">${circle.name} <span>${t.people(circle.people)}</span>${circle.public ? html` <span class="pill">${copy.commons.tag}</span>` : ''}</h2>
          ${circle.role === 'owner' || !circle.public ? html`<div class="end">${button(`/ui/circles/${circle.id}/invites`, t.invite, csrf, 'primary')}</div>` : ''}
        </div>
        ${circle.public ? html`<p class="hint">${copy.commons.hint}</p>` : ''}
        ${joinLink(circle, base, csrf)}
        <div class="sec">${memberTree(userId, circle, csrf)}
          ${others > 0
            ? html`<div class="item">${avatar('?')}<div class="main"><span class="t">${copy.commons.others(others)}</span><span class="m">${copy.commons.othersNote}</span></div></div>`
            : ''}
        </div>
      </section>`;
    })}`;
}

/** What the file pickers offer; the relay still reads each file's type from its bytes. */
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,audio/*,.m4a,.mp3,.ogg,.wav,.webm';
const kb = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** Why a notification the push service took may still not show: the device settings to look at. */
function pushChecks() {
  const t = copy.push;
  return html`<p class="sub">${t.testMissing}</p><ul class="sub">${t.checks.map((line) => html`<li>${line}</li>`)}</ul>`;
}

/** Notifications on this phone or browser (Web Push). The button shows only where the script finds push support. */
function pushSettings(push: { devices: number; key: string }, csrf: string) {
  const t = copy.push;
  return html`<section class="sec" id="notifications">
      <h2>${t.heading}</h2>
      <div class="group">
        <div class="row">
          <div class="main"><span>${t.line}</span><span class="m">${t.devices(push.devices)}</span></div>
          <button type="button" class="primary" data-push data-key="${push.key}" data-csrf="${csrf}" data-here="${t.here}" data-other="${t.other}" data-failed="${t.failed}" data-denied="${t.denied}" data-unsupported="${t.unsupported}" hidden>${t.turnOn}</button>
          <button type="button" data-push-off hidden>${t.turnOffHere}</button>
          ${push.devices ? button('/ui/push/off', t.turnOff, csrf, 'link') : ''}
        </div>
        ${push.devices ? html`<div class="row"><div class="main"><span>${t.testLine}</span></div>${button('/ui/push/test', t.test, csrf)}</div>` : ''}
      </div>
      <p id="push-status" class="hint" role="status" hidden></p>
      <p class="hint">${t.iphone}</p>
      <script src="/ui/push.js" defer></script>
    </section>`;
}

/** The client picker's entries: `copilot` stands for both Copilot clients, which connect differently. */
type Pick = keyof typeof copy.tokens.pick;

/** The `klatsch connect` command(s) for the picked client, made by `command` for a client name; two for Copilot. */
function connectCommands(client: Pick, command: (name: string) => string) {
  const t = copy.tokens;
  if (client !== 'copilot') return html`<code class="cmd">${command(client)}</code>`;
  return html`<p class="hint">${t.copilotVscode}</p><code class="cmd">${command('copilot-vscode')}</code>
    <p class="hint">${t.copilotCli}</p><code class="cmd">${command('copilot-cli')}</code>`;
}

/** Hosted, connect reads the token from stdin; locally it makes its own, for the person named. */
const hostedCommand = (url: string) => (name: string) => connectCommand(url, name);
const localCommand = (handle: string) => (name: string) => `npx klatsch connect --user ${handle} --client ${name}`;

function tokensPage(tokens: TokenListing[], client: Pick, setup: { hosted: boolean; url: string; handle: string }, csrf: string) {
  const t = copy.tokens;
  const now = Date.now();
  const live = (token: TokenListing) => token.revoked_at === null && token.expires_at > now;
  const picker = html`<nav class="seg" aria-label="${t.pickerLabel}">${(Object.keys(t.pick) as Pick[]).map(
    (name) => html`<a href="/ui/tokens?client=${name}"${name === client ? html` aria-current="true"` : ''}>${t.pick[name]}</a>`,
  )}</nav>`;
  return html`<div class="ph">
      <h1>${t.heading} <span>${t.connectedCount(tokens.filter(live).length)}</span></h1>
      <form class="end" method="post" action="/ui/tokens">
        <input type="hidden" name="csrf" value="${csrf}" /><input type="hidden" name="client" value="${client}" />
        <button class="primary lg">${t.connect}</button>
      </form>
    </div>
    <p class="hint">${t.note}</p>
    <div class="split">
      <section class="sec">
        <h2>${t.setupHeading}</h2>
        ${picker}
        <p class="hint">${setup.hosted ? t.setupHosted : t.setupLocal}</p>
        ${connectCommands(client, setup.hosted ? hostedCommand(setup.url) : localCommand(setup.handle))}
        ${setup.hosted ? html`<p class="hint">${t.setupBrowser(`npx klatsch connect --url ${setup.url}`)}</p>` : ''}
      </section>
      <section class="sec">
        <h2>${t.listHeading}</h2>
        ${tokens.length
          ? html`<ul class="list">
              ${tokens.map((token) => {
                const state = token.revoked_at !== null ? t.revoked : live(token) ? t.live : t.expired;
                const clients = token.clients.filter((name) => Object.hasOwn(t.clientNames, name)).map((name) => t.clientNames[name]);
                return html`<li class="item">
                  <span class="dot${live(token) ? ' live' : ''}" aria-hidden="true"></span>
                  <div class="main">
                    <span><span class="t">${token.name ?? t.fallbackLabel}</span> <span class="m">${state}</span></span>
                    ${clients.length ? html`<span class="m">${clients.join(', ')}</span>` : ''}
                    <span class="m">${t.dates(day(token.created_at), day(token.expires_at))}</span>
                  </div>
                  ${live(token) ? html`<div class="acts">${button(`/ui/tokens/${token.id}/revoke`, t.revoke, csrf, 'link')}</div>` : ''}
                </li>`;
              })}
            </ul>`
          : html`<p class="hint">${t.none}</p>`}
      </section>
    </div>`;
}

/** One list of standing grants a person gave, each with its own Revoke. */
function grantList(heading: string, grants: GrantView[], csrf: string) {
  const t = copy.consent;
  return html`<section class="sec">
    <h2>${heading}</h2>
    <div class="group">
      ${grants.length
        ? grants.map(
            (g) => html`<div class="row">
              ${avatar(g.displayName)}
              <div class="main">
                <span>${t.who(g.displayName, g.handle)}</span>
                <span class="m">${g.kind === 'show' ? `${t.onTags(g.tags, g.circle)} · ` : ''}${t.since(day(g.createdAt))}</span>
              </div>
              ${button(`/ui/grants/${g.id}/revoke`, t.revoke, csrf)}
            </div>`,
          )
        : html`<div class="row"><span class="m">${t.none}</span></div>`}
    </div>
  </section>`;
}

/** The person's own thanks counts and the opt-in badge: its link and a Markdown line while it is on. */
function thanksSettings(helped: Helped, agentThanks: boolean, csrf: string) {
  const t = copy.thanks;
  const on = helped.badge !== undefined;
  return html`<section class="sec" id="thanks">
    <h2>${t.heading}</h2>
    <div class="group">
      <div class="row"><div class="main"><span>${t.total(helped.total)}</span><span class="m">${t.month(helped.month)}</span></div></div>
      <div class="row">
        <div class="main"><span>${t.agentSwitch}</span><span class="m">${agentThanks ? t.agentOn(AGENT_THANKS_PER_DAY) : t.agentOff}</span></div>
        <form method="post" action="/ui/settings/agent-thanks">
          <input type="hidden" name="csrf" value="${csrf}" />
          <input type="hidden" name="on" value="${agentThanks ? '0' : '1'}" />
          <button class="switch" role="switch" aria-checked="${agentThanks ? 'true' : 'false'}" aria-label="${t.agentSwitch}"></button>
        </form>
      </div>
      <div class="row">
        <div class="main">
          <span>${t.badge}</span><span class="m">${on ? t.badgeOn : t.badgeOff}</span>
          ${on
            ? html`<span class="m">${t.badgeUrl}</span><code class="cmd">${helped.badge}</code>
                <span class="m">${t.badgeMarkdown}</span><code class="cmd">[![${t.badgeAlt}](${helped.badge})](${helped.home})</code>`
            : ''}
        </div>
        <form method="post" action="/ui/settings/badge">
          <input type="hidden" name="csrf" value="${csrf}" />
          <input type="hidden" name="on" value="${on ? '0' : '1'}" />
          <button class="switch" role="switch" aria-checked="${on ? 'true' : 'false'}" aria-label="${t.badge}"></button>
        </form>
      </div>
    </div>
  </section>`;
}

/** The same steps for a Google sign-in. */
type GoogleStep =
  | { kind: 'attempt'; state: string; verifier: string; nonce: string; linkTo?: string }
  | { kind: 'link'; identity: GoogleIdentity; userId: string }
  | { kind: 'join'; identity: GoogleIdentity; csrf: string; target: JoinTarget; tries: number };

/** What Settings shows of thanks: the counts, the badge's link while it is on, and the relay's address for the Markdown link. */
type Helped = { month: number; total: number; badge: string | undefined; home: string };

function settingsPage(user: UserRow, elsewhere: number, passkeys: { list: PasskeyView[]; here: boolean }, canMail: boolean, gitHub: boolean, canGoogle: boolean, grants: GrantView[], helped: Helped, csrf: string, push: { devices: number; key: string }) {
  const linked = user.github_id !== null;
  const t = copy.settings;
  return html`<div class="ph"><h1>${t.title}</h1></div>
    <section class="sec">
      <h2>${t.account}</h2>
      <div class="group">
        <div class="row">
          ${avatar(user.display_name)}
          <div class="main"><span class="t">${user.display_name}</span><span class="m">${t.handle(user.handle)}</span></div>
          ${button('/ui/logout', copy.dashboard.signOut, csrf, 'link')}
        </div>
        ${gitHub || linked
          ? html`<div class="row">
              <div class="main"><span>${t.github}</span><span class="m">${linked ? t.githubLinked(user.github_login ?? '') : t.githubNotLinked}</span></div>
              ${linked ? button('/ui/settings/github/disconnect', t.githubUnlink, csrf) : button(`${GITHUB_PATH}/connect`, t.githubLink, csrf)}
            </div>`
          : ''}
        ${canGoogle || user.google_sub !== null
          ? html`<div class="row">
              <div class="main"><span>${t.google}</span><span class="m">${user.google_sub !== null ? t.googleLinked(user.google_email ?? '') : t.googleNotLinked}</span></div>
              ${user.google_sub !== null ? button('/ui/settings/google/disconnect', t.githubUnlink, csrf) : button(`${GOOGLE_PATH}/connect`, t.googleLink, csrf)}
            </div>`
          : ''}
        <div class="row">
          <div class="main"><span>${t.sessions}</span><span class="m">${t.sessionsLine(elsewhere)}</span></div>
          ${elsewhere ? button('/ui/settings/sessions/end-others', t.endOthers, csrf) : ''}
        </div>
      </div>
    </section>
    ${pushSettings(push, csrf)}
    ${passkeys.here || passkeys.list.length ? passkeySettings(passkeys.list, passkeys.here, csrf) : ''}
    <p class="hint">${copy.consent.heading}: ${copy.consent.hint}</p>
    ${grantList(copy.consent.showHeading, grants.filter((g) => g.kind === 'show'), csrf)}
    ${grantList(copy.consent.deliverHeading, grants.filter((g) => g.kind === 'deliver'), csrf)}
    ${thanksSettings(helped, Boolean(user.agent_thanks), csrf)}
    ${canMail ? emailSettings(user, csrf) : ''}
    <section class="sec" id="delete">
      <h2>${t.deleteHeading}</h2>
      <div class="group">
        <div class="row">
          <div class="main"><span>${t.deleteHeading}</span><span class="m">${t.deleteLine}</span></div>
          <a class="button" href="/ui/settings/delete">${t.deleteOpen}</a>
        </div>
      </div>
    </section>`;
}

/** Home's offer of notifications on this device: the same button and script as Settings, with "Not now". */
function pushOfferBox(key: string, csrf: string) {
  const t = copy.push;
  return html`<section class="offer" aria-labelledby="push-offer-title">
      <div class="main"><h2 id="push-offer-title">${t.offerTitle}</h2><p>${t.offerLine}</p><p id="push-status" class="m" role="status" hidden></p></div>
      <div class="acts">
        <button type="button" class="primary" data-push data-key="${key}" data-csrf="${csrf}" data-here="${t.here}" data-other="${t.other}" data-failed="${t.failed}" data-denied="${t.denied}" data-unsupported="${t.unsupported}" hidden>${t.turnOn}</button>
        ${button('/ui/push/offer/dismiss', t.offerLater, csrf, 'link')}
      </div>
    </section>
    <script src="/ui/push.js" defer></script>`;
}

/** Home's one-time offer to save a passkey; hidden until the script finds the browser can make one. */
function passkeyOffer(csrf: string, auto: boolean) {
  const t = copy.passkeys;
  return html`<section class="offer" data-passkey-box data-passkey-offer${auto ? html` data-passkey-auto="1"` : ''} hidden aria-labelledby="offer-title">
      <div class="main"><h2 id="offer-title">${t.offerTitle}</h2><p>${t.offerLine}</p></div>
      <div class="acts">
        <button type="button" class="primary" data-passkey="add" data-back="home" data-csrf="${csrf}">${t.offerSave}</button>
        ${button('/ui/passkeys/offer/dismiss', t.offerLater, csrf, 'link')}
      </div>
    </section>
    ${passkeyScript()}`;
}

/** The person's passkeys, each removable; adding one needs the script, so only where passkeys work. */
function passkeySettings(list: PasskeyView[], here: boolean, csrf: string) {
  const t = copy.passkeys;
  return html`<section class="sec" id="passkeys">
    <h2>${t.heading}</h2>
    <div class="group">
      <div class="row">
        <div class="main"><span>${t.lead}</span><span class="m">${list.length ? '' : t.none}${here ? '' : ` ${t.elsewhere}`}</span></div>
        ${here ? html`<span data-passkey-box hidden><button type="button" data-passkey="add" data-csrf="${csrf}">${t.add}</button></span>` : ''}
      </div>
      ${list.map(
        (passkey) => html`<div class="row">
          <div class="main"><span>${passkey.synced ? t.synced : t.device}</span><span class="m">${t.used(day(passkey.createdAt), passkey.lastUsedAt ? day(passkey.lastUsedAt) : undefined)}</span></div>
          ${button(`/ui/passkeys/${passkey.id}/delete`, t.remove, csrf)}
        </div>`,
      )}
    </div>
    ${here ? passkeyScript() : ''}
  </section>`;
}

/** Shown only when the relay can send mail: without SMTP a switch that is on would deliver nothing. */
function emailSettings(user: UserRow, csrf: string) {
  const t = copy.email;
  const on = Boolean(user.notify_email);
  return html`<section class="sec">
      <h2>${t.heading}</h2>
      <div class="group">
        <div class="row">
          <div class="main"><span>${t.heading}</span><span class="m">${t.state(on, Boolean(user.email))}</span></div>
          <form method="post" action="/ui/notifications/email">
            <input type="hidden" name="csrf" value="${csrf}" />
            <input type="hidden" name="on" value="${on ? '0' : '1'}" />
            <button class="switch" role="switch" aria-checked="${on ? 'true' : 'false'}" aria-label="${t.heading}"></button>
          </form>
        </div>
        <div class="row">
          <div class="main">
            <form class="field" method="post" action="/ui/email">
              <input type="hidden" name="csrf" value="${csrf}" />
              <input type="email" name="email" value="${user.email ?? ''}" maxlength="254" placeholder="${t.placeholder}" aria-label="${t.addressLabel}" />
              <button class="primary">${t.save}</button>
            </form>
            ${user.email ? emailState(user) : ''}
          </div>
        </div>
      </div>
      <p class="hint">${t.removeNote}</p>
    </section>`;
}

/**
 * "Send once", the receiver's "always" and "Thanks" for one note; the explanation is said once for the whole
 * section. `thanks`: whether the person may thank here, and whether they did.
 */
function sendButtons(path: string, handle: string, sends: boolean, thanks: { can: boolean; done: boolean }, csrf: string) {
  return html`<div class="acts">${button(`${path}/send`, copy.handoff.send, csrf)}${sends ? '' : button(`${path}/send-always`, copy.consent.sendAlways(handle), csrf)}${thanks.can
    ? thanksButton(path, thanks.done, csrf)
    : ''}</div>`;
}

/** "Thanks" until the person clicked it, then a quiet "Thanked" that does nothing. */
function notesPage(notes: NoteView[], csrf: string) {
  const t = copy.notesPage;
  const d = copy.dashboard;
  return html`<div class="ph"><h1>${t.heading}</h1></div>
    <p class="hint">${t.sub}</p>
    <section class="sec">
      ${notes.length
        ? html`<ul class="list">
            ${notes.map(
              (n) => html`<li class="item">
                ${avatar(n.displayName)}
                <div class="main">
                  ${named(n.displayName, n.handle)}
                  <span>“${n.summary}”</span>
                  ${n.tried ? html`<span class="pill warn">${d.didNotWork}</span>` : ''}
                  ${n.source ? sourceLine(n.source) : ''}
                  <span class="m">${n.tags.join(', ')} · ${n.circle} · ${d.asOf(day(n.asOf))}</span>
                </div>
                <div class="acts">${button(`/ui/notes/${n.sipId}/send`, copy.handoff.send, csrf)}${thanksButton(`/ui/notes/${n.sipId}`, n.thanked, csrf)}</div>
              </li>`,
            )}
          </ul>
          ${notes.some((n) => n.source) ? html`<p class="hint">${copy.source.hint}</p>` : ''}
          ${notes.length >= 100 ? html`<p class="hint">${t.newest}</p>` : ''}`
        : html`<p class="hint">${t.none}</p>`}
    </section>`;
}

function thanksButton(path: string, done: boolean, csrf: string, long = false) {
  const t = copy.thanks;
  if (done) return html`<span class="thanked">${heart()}${t.thanked}</span>`;
  return html`<form method="post" action="${path}/thanks"><input type="hidden" name="csrf" value="${csrf}" /><button class="thanks">${heart()}${long ? t.thankLong : t.thank}</button></form>`;
}

function dashboard(
  user: UserRow,
  sips: (SipRow & { tags: string[] })[],
  intros: IntroView[],
  notes: NoteView[],
  helped: { month: number; total: number; byAgent: AgentThanksView[] },
  circles: SharingCircle[],
  hours: number,
  asks: AskView[],
  csrf: string,
  friends = 0,
  conversations: ConversationSummary[] = [],
  /** False for a guest, who sends no files: no file fields with questions or answers. */
  files = true,
) {
  const t = copy.dashboard;
  const shownStatus = (s: SipRow) => (s.failed ? 'tried' : s.status);
  const asOf = (s: SipRow) => s.checked_at ?? s.approved_at ?? s.created_at;
  /** A note the author has not looked at for a while: Home asks whether it still holds, with no message or wake. */
  const isOld = (s: SipRow) => s.status === 'solved' && asOf(s) < Date.now() - NOTE_CHECK_DAYS * DAY_MS;
  const drafts = sips.filter((s) => s.state === 'draft');
  const approved = sips.filter((s) => s.state === 'approved');
  const waiting = intros.filter((i) => i.state === 'awaiting-solver' && i.role === 'solver');
  const accepted = intros.filter((i) => i.state === 'accepted');
  // A question waiting for an answer needs the person too.
  const unread = conversations.reduce((n, x) => n + x.unread, 0);
  const needs = waiting.length + drafts.length + asks.filter((k) => k.role === 'helper' && k.state === 'open').length + unread;
  // Notes, intros and cards are the coding side: shown to someone who uses it, not to someone who only asks friends.
  const notesUser = sips.length > 0 || intros.length > 0 || notes.length > 0;
  const askedMe = asks.filter((k) => k.role === 'helper' && k.state === 'open').length;
  const chip = (count: number, label: string, hot = false) => html`<li${hot && count ? html` class="hot"` : ''}><b>${count}</b> ${label}</li>`;
  const status = (s: SipRow & { tags: string[] }) =>
    html`<span class="m">${shownStatus(s)} · ${s.tags.join(', ')}${s.status === 'solved'
        ? html` <span class="pill${s.visibility === 'open' ? ' open' : ''}">${s.visibility === 'open' ? copy.consent.openTag : copy.consent.askTag}</span>${s.in_feed ? html` <span class="pill open">${copy.notesPage.onPage}</span>` : ''}`
        : ''}</span>`;
  const dot = (s: SipRow) => html`<span class="dot ${shownStatus(s)}" aria-hidden="true"></span>`;
  const linkCard = (s: SipRow) => {
    const source = sourceOfRow(s);
    return source ? sourceLine(source) : '';
  };
  const count = (heading: string, n: number) => html`<h2>${heading} <em>${n}</em></h2>`;

  const introItems = waiting.map(
    (i) => html`<li class="item">
      <span class="kind ask" aria-hidden="true">?</span>
      <div class="main">
        <span class="t">${copy.incomingIntro.heading}</span>
        <span>“${i.request?.summary ?? ''}”</span>
        <span class="m">${i.tags.join(', ')}${i.request?.circle ? ` · ${i.request.circle}` : ''}</span>
      </div>
      <div class="acts">${button(`/ui/intros/${i.id}/decline`, copy.incomingIntro.decline, csrf)}${button(`/ui/intros/${i.id}/allow-always`, copy.consent.allowAlways, csrf)}${button(`/ui/intros/${i.id}/approve`, copy.incomingIntro.accept, csrf, 'primary')}</div>
    </li>`,
  );
  const draftItems = drafts.map((s) => {
    const form = `share-${s.id}`;
    return html`<li class="item">
      <span class="kind draft" aria-hidden="true">✎</span>
      <div class="main">
        <span class="t">${t.draftTitle}</span>
        <span>${s.summary}</span>
        ${linkCard(s)}
        <span class="m">${shownStatus(s)} · ${s.tags.join(', ')}</span>
        ${flagList(JSON.parse(s.flags) as Flag[])} ${s.status === 'solved' ? visibilityChoice(s.visibility, form, s.failed === 1) : ''}${matchInChoice(circles, s.status, form)}
      </div>
      <div class="acts">
        ${button(`/ui/sips/${s.id}/reject`, t.notNow, csrf)}
        <form id="${form}" method="post" action="/ui/sips/${s.id}/approve"><input type="hidden" name="csrf" value="${csrf}" /><button class="primary">${t.share}</button></form>
      </div>
    </li>`;
  });

  const connected = (i: IntroView) => {
    const other = i.other;
    const readable = Boolean(other?.shared && other.summary);
    const state = !other ? '' : readable ? copy.handoff.visibleUntil(until(other.visibleUntil)) : copy.handoff.noLongerShared(other.handle);
    return html`<li class="conn">
      <div class="who">
        ${avatar(other?.displayName ?? '?', { blue: true })}
        <div class="main">${named(other?.displayName ?? '', other?.handle ?? '')}<span class="m">${i.tags.join(', ')} · ${state}</span></div>
        ${readable && other
          ? sendButtons(`/ui/intros/${i.id}`, other.handle, other.sends, { can: other.canThank, done: other.thanked }, csrf)
          : other?.canThank
            ? html`<div class="acts">${thanksButton(`/ui/intros/${i.id}`, other.thanked, csrf)}</div>`
            : ''}
      </div>
      ${readable && other ? html`<p><span class="m">${t.theirSip}</span><br />“${other.summary}”</p>${other.source ? html`<p class="main">${sourceLine(other.source)}</p>` : ''}` : ''}
      <p><span class="m">${t.yourSip}</span><br />${i.mine?.summary ?? ''}</p>
      ${readable && other?.sends ? html`<p class="m">${copy.consent.sendsAlways(other.handle)}</p>` : ''}
    </li>`;
  };

  return html`<div class="ph">
      <h1>${t.greeting(user.display_name)} <span>${t.waiting(needs)}</span></h1>
      <a class="end" href="/ui/device">${t.codeLink}</a>
    </div>
    <ul class="chips" aria-label="${t.summary}">
      ${friends ? chip(friends, t.chips.friends(friends)) : ''}${friends ? chip(unread, t.chips.unread(unread), true) : ''}${chip(askedMe, t.chips.asked(), true)}${
        notesUser
          ? html`${chip(waiting.length, t.chips.intros(waiting.length), true)}${chip(drafts.length, t.chips.drafts(drafts.length), true)}${chip(notes.length, t.chips.notes(notes.length))}${chip(approved.length, t.chips.card())}${chip(accepted.length, t.chips.connected())}`
          : ''
      }
    </ul>
    ${helped.total
      ? html`<div class="helped">
          <span class="heart" aria-hidden="true">${heart(16)}</span>
          <div class="main"><span class="t">${copy.thanks.helpedMonth(helped.month)}</span><span class="m">${copy.thanks.helpedTotal(helped.total)}</span></div>
          <a class="end" href="/ui/settings#thanks">${copy.thanks.showBadge}</a>
        </div>`
      : ''}
    ${helped.byAgent.length
      ? html`<div class="agent-thanks">
          <ul>
            ${helped.byAgent.map(
              (a) => html`<li>${heart()}<span>${copy.thanks.agentThanked(a.displayName)}</span><span class="m">${a.tags.join(', ')}</span><span class="m" aria-hidden="true">·</span>${button(`/ui/thanks/${a.id}/undo`, copy.thanks.undo, csrf, 'link')}</li>`,
            )}
          </ul>
          <p class="m">${copy.thanks.agentHint}</p>
        </div>`
      : ''}

    ${asks.length
      ? html`<section class="sec">
          ${count(copy.asks.heading, asks.length)}
          <ul class="list">
            ${asks.map(
              (k) => html`<li class="item">
                ${avatar(k.other.name, { blue: k.role === 'helper' })}
                <div class="main">
                  <span class="t">${k.role === 'helper' ? copy.asks.toYou(k.other.name) : copy.asks.fromYou(k.other.name)} <span class="m">@${k.other.handle}</span></span>
                  <span>“${k.question}”</span>
                  ${k.answer ? html`<span><span class="m">${k.role === 'helper' ? copy.asks.yourAnswerLabel : copy.asks.answerLabel}</span> “${k.answer}”</span>${k.tried ? html`<span class="pill warn">${t.didNotWork}</span>` : ''}` : ''}
                  ${k.attachments.length
                    ? html`<span class="files">${k.attachments.map((a) => html`<a href="/ui/attachments/${a.id}" target="_blank" rel="noopener">📎 ${a.name} <span class="m">${kb(a.size)}</span></a>`)}</span>`
                    : ''}
                  <span class="m">${k.tags.join(', ')}${k.role === 'asker' && k.state === 'open' ? ` · ${copy.asks.waiting}` : ''}${k.state === 'declined' ? ` · ${copy.asks.declined}` : ''}</span>
                </div>
                <div class="acts">${
                  k.role === 'helper' && k.state === 'open'
                    ? button(`/ui/asks/${k.id}/decline`, copy.asks.decline, csrf)
                    : k.role === 'helper'
                      ? html`<span class="m">${k.state === 'answered' ? copy.asks.youAnswered : copy.asks.youDeclined}</span>`
                    : k.state === 'answered'
                      ? html`<span class="m">${copy.asks.answerSent}</span>`
                      : k.state === 'open'
                        ? button(`/ui/asks/${k.id}/withdraw`, copy.asks.withdraw, csrf, 'link')
                        : ''
                }</div>
                ${files && k.role === 'asker' && k.state === 'open'
                  ? html`<form class="answer" method="post" action="/ui/asks/${k.id}/attach" enctype="multipart/form-data">
                      <input type="hidden" name="csrf" value="${csrf}" />
                      <label for="file-${k.id}" class="m">${copy.asks.attachLabel}</label>
                      <input id="file-${k.id}" type="file" name="file" multiple accept="${ACCEPT}" required />
                      <button>${copy.asks.attach}</button>
                    </form>`
                  : ''}
                ${k.role === 'helper' && k.state === 'open'
                  ? html`<form class="answer" method="post" action="/ui/asks/${k.id}/answer" enctype="multipart/form-data">
                      <input type="hidden" name="csrf" value="${csrf}" />
                      <label for="answer-${k.id}">${copy.asks.yourAnswer}</label>
                      <textarea id="answer-${k.id}" name="answer" maxlength="500" rows="3" required></textarea>
                      ${files
                        ? html`<label for="file-${k.id}" class="m">${copy.asks.attachLabel}</label>
                            <input id="file-${k.id}" type="file" name="file" multiple accept="${ACCEPT}" />`
                        : ''}
                      <p class="m">${copy.asks.answerGoes(k.other.handle)}</p>
                      <button class="primary">${copy.asks.sendAnswer}</button>
                    </form>
                    ${howForm(`/ui/asks/${k.id}/send`, copy.asks.draft, copy.asks.how, copy.asks.howPlaceholder, csrf, 'answer')}`
                  : ''}
              </li>`,
            )}
          </ul>
          <p class="hint">${copy.asks.note}</p>
        </section>`
      : ''}

    ${notesUser ? html`<section class="sec">
      ${count(t.needsHeading, needs)}
      ${needs
        ? html`<ul class="list">${introItems}${draftItems}</ul>
            ${waiting.length ? html`<p class="hint">${copy.incomingIntro.note} <strong>${copy.consent.allowAlways}:</strong> ${copy.consent.allowAlwaysNote}</p>` : ''}
            ${drafts.length ? html`<p class="hint">${t.draftsNote}</p>` : ''}`
        : html`<p class="hint">${t.needsNone}</p>`}
    </section>` : asks.length || friends ? '' : html`<section class="sec"><p class="hint">${t.friendsNone}</p></section>`}

    ${notes.length
      ? html`<section class="sec">
          <h2>${copy.consent.notesHeading} <em>${t.notesSub} · ${notes.length}</em></h2>
          <ul class="list">
            ${notes.map(
              (n) => html`<li class="item">
                ${avatar(n.displayName)}
                <div class="main">
                  ${named(n.displayName, n.handle)}
                  <span>“${n.summary}”</span>
                  ${n.tried ? html`<span class="pill warn">${t.didNotWork}</span>` : ''}
                  ${n.source ? sourceLine(n.source) : ''}
                  <span class="m">${n.tags.join(', ')} · ${n.circle} · ${t.asOf(day(n.asOf))}${n.sends ? ` · ${t.sendsAlready}` : ''}</span>
                </div>
                ${sendButtons(`/ui/notes/${n.sipId}`, n.handle, n.sends, { can: true, done: n.thanked }, csrf)}
              </li>`,
            )}
          </ul>
          ${notes.some((n) => n.source) ? html`<p class="hint">${copy.source.hint}</p>` : ''}
          <p class="hint">${copy.consent.notesHint} <strong>${copy.handoff.send}:</strong> ${copy.handoff.note} <strong>${copy.consent.sendAlwaysShort}:</strong> ${copy.consent.sendAlwaysNote} <strong>${copy.thanks.thank}:</strong> ${copy.thanks.hint}</p>
        </section>`
      : ''}

    ${notesUser ? html`<div class="split">
      <section class="sec">
        ${count(t.cardHeading, approved.length)}
        <ul class="list">
          ${approved.map(
            (s) => html`<li class="item">
              ${dot(s)}
              <div class="main"><span>${s.summary}</span>${linkCard(s)}${status(s)}${isOld(s) ? html`<span class="m">${t.stillHolds(day(asOf(s)))}</span>` : ''}</div>
              ${isOld(s) ? button(`/ui/sips/${s.id}/confirm`, t.confirm, csrf, 'link') : ''}${button(`/ui/sips/${s.id}/retire`, t.retire, csrf, 'link')}
            </li>`,
          )}
        </ul>
      </section>

      <section class="sec">
        <h2>${t.acceptedHeading} <em>${accepted.length} · ${t.acceptedSub(hours)}</em></h2>
        <ul class="list plain">${accepted.map(connected)}</ul>
      </section>
    </div>` : ''}`;
}
