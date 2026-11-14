import { pushEndpoint, pushKeyValid, type PushSubscriptionRow } from './notify/push.ts';
import { claim, setResult, type Approval } from './auth/approvals.ts';
import { claimEmailConfirmation, type EmailConfirmation } from './auth/email-confirmations.ts';
import { mailboxOf } from './auth/email-logins.ts';
import { PASSKEYS_PER_PERSON } from './auth/passkeys.ts';
import { keyedHash } from './crypto.ts';
import { claimInvite, type Invite } from './auth/invites.ts';
import { revokeTokens } from './auth/tokens.ts';
import type { Config } from './config.ts';
import { fromBlob, SEMANTIC_MAX_MATCHES, SEMANTIC_THRESHOLD, similarity, toBlob, type Embedder } from './match/semantic.ts';
import { ASK, ASK_QUOTE_NOTE, askQuoteLine, AGENT_THANKS_PER_DAY, inboxText, matchReason, NO_INTRO_NEEDED, openNote, openNoteUnnamed, pendingReminder, SEARCHES_PER_HOUR, QUOTE_NOTE, quoteLine, sentNote, THANKS, WATCH, type PendingCounts } from './copy/agent.ts';
import { consent } from './copy/consent.ts';
import { handoff, QUOTES_PER_HOUR } from './copy/handoff.ts';
import { notifications } from './copy/notifications.ts';
import { thanks } from './copy/thanks.ts';
import { newId, randomToken } from './crypto.ts';
import { detect, type Flag } from './detect/detectors.ts';
import { relatedTags, resolveTags, type UnknownTag } from './match/vocabulary.ts';
import type { UpdateCardInput } from './schema/index.ts';
import { cleanQuote, hasHiddenCharacters } from './quote.ts';
import { checkSource, clip, SOURCE_AUTHOR_MAX, SOURCE_REFUSED, SOURCE_TITLE_MAX, type Source } from './source.ts';
import { sealerFrom } from './store/sealed.ts';
import { afterCommit, sealOptional, sealText, transaction, useSealer, type Db } from './store/db.ts';
import { completeWatches, WAKES } from './watches.ts';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
/** A badge id: 128 random bits, base64url. */
const BADGE_ID = /^[\w-]{22}$/;
/** A public join link's last segment: 128 random bits (base64url), or a short name only the operator sets (3–20, never 22 long). */
const JOIN_TOKEN = /^(?:[\w-]{22}|[a-z0-9][a-z0-9-]{2,19})$/;
export const JOIN_NAME = /^[a-z0-9][a-z0-9-]{2,19}$/;

/** A summary others will read may hold nothing its approver cannot see. */
function refuseHidden(summary: string): void {
  if (hasHiddenCharacters(summary)) {
    throw new KlatschError('invalid', 'The summary contains invisible, private-use or control characters. Write it as plain visible text.');
  }
}
const MAX_MATCHES = 10;
/** The newest ones the Notes page shows. */
const FEED_NOTES = 100;
const NO_LOOKING_SIP =
  'Your human needs an approved "looking" sip on these tags first, so the other person knows what the intro is about. Share one with update_card.';
const NOT_SHARED_THERE =
  'Your human\'s looking sip on these tags is not shared in a circle where this note is, so it was not sent. To ask for this intro, share a looking sip with update_card and let your human tick that circle on the approval page.';
// One plain address: no display name, no list, nothing a mail header could be split on.
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
/** One plain `local@domain.tld` address of at most 254 characters, nothing else. */
export const isEmail = (email: string): boolean => email.length <= 254 && EMAIL.test(email);
/** A handle is an identifier, never free text: it is the one thing about a person an agent may learn (after both accepted an intro). */
export const HANDLE = /^[a-z0-9][a-z0-9-]{0,38}$/;

/** `@handle` for an agent, or nothing for a handle stored before handles were checked. */
export const agentHandle = (handle: string | undefined): string | undefined => (handle && HANDLE.test(handle) ? `@${handle}` : undefined);

export type Via = 'mcp' | 'web' | 'cli';

export type SipStatus = UpdateCardInput['status'];
/** Who reads a solved sip: the members it matches at once (`open`), or only after an intro its author allowed (`ask`). */
export type Visibility = 'open' | 'ask';
type IntroState = 'awaiting-seeker' | 'awaiting-solver' | 'accepted' | 'declined';
export type Role = 'owner' | 'member';

/**
 * A sip `s` counts for `reader` (an SQL expression) only through a circle it was shared in where its author
 * and the reader are both still members; with `openOnly`, only through one where the author opened it.
 */
const inScope = (reader: string, privateOnly = false) =>
  `EXISTS (SELECT 1 FROM sip_circles sc JOIN memberships a ON a.circle_id = sc.circle_id AND a.user_id = s.user_id
     JOIN memberships b ON b.circle_id = sc.circle_id AND b.user_id = ${reader} WHERE sc.sip_id = s.id${
       privateOnly ? ' AND NOT EXISTS (SELECT 1 FROM circles pc WHERE pc.id = sc.circle_id AND pc.public = 1)' : ''
     })`;

/**
 * A solved sip `s` and a looking sip (`looking`, an SQL expression for its id, by `seeker`) meet only in a
 * circle both were shared in, where both authors are still members. `extra` narrows that circle (`sc` is
 * the solved sip's row): `sc.open = 1` where the note is open, or the circle of an "allow always" grant.
 */
const jointScope = (looking: string, seeker: string, extra = '') =>
  `EXISTS (SELECT 1 FROM sip_circles sc JOIN sip_circles lc ON lc.circle_id = sc.circle_id AND lc.sip_id = ${looking}
     JOIN memberships a ON a.circle_id = sc.circle_id AND a.user_id = s.user_id
     JOIN memberships b ON b.circle_id = sc.circle_id AND b.user_id = ${seeker} WHERE sc.sip_id = s.id${extra})`;

/** Human notifications carry no content: no names, no tags, no summaries. */
export type Notifier = (user: { id: string; handle: string }, message: string) => void;

/** Sends the one confirmation mail for an unconfirmed address: a fixed sentence and the link, nothing else. */
export type ConfirmationMailer = (to: string, link: string) => void;

/**
 * Mail for signing in by email: `link` sends a sign-in link (a fixed subject, the link and how long it works);
 * `notice` tells an address that it was just used to sign in, with a link to Settings. Nothing else.
 */
export interface SignInMailer {
  link(to: string, link: string, code: string): void;
  notice(to: string, settings: string): void;
}

export class KlatschError extends Error {
  readonly code: 'not-found' | 'forbidden' | 'invalid' | 'unknown-tags';
  readonly unknown: UnknownTag[];

  constructor(code: KlatschError['code'], message: string, unknown: UnknownTag[] = []) {
    super(message);
    this.code = code;
    this.unknown = unknown;
  }
}

export interface SipRow {
  id: string;
  user_id: string;
  /** Legacy: the circle a sip was first shared in. What counts is its scope in `sip_circles`. */
  circle_id: string;
  status: SipStatus;
  summary: string;
  state: 'draft' | 'approved' | 'rejected' | 'retired';
  /** 1 when it shows on the Notes page of a circle; only `sipsOf` reads it. */
  in_feed?: number;
  /** 1 for a sip shared as `tried`: stored and matched as a note, marked as not a fix. */
  failed: number;
  /** When the author last said it still holds; null until then. */
  checked_at: number | null;
  visibility: Visibility;
  flags: string;
  expires_at: number | null;
  created_at: number;
  approved_at: number | null;
  source_url: string | null;
  source_title: string | null;
  source_author: string | null;
}

/** The link card of a sip row, if it has one. */
export const sourceOfRow = (row: { source_url: string | null; source_title: string | null; source_author: string | null }): Source | undefined =>
  row.source_url && row.source_title ? { url: row.source_url, title: row.source_title, ...(row.source_author ? { author: row.source_author } : {}) } : undefined;

export interface IntroView {
  id: string;
  state: IntroState;
  role: 'seeker' | 'solver';
  tags: string[];
  /** For the solver: what the seeker is stuck on, without who they are, and the circle it came through. */
  request?: { summary: string; circle?: string };
  /**
   * Filled only once both people have accepted. `summary` is the other's sip while it is `shared`: for
   * `connectedTextHours` after the acceptance (until `visibleUntil`), while the sip is still approved and
   * both are still in its circle; otherwise empty, and only the names stay. `sends`: the person chose to
   * always get the other's notes in their agent. `thanked`: the person thanked the other for this intro;
   * `canThank`: they may (both still share a circle).
   */
  other?: {
    handle: string;
    displayName: string;
    summary: string;
    shared: boolean;
    visibleUntil: number;
    userId: string;
    sipId: string | null;
    sends: boolean;
    thanked: boolean;
    canThank: boolean;
    /** The link card of their sip, while it is readable. */
    source?: Source;
  };
  mine?: { summary: string };
}

/** A circle the person shares in, for the approval page's choice of where an open note is readable. */
export interface SharingCircle {
  id: string;
  name: string;
  public: boolean;
  /** A friendship: never ticked by default, a friend is there to be asked, not to match every note. */
  pair: boolean;
  people: number;
}

/** What an approval page shows; the words are in the web UI's copy. */
export type ApprovalView =
  | {
      action: 'share_sip';
      status: SipStatus;
      tags: string[];
      summary: string;
      flags: Flag[];
      askForIntro: boolean;
      visibility: Visibility;
      source?: Source;
      circles: SharingCircle[];
    }
  | { action: 'send_intro'; tags: string[]; summary: string }
  | { action: 'answer_intro'; tags: string[]; request: string; circle?: string }
  | { action: 'ask_person'; to: { name: string; handle: string }; tags: string[]; question: string; flags: Flag[] }
  | { action: 'answer_ask'; from: { name: string; handle: string }; tags: string[]; question: string; answer: string; tried: boolean; flags: Flag[] };

/** A direct question, as the asker or the person asked sees it on their own page. */
export interface AskView {
  id: string;
  role: 'asker' | 'helper';
  other: { name: string; handle: string };
  tags: string[];
  question: string;
  answer: string | null;
  tried: boolean;
  state: 'open' | 'answered' | 'declined' | 'withdrawn';
  createdAt: number;
}

/**
 * Another member's solved note that a person may read without an intro: it matches what they look for, and
 * its author opened it to the circle or allowed this person always. For the human web UI; an agent gets
 * only the handle. `sends`: the reader chose to always get this author's notes in their agent. `thanked`:
 * the reader thanked the author for this note.
 */
export interface NoteView {
  sipId: string;
  matchId: string;
  tags: string[];
  summary: string;
  userId: string;
  handle: string;
  displayName: string;
  sends: boolean;
  thanked: boolean;
  /** The circle it reached the reader through (one they share where it is open, else where it matched). */
  circle: string;
  source?: Source;
  /** Its author tried this and it did not work: a warning, not a fix. */
  tried: boolean;
  /** When its author shared it or last said it still holds. */
  asOf: number;
}

/** A thanks the person's agent gave for them, for Home: whom it went to, and the id to undo it by. */
export interface AgentThanksView {
  id: string;
  displayName: string;
  handle: string;
  /** The thanked note's tags, so the person can tell which note it was. */
  tags: string[];
}

/** A standing permission one person gave another, for their Settings page. */
export interface GrantView {
  id: string;
  kind: 'show' | 'deliver';
  /** For `show`: the tags of the intro it was given on, and the circle it holds in. */
  tags: string[];
  circle: string | null;
  handle: string;
  displayName: string;
  createdAt: number;
}

/**
 * What a person decides on an approval page besides yes or no. `matchIn`: the circles the sip is shared in, as
 * ticked on the page; absent when the page asked nothing (then: their private circles).
 */
export interface Choice {
  visibility?: Visibility;
  always?: boolean;
  matchIn?: string[];
  /** Also on the Notes page of the private circles it is shared in. Only ever ticked by the human, on an open note. */
  feed?: boolean;
  /** The question or answer as the person edited it before sending: their words replace the agent's draft. */
  text?: string;
}

export interface UserRow {
  id: string;
  handle: string;
  display_name: string;
  email: string | null;
  email_verified_at: number | null;
  notify_email: number;
  github_id: number | null;
  github_login: string | null;
  google_sub: string | null;
  google_email: string | null;
  /** The public badge's random id while the person shows one. */
  badge_id: string | null;
  /** 1 while the person lets their agent say thanks for them (the default). */
  agent_thanks: number;
  /** When the person said "Not now" to saving a passkey on Home. */
  passkey_offer_dismissed_at: number | null;
  push_offer_dismissed_at: number | null;
}

export interface CircleView {
  id: string;
  name: string;
  role: Role;
  /** How many people are in it. */
  people: number;
  /** A public circle: anyone with its join link could join (a circle stays public once its link was on). */
  public: boolean;
  /** The public join link's last segment while it is on. */
  joinToken: string | null;
  joinCap: number | null;
  /** A friendship: a private circle of two, made by "Add a friend". */
  pair: boolean;
  /**
   * In join order; for the human web UI only. In a public circle a member sees only the owner and themselves
   * (strangers' names come only through intros and open notes); the owner sees everyone, to remove them.
   */
  members: { id: string; handle: string; displayName: string; role: Role; invitedBy: string | null }[];
}

/** How long a direct question waits, and how long a person may have so many open or send so many a day. */
const ASK_DAYS = 14;
/** An answer typed on the page: the same bound as an agent's draft. */
const ANSWER_MAX = 500;
/** A question, drafted or edited: the same bound as the tool's input. */
const QUESTION_MAX = 500;
const ASKS_OPEN = 5;
const ASKS_PER_DAY = 10;

export interface InboxEvent {
  kind: string;
  ref: string;
  text: string;
  at: string;
  /** Only on an intro both people accepted: the other person's handle. */
  with?: string;
  /** A quote the human sent to their agent: the only way another person's text reaches an agent. */
  type?: 'quote';
  from?: string;
  quote?: string;
  note?: string;
  /** The quoted note's link card, delivered with it on the same consent. */
  source?: Source;
}

export class Klatsch {
  private embedder: Embedder | undefined;
  private embedding: Promise<void> | undefined;
  readonly db: Db;
  readonly config: Config;
  /** Undefined when the relay is not configured for email: addresses then stay unconfirmed. */
  readonly mailer: ConfirmationMailer | undefined;
  /** Undefined without email too: then nobody signs in by email. */
  readonly signInMailer: SignInMailer | undefined;
  private readonly notify: Notifier;
  /** The server secret, for the keyed hashes of `mailbox_history`; set by the relay (`useSecret`). */
  private secret: Buffer | undefined;
  /** Searches per token in the last hour (one relay instance), so an agent cannot map a circle's topics quickly. */
  private readonly searches = new Map<string, number[]>();

  constructor(db: Db, config: Config, notify: Notifier, mailer?: ConfirmationMailer, signInMailer?: SignInMailer) {
    this.db = db;
    this.config = config;
    this.notify = notify;
    this.mailer = mailer;
    this.signInMailer = signInMailer;
  }

  /**
   * Gives the service the server secret, which the mailbox history is keyed with, and records the mailbox of every
   * confirmed address there (again at each start, so addresses from before the history are in it too).
   */
  useSecret(secret: Buffer): void {
    this.secret = secret;
    useSealer(this.db, sealerFrom(secret));
    const rows = this.db.prepare('SELECT id, mailbox FROM users WHERE mailbox IS NOT NULL').all() as { id: string; mailbox: string }[];
    for (const row of rows) this.rememberMailbox(row.id, row.mailbox);
  }

  /** A mailbox as the history keeps it: never in plain text, a keyed hash of its own kind. */
  private mailboxHash(mailbox: string): string {
    if (!this.secret) throw new Error('The mailbox history needs the server secret (Klatsch.useSecret).');
    return keyedHash(this.secret, `mailbox ${mailbox}`);
  }

  private rememberMailbox(userId: string, mailbox: string): void {
    this.db.prepare('INSERT OR IGNORE INTO mailbox_history (user_id, mailbox_hash) VALUES (?, ?)').run(userId, this.mailboxHash(mailbox));
  }

  // ---------- users and circles ----------

  ensureUser(handle: string, displayName: string): string {
    if (!HANDLE.test(handle)) throw new KlatschError('invalid', 'A handle is 1–39 lowercase letters, digits or hyphens, starting with a letter or digit.');
    const existing = this.db.prepare('SELECT id FROM users WHERE handle = ?').get(handle) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = newId('usr');
    this.db.prepare('INSERT INTO users (id, handle, display_name, created_at) VALUES (?, ?, ?, ?)').run(id, handle, displayName, Date.now());
    return id;
  }

  /** The person a GitHub account signs in as: found by GitHub's numeric user id only, never by login or email. */
  userByGitHub(githubId: number): string | undefined {
    return (this.db.prepare('SELECT id FROM users WHERE github_id = ?').get(githubId) as { id: string } | undefined)?.id;
  }

  /** Keeps the login shown on Settings current after a sign-in (GitHub logins can be renamed). */
  noteGitHubLogin(userId: string, login: string): void {
    this.db.prepare('UPDATE users SET github_login = ? WHERE id = ?').run(login, userId);
    this.audit(userId, 'web', 'github.signin');
  }

  /**
   * A GitHub account that is no one here yet joins a circle, by invite or by a public join link (`join`
   * accepts one or the other for the new person): the person is made only now, in the same transaction as
   * joining, so a GitHub sign-in alone creates nothing. The address, if any, is GitHub's primary verified one
   * and needs no confirmation mail. `taken` when the handle is someone else's; a GitHub account that got a
   * person meanwhile (a second tab) joins as that person. A link that is no longer valid throws, and nothing is made.
   */
  joinWithGitHub(github: { id: number; login: string; name: string; email: string | undefined }, handle: string, join: (userId: string) => unknown): string | 'taken' {
    return transaction(this.db, () => {
      let id = this.userByGitHub(github.id);
      if (!id) {
        if (!HANDLE.test(handle) || this.db.prepare('SELECT 1 FROM users WHERE handle = ?').get(handle)) return 'taken';
        id = newId('usr');
        this.db
          .prepare('INSERT INTO users (id, handle, display_name, github_id, github_login, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, handle, github.name, github.id, github.login, Date.now());
        this.audit(id, 'web', 'github.create');
        if (github.email && isEmail(github.email)) this.setVerifiedEmail(id, github.email, 'web');
      }
      join(id);
      return id;
    });
  }

  /** The person a Google account signs in as: found by Google's `sub` only, never by address. */
  userByGoogle(sub: string): string | undefined {
    return (this.db.prepare('SELECT id FROM users WHERE google_sub = ?').get(sub) as { id: string } | undefined)?.id;
  }

  /** Keeps the address shown on Settings current after a sign-in. */
  noteGoogleSignIn(userId: string, email: string): void {
    this.db.prepare('UPDATE users SET google_email = ? WHERE id = ?').run(email, userId);
    this.audit(userId, 'web', 'google.signin');
  }

  /**
   * A Google account that is no one here yet joins a circle, by invite or public join link: the person is made only
   * now, in the same transaction as joining. Its verified address needs no confirmation mail. As with an address
   * by email, one mailbox makes one person, and cannot come back after a removal; nothing links by address, so an
   * address someone here has is refused rather than signed in. `taken` when the handle is someone else's.
   */
  joinWithGoogle(google: { sub: string; email: string; name: string }, handle: string, join: (userId: string) => unknown, circle: { id: string; invite?: Invite }): string | 'taken' {
    return transaction(this.db, () => {
      let id = this.userByGoogle(google.sub);
      if (!id) {
        if (this.usersByEmail(google.email).length || this.mailboxTaken(google.email) || this.mailboxRemovedFrom(google.email, circle.id, circle.invite)) {
          throw new KlatschError('forbidden', 'This link is not valid.');
        }
        if (!HANDLE.test(handle) || this.db.prepare('SELECT 1 FROM users WHERE handle = ?').get(handle)) return 'taken';
        id = newId('usr');
        this.db.prepare('INSERT INTO users (id, handle, display_name, google_sub, google_email, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, handle, google.name, google.sub, google.email, Date.now());
        this.audit(id, 'web', 'google.create');
        this.setVerifiedEmail(id, google.email, 'web');
      }
      join(id);
      return id;
    });
  }

  /** Connects a Google account to a person who has none, after they confirmed it in their own session. */
  linkGoogle(userId: string, google: { sub: string; email: string }): boolean {
    return transaction(this.db, () => {
      if (this.userByGoogle(google.sub) || this.user(userId).google_sub !== null) return false;
      this.db.prepare('UPDATE users SET google_sub = ?, google_email = ? WHERE id = ?').run(google.sub, google.email, userId);
      this.audit(userId, 'web', 'google.link');
      this.notifyUser(userId, notifications.googleLinked);
      return true;
    });
  }

  unlinkGoogle(userId: string): void {
    transaction(this.db, () => {
      if (!this.db.prepare('UPDATE users SET google_sub = NULL, google_email = NULL WHERE id = ? AND google_sub IS NOT NULL').run(userId).changes) return;
      this.audit(userId, 'web', 'google.unlink');
      this.notifyUser(userId, notifications.googleUnlinked);
    });
  }

  /**
   * Who signs in with an address: the people whose confirmed address it is, in lower case (at most two, enough
   * to tell one from several). An unconfirmed address signs nobody in.
   */
  usersByEmail(email: string): string[] {
    return (
      this.db.prepare('SELECT id FROM users WHERE lower(email) = ? AND email_verified_at IS NOT NULL LIMIT 2').all(email.toLowerCase()) as { id: string }[]
    ).map((row) => row.id);
  }

  /**
   * Whether someone removed from this circle ever confirmed an address reaching `email`'s mailbox (kept even after
   * they cleared it), so a removal sticks to the mailbox too. As for a person, only an invite the owner created after
   * the removal readmits it.
   */
  mailboxRemovedFrom(email: string, circleId: string, invite?: Invite): boolean {
    const removals = this.db
      .prepare('SELECT r.created_at FROM removals r JOIN mailbox_history h ON h.user_id = r.user_id WHERE r.circle_id = ? AND h.mailbox_hash = ?')
      .all(circleId, this.mailboxHash(mailboxOf(email))) as { created_at: number }[];
    const readmits = (at: number) => invite !== undefined && this.memberRole(invite.createdBy, circleId) === 'owner' && invite.createdAt > at;
    return removals.some((removal) => !readmits(removal.created_at));
  }

  /**
   * A sign-in by email: audited, and the person hears of it (content-free), so one that was not them shows.
   * True when that already reaches their address by mail, so no separate notice is needed.
   */
  noteEmailSignIn(userId: string): boolean {
    this.audit(userId, 'web', 'email.signin');
    this.notifyUser(userId, notifications.emailSignIn);
    const user = this.user(userId);
    return Boolean(user.notify_email) && user.email_verified_at !== null;
  }

  /** Whether someone here already has a confirmed address that reaches the same mailbox as `email`. */
  mailboxTaken(email: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM users WHERE mailbox = ?').get(mailboxOf(email)));
  }

  /**
   * Someone who proved an address nobody here has (by opening the sign-in link mailed to it) joins a circle by
   * invite or public join link, like `joinWithGitHub`: the person is made only now, in the same transaction as
   * joining, with that address confirmed and the handle as their name. `taken` when the handle is someone else's;
   * an address one person got meanwhile joins as that person; one several people have, or a variant of an address
   * someone has (another +tag, Gmail dots), joins nobody, so one mailbox cannot make a second person or come back
   * after a removal.
   */
  joinWithEmail(email: string, handle: string, join: (userId: string) => unknown, circle: { id: string; invite?: Invite }): string | 'taken' {
    return transaction(this.db, () => {
      const people = this.usersByEmail(email);
      if (people.length > 1) throw new KlatschError('forbidden', 'This link is not valid.');
      let id = people[0];
      if (!id) {
        if (this.mailboxTaken(email) || this.mailboxRemovedFrom(email, circle.id, circle.invite)) throw new KlatschError('forbidden', 'This link is not valid.');
        if (!HANDLE.test(handle) || this.db.prepare('SELECT 1 FROM users WHERE handle = ?').get(handle)) return 'taken';
        id = newId('usr');
        this.db.prepare('INSERT INTO users (id, handle, display_name, created_at) VALUES (?, ?, ?, ?)').run(id, handle, handle, Date.now());
        this.audit(id, 'web', 'email.create');
        this.setVerifiedEmail(id, email, 'web');
      }
      join(id);
      return id;
    });
  }

  /**
   * Connects a GitHub account to a person who has none, after they confirmed it in their own session. False
   * if either side is already connected. The person hears of it, content-free, in case it was not them.
   */
  linkGitHub(userId: string, github: { id: number; login: string }): boolean {
    return transaction(this.db, () => {
      if (this.userByGitHub(github.id) || this.user(userId).github_id !== null) return false;
      this.db.prepare('UPDATE users SET github_id = ?, github_login = ? WHERE id = ?').run(github.id, github.login, userId);
      this.audit(userId, 'web', 'github.link');
      this.notifyUser(userId, notifications.githubLinked);
      return true;
    });
  }

  /** A passkey the person just made in their own session; at most `PASSKEYS_PER_PERSON`, and never one stored before. */
  addPasskey(userId: string, passkey: { id: string; publicKey: Uint8Array; counter: number; transports: string[]; synced: boolean }): void {
    transaction(this.db, () => {
      const { n } = this.db.prepare('SELECT count(*) n FROM passkeys WHERE user_id = ?').get(userId) as { n: number };
      if (n >= PASSKEYS_PER_PERSON) throw new KlatschError('forbidden', `You have ${PASSKEYS_PER_PERSON} passkeys; remove one first.`);
      if (this.db.prepare('SELECT 1 FROM passkeys WHERE id = ?').get(passkey.id)) throw new KlatschError('forbidden', 'This passkey is already in use.');
      this.db
        .prepare('INSERT INTO passkeys (id, user_id, public_key, counter, transports, synced, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(passkey.id, userId, passkey.publicKey, passkey.counter, JSON.stringify(passkey.transports), passkey.synced ? 1 : 0, Date.now());
      this.audit(userId, 'web', 'passkey.add');
      this.notifyUser(userId, notifications.passkeyAdded);
    });
  }

  /** Only the person's own passkey; another person's id changes nothing. */
  removePasskey(userId: string, id: string): void {
    transaction(this.db, () => {
      if (!this.db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(id, userId).changes) throw new KlatschError('not-found', 'No such passkey.');
      this.audit(userId, 'web', 'passkey.remove');
      this.notifyUser(userId, notifications.passkeyRemoved);
    });
  }

  /** A sign-in with a passkey that checked out: its new signature counter, and when it was last used. */
  usePasskey(id: string, userId: string, counter: number): void {
    this.db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ? AND user_id = ?').run(counter, Date.now(), id, userId);
    this.audit(userId, 'web', 'passkey.signin');
  }

  unlinkGitHub(userId: string): void {
    transaction(this.db, () => {
      if (!this.db.prepare('UPDATE users SET github_id = NULL, github_login = NULL WHERE id = ? AND github_id IS NOT NULL').run(userId).changes) return;
      this.audit(userId, 'web', 'github.unlink');
      this.notifyUser(userId, notifications.githubUnlinked);
    });
  }

  /** The user who creates a circle owns it; an existing circle keeps its owner. */
  ensureCircle(name: string, ownerId: string): string {
    const existing = this.db.prepare('SELECT id FROM circles WHERE name = ?').get(name) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = newId('cir');
    transaction(this.db, () => {
      this.db.prepare('INSERT INTO circles (id, name, created_at) VALUES (?, ?, ?)').run(id, name, Date.now());
      this.db
        .prepare(`INSERT INTO memberships (circle_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`)
        .run(id, ownerId, Date.now());
    });
    return id;
  }

  /**
   * "Add a friend": a new private circle for two, owned by `userId`, that its one invite fills. Named by a random
   * suffix nobody sees; pages show the other person instead. At most 20 waiting ones per person.
   */
  friendCircle(userId: string): string {
    // Links still waiting (unused, unexpired, friendship not ended), and how many were made in a day.
    const now = Date.now();
    const waiting = this.db
      .prepare(
        `SELECT count(*) AS n FROM circles c JOIN invites i ON i.circle_id = c.id
         WHERE c.pair = 1 AND c.ended_at IS NULL AND i.created_by = ? AND i.used_at IS NULL AND i.expires_at > ?`,
      )
      .get(userId, now) as { n: number };
    const today = this.db
      .prepare(`SELECT count(*) AS n FROM circles c JOIN memberships m ON m.circle_id = c.id AND m.user_id = ? AND m.role = 'owner' WHERE c.pair = 1 AND c.created_at > ?`)
      .get(userId, now - DAY) as { n: number };
    if (waiting.n >= 20) throw new KlatschError('forbidden', 'You have 20 friend links nobody opened yet. Wait until some are used or expire (after seven days).');
    if (today.n >= 30) throw new KlatschError('forbidden', 'You made 30 friend links today. Try again tomorrow.');
    const id = newId('cir');
    transaction(this.db, () => {
      this.db.prepare('INSERT INTO circles (id, name, created_at, pair, join_cap) VALUES (?, ?, ?, 1, 2)').run(id, `friends-${id.slice(-10)}`, Date.now());
      this.db.prepare(`INSERT INTO memberships (circle_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`).run(id, userId, Date.now());
      this.audit(userId, 'web', 'friend.circle', id);
    });
    return id;
  }

  /**
   * Either of the two ends a friendship: the other person leaves it as if removed (matches, waiting intros and
   * grants they no longer share a circle for end), and it disappears from both pages. Kept, not deleted, because
   * sips shared in it still name it.
   */
  endFriendship(userId: string, circleId: string): void {
    const circle = this.db.prepare('SELECT pair, ended_at FROM circles WHERE id = ?').get(circleId) as { pair: number; ended_at: number | null } | undefined;
    const role = this.memberRole(userId, circleId);
    if (!circle?.pair || circle.ended_at !== null || !role) throw new KlatschError('forbidden', 'This is not one of your friendships.');
    transaction(this.db, () => {
      const owner = (this.db.prepare(`SELECT user_id FROM memberships WHERE circle_id = ? AND role = 'owner'`).get(circleId) as { user_id: string }).user_id;
      const other = this.db.prepare('SELECT user_id FROM memberships WHERE circle_id = ? AND user_id != ?').get(circleId, owner) as { user_id: string } | undefined;
      // Neither loses their sign-in: with no circle left, a person can still add a friend.
      if (other) this.removeMember(owner, circleId, other.user_id, { keepAccess: true });
      this.db.prepare('UPDATE circles SET ended_at = ? WHERE id = ?').run(Date.now(), circleId);
      this.audit(userId, 'web', 'friend.end', circleId);
    });
  }

  /** The friendship two people share, if any. */
  friendshipOf(a: string, b: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT c.id FROM circles c JOIN memberships x ON x.circle_id = c.id AND x.user_id = ? JOIN memberships y ON y.circle_id = c.id AND y.user_id = ?
         WHERE c.pair = 1 AND c.ended_at IS NULL ORDER BY c.created_at LIMIT 1`,
      )
      .get(a, b) as { id: string } | undefined;
    return row?.id;
  }

  isFriendship(circleId: string): boolean {
    return Boolean((this.db.prepare('SELECT pair FROM circles WHERE id = ?').get(circleId) as { pair: number } | undefined)?.pair);
  }

  /** What a friendship is called on its two people's pages: the other person, or that the invite still waits. */
  pairName(circleId: string, userId: string): string {
    const other = this.db
      .prepare('SELECT u.handle FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.circle_id = ? AND m.user_id != ?')
      .get(circleId, userId) as { handle: string } | undefined;
    return other ? `@${other.handle}` : 'friend invite, not used yet';
  }

  /**
   * A person's friends, by handle only, for their own agent to name whom to ask. Not everyone in their private
   * circles: a big circle's member list is not something an agent should be able to read.
   */
  askablePeople(userId: string): { handle: string; friend: boolean }[] {
    const rows = this.db
      .prepare(
        `SELECT u.handle, 1 AS friend FROM memberships mine JOIN circles c ON c.id = mine.circle_id AND c.pair = 1 AND c.ended_at IS NULL
         JOIN memberships other ON other.circle_id = c.id AND other.user_id != mine.user_id JOIN users u ON u.id = other.user_id
         WHERE mine.user_id = ? GROUP BY u.id ORDER BY u.handle`,
      )
      .all(userId) as { handle: string; friend: number }[];
    return rows.filter((r) => agentHandle(r.handle)).map((r) => ({ handle: `@${r.handle}`, friend: r.friend === 1 }));
  }

  addMember(circleId: string, userId: string, invitedBy?: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO memberships (circle_id, user_id, invited_by, created_at) VALUES (?, ?, ?, ?)')
      .run(circleId, userId, invitedBy ?? null, Date.now());
  }

  user(userId: string): UserRow {
    const row = this.db.prepare('SELECT id, handle, display_name, email, email_verified_at, notify_email, github_id, github_login, google_sub, google_email, badge_id, agent_thanks, passkey_offer_dismissed_at, push_offer_dismissed_at FROM users WHERE id = ?').get(userId) as
      | UserRow
      | undefined;
    if (!row) throw new KlatschError('not-found', 'Unknown user.');
    return row;
  }

  /**
   * Sets or (with an empty string) clears the human's own address. Anything but one plain address is refused, unechoed.
   * A new address is unconfirmed, and links sent for an earlier one stop working. True if the address now needs confirming.
   */
  setEmail(userId: string, email: string): boolean {
    if (email !== '' && !isEmail(email)) throw new KlatschError('invalid', 'That is not an email address Klatsch accepts.');
    return transaction(this.db, () => {
      const changed = this.user(userId).email !== (email || null);
      this.db
        .prepare('UPDATE users SET email_verified_at = CASE WHEN email IS ? THEN email_verified_at END, mailbox = CASE WHEN email IS ? THEN mailbox END, email = ? WHERE id = ?')
        .run(email || null, email || null, email || null, userId);
      // Only a new address voids earlier links; saving the same one again keeps the last link working.
      if (changed) this.db.prepare('UPDATE email_confirmations SET expires_at = ? WHERE user_id = ? AND used_at IS NULL').run(Date.now(), userId);
      this.audit(userId, 'web', email ? 'email.set' : 'email.clear');
      return email !== '' && this.user(userId).email_verified_at === null;
    });
  }

  /** The seam for an address that is already proven (a confirmation link, or GitHub's primary verified address). */
  setVerifiedEmail(userId: string, email: string, via: Via): void {
    if (!isEmail(email)) throw new KlatschError('invalid', 'That is not an email address Klatsch accepts.');
    this.db.prepare('UPDATE users SET email = ?, email_verified_at = ?, mailbox = ? WHERE id = ?').run(email, Date.now(), mailboxOf(email), userId);
    this.rememberMailbox(userId, mailboxOf(email));
    this.audit(userId, via, 'email.verify');
  }

  /** Single use, in the human's own session, and only for the address they still have on file. */
  confirmEmail(userId: string, confirmation: EmailConfirmation): void {
    transaction(this.db, () => {
      if (this.user(userId).email !== confirmation.email || !claimEmailConfirmation(this.db, confirmation.id)) {
        throw new KlatschError('forbidden', 'This link is not valid.');
      }
      this.setVerifiedEmail(userId, confirmation.email, 'web');
    });
  }

  /**
   * A browser asked for notifications on this device: its push subscription, checked (a known push service, keys
   * of the right size). At most ten devices per person; the oldest goes. Saving the same endpoint again moves it.
   */
  savePushSubscription(userId: string, sub: { endpoint: string; p256dh: string; auth: string }): void {
    const endpoint = pushEndpoint(sub.endpoint);
    if (!endpoint || !pushKeyValid(sub.p256dh) || Buffer.from(sub.auth, 'base64url').length !== 16) {
      throw new KlatschError('invalid', 'This browser sent a subscription Klatsch cannot use.');
    }
    transaction(this.db, () => {
      // Someone else's device: never taken over. Signing in as another person here starts with notifications off.
      const holder = this.db.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as { user_id: string } | undefined;
      if (holder && holder.user_id !== userId) throw new KlatschError('invalid', 'This browser gets notifications for someone else. Turn them off there first.');
      this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, userId);
      this.db.prepare('INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(newId('push'), userId, endpoint, sub.p256dh, sub.auth, Date.now());
      this.db
        .prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND rowid NOT IN (SELECT rowid FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 10)')
        .run(userId, userId);
      this.audit(userId, 'web', 'push.on');
    });
  }

  pushSubscriptionsOf(userId: string): PushSubscriptionRow[] {
    return this.db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(userId) as unknown as PushSubscriptionRow[];
  }

  forgetPushSubscription(id: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id);
  }

  /** Notifications off on one device: the person's own subscription for this endpoint, if any. */
  forgetOwnPushSubscription(userId: string, endpoint: string): void {
    const normal = pushEndpoint(endpoint);
    if (!normal) return;
    const removed = this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(normal, userId);
    if (removed.changes) this.audit(userId, 'web', 'push.off.here');
  }

  /** Notifications off on every device of this person. */
  pushOff(userId: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
    this.audit(userId, 'web', 'push.off');
  }

  setEmailNotifications(userId: string, on: boolean): void {
    this.db.prepare('UPDATE users SET notify_email = ? WHERE id = ?').run(on ? 1 : 0, userId);
    this.audit(userId, 'web', on ? 'notify.email.on' : 'notify.email.off');
  }

  /** In a circle with someone to share with: an ended friendship, or one whose link nobody used yet, does not count. */
  inAnyCircle(userId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM memberships m JOIN circles c ON c.id = m.circle_id
           WHERE m.user_id = ? AND c.ended_at IS NULL AND (c.pair = 0 OR (SELECT count(*) FROM memberships x WHERE x.circle_id = c.id) = 2)`,
        )
        .get(userId),
    );
  }

  memberRole(userId: string, circleId: string): Role | undefined {
    const row = this.db.prepare('SELECT role FROM memberships WHERE circle_id = ? AND user_id = ?').get(circleId, userId) as
      | { role: Role }
      | undefined;
    return row?.role;
  }

  /** The circles a human is in, with their members: for the human web UI only, never for agents. */
  circlesOf(userId: string): CircleView[] {
    const circles = this.db
      .prepare(
        `SELECT c.id, c.name, c.public, c.pair, c.join_token, c.join_cap, m.role, (SELECT count(*) FROM memberships x WHERE x.circle_id = c.id) AS people
         FROM circles c JOIN memberships m ON m.circle_id = c.id WHERE m.user_id = ? AND c.ended_at IS NULL ORDER BY c.pair, c.name`,
      )
      .all(userId) as { id: string; name: string; public: number; pair: number; join_token: string | null; join_cap: number | null; role: Role; people: number }[];
    const members = this.db.prepare(
      `SELECT u.id, u.handle, u.display_name, m.role, m.invited_by FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.circle_id = ? ORDER BY m.created_at, u.handle`,
    );
    return circles.map((circle) => {
      const all = (members.all(circle.id) as { id: string; handle: string; display_name: string; role: Role; invited_by: string | null }[]).map((m) => ({
        id: m.id,
        handle: m.handle,
        displayName: m.display_name,
        role: m.role,
        invitedBy: m.invited_by,
      }));
      const hidden = Boolean(circle.public) && circle.role !== 'owner';
      return {
        id: circle.id,
        name: circle.pair ? this.pairName(circle.id, userId) : circle.name,
        role: circle.role,
        people: circle.people,
        public: Boolean(circle.public),
        joinToken: circle.join_token,
        joinCap: circle.join_cap,
        pair: Boolean(circle.pair),
        members: hidden ? all.filter((m) => m.role === 'owner' || m.id === userId) : all,
      };
    });
  }

  /** The circles a person shares in, private ones first, with how many people each reaches: for the approval page. */
  sharingCircles(userId: string): SharingCircle[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.name, c.public, c.pair, (SELECT count(*) FROM memberships x WHERE x.circle_id = c.id) AS people
         FROM circles c JOIN memberships m ON m.circle_id = c.id WHERE m.user_id = ? AND c.ended_at IS NULL ORDER BY c.public, c.pair, c.name`,
      )
      .all(userId) as { id: string; name: string; public: number; pair: number; people: number }[];
    return rows.map((r) => ({ id: r.id, name: r.pair ? this.pairName(r.id, userId) : r.name, public: Boolean(r.public), pair: Boolean(r.pair), people: r.people }));
  }

  // ---------- public circles ----------

  /**
   * Turns the circle's public join link on (a new random 128-bit link each time, or `name`, a short name) or
   * off, for its owner. Only the operator's CLI turns it on; the owner's web page only turns it off. Off stops
   * new joins only; members stay. The first time it goes on, the circle becomes public for good, and every sip
   * shared in it before leaves it (never matches there again): its author shared it with the people who were
   * in it, not with whoever comes next. Intros it backed alone are declined. Returns the link's last segment.
   */
  setJoinLink(ownerId: string, circleId: string, on: boolean, options: { name?: string; cap?: number | null } = {}): string | undefined {
    if (this.memberRole(ownerId, circleId) !== 'owner') throw new KlatschError('forbidden', 'Only the owner of the circle can change its public join link.');
    if (this.isFriendship(circleId)) throw new KlatschError('forbidden', 'A friendship is for two people; it cannot have a public join link.');
    if (options.name !== undefined && !JOIN_NAME.test(options.name)) throw new KlatschError('invalid', 'A join link name is 3–20 lowercase letters, digits or hyphens.');
    if (options.cap !== undefined && options.cap !== null && !(Number.isInteger(options.cap) && options.cap > 0)) throw new KlatschError('invalid', 'A cap is a whole number above zero.');
    return transaction(this.db, () => {
      if (!on) {
        this.db.prepare('UPDATE circles SET join_token = NULL WHERE id = ?').run(circleId);
        this.audit(ownerId, 'web', 'circle.public.off', circleId);
        return undefined;
      }
      const token = options.name ?? randomToken(16);
      if (this.db.prepare('SELECT 1 FROM circles WHERE join_token = ? AND id != ?').get(token, circleId)) throw new KlatschError('invalid', 'That join link name is taken.');
      const was = this.db.prepare('SELECT public FROM circles WHERE id = ?').get(circleId) as { public: number };
      if (!was.public) {
        this.db.prepare('DELETE FROM sip_circles WHERE circle_id = ?').run(circleId);
        this.declineUnbacked();
      }
      this.db.prepare('UPDATE circles SET public = 1, join_token = ? WHERE id = ?').run(token, circleId);
      if (options.cap !== undefined) this.db.prepare('UPDATE circles SET join_cap = ? WHERE id = ?').run(options.cap, circleId);
      this.audit(ownerId, 'web', 'circle.public.on', circleId);
      return token;
    });
  }

  /** The circle a public join link leads to while it is on; anything else is simply not found. */
  publicCircle(token: string): { id: string; name: string; people: number; cap: number | null } | undefined {
    if (!JOIN_TOKEN.test(token)) return undefined;
    return this.db
      .prepare('SELECT c.id, c.name, c.join_cap AS cap, (SELECT count(*) FROM memberships x WHERE x.circle_id = c.id) AS people FROM circles c WHERE c.join_token = ?')
      .get(token) as { id: string; name: string; people: number; cap: number | null } | undefined;
  }

  /**
   * Joins a public circle by its link, like an invite but for anyone. A removal sticks here too (only an
   * invite from the owner brings someone back), and a full circle takes nobody; both, and a link that is off
   * or unknown, throw with the words the page shows.
   */
  joinPublic(userId: string, token: string): 'joined' | 'already-member' {
    return transaction(this.db, () => {
      const circle = this.publicCircle(token);
      if (!circle) throw new KlatschError('forbidden', 'This join link is not valid.');
      if (this.memberRole(userId, circle.id)) return 'already-member';
      if (this.isRemoved(userId, circle.id)) throw new KlatschError('forbidden', 'This join link is not valid.');
      if (circle.cap !== null && circle.people >= circle.cap) throw new KlatschError('forbidden', 'This circle is full.');
      this.addMember(circle.id, userId);
      this.audit(userId, 'web', 'circle.join', circle.id);
      return 'joined';
    });
  }

  /**
   * Joins the invite's circle. Joining a circle you are already in leaves the invite unused.
   * Someone removed from the circle can only come back on an invite its owner created after the removal, which clears the removal.
   */
  acceptInvite(userId: string, invite: Invite): 'joined' | 'already-member' | 'already-friends' {
    return transaction(this.db, () => {
      if (this.memberRole(userId, invite.circleId)) return 'already-member';
      // A second friend link between the same two people: they are friends already, so the new one is closed unused.
      if (invite.pair && userId !== invite.createdBy && this.friendshipOf(userId, invite.createdBy)) {
        this.db.prepare('UPDATE circles SET ended_at = ? WHERE id = ? AND pair = 1').run(Date.now(), invite.circleId);
        this.audit(userId, 'web', 'friend.again', invite.circleId);
        return 'already-friends';
      }
      if (!this.inviteOpenTo(userId, invite) || !this.mayInvite(invite.createdBy, invite.circleId)) throw new KlatschError('forbidden', 'This invite is not valid.');
      const circle = this.db
        .prepare('SELECT join_cap AS cap, (SELECT count(*) FROM memberships x WHERE x.circle_id = c.id) AS people FROM circles c WHERE c.id = ?')
        .get(invite.circleId) as { cap: number | null; people: number };
      if (circle.cap !== null && circle.people >= circle.cap) throw new KlatschError('forbidden', 'This circle is full.');
      if (!claimInvite(this.db, invite.id, userId)) throw new KlatschError('forbidden', 'This invite is not valid.');
      this.db.prepare('DELETE FROM removals WHERE circle_id = ? AND user_id = ?').run(invite.circleId, userId);
      this.addMember(invite.circleId, userId, invite.createdBy);
      this.audit(userId, 'web', 'invite.accept', invite.id);
      return 'joined';
    });
  }

  /**
   * Who may invite into a circle: any member of a private one; in a public one only its owner, so strangers
   * cannot pull more strangers in. Checked again when an invite is used. Invites ignore the join link being off.
   */
  mayInvite(userId: string, circleId: string): boolean {
    const role = this.memberRole(userId, circleId);
    if (!role) return false;
    // A friendship has its one invite, from the person who made it; an ended one takes nobody.
    const kind = this.db.prepare('SELECT pair, ended_at FROM circles WHERE id = ?').get(circleId) as { pair: number; ended_at: number | null };
    if (kind.ended_at !== null || (kind.pair && role !== 'owner')) return false;
    return role === 'owner' || !(this.db.prepare('SELECT public FROM circles WHERE id = ?').get(circleId) as { public: number }).public;
  }

  /** Whether the circle's owner removed this person (only an invite from the owner brings them back). */
  isRemoved(userId: string, circleId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM removals WHERE circle_id = ? AND user_id = ?').get(circleId, userId));
  }

  /** A removed person may use only an invite the owner created after the removal; anyone else any invite. */
  inviteOpenTo(userId: string, invite: Invite): boolean {
    const removal = this.db.prepare('SELECT created_at FROM removals WHERE circle_id = ? AND user_id = ?').get(invite.circleId, userId) as
      | { created_at: number }
      | undefined;
    return !removal || (this.memberRole(invite.createdBy, invite.circleId) === 'owner' && invite.createdAt > removal.created_at);
  }

  /**
   * Owner only, never themselves. The member's sips stop matching in this
   * circle, intros about them that are still open are declined (the seeker
   * hears so, as with any decline), only the owner can invite them back, and
   * someone left in no circle loses every agent token, web session and unused login link, and their badge.
   */
  removeMember(ownerId: string, circleId: string, memberId: string, options: { keepAccess?: boolean } = {}): void {
    if (this.memberRole(ownerId, circleId) !== 'owner') throw new KlatschError('forbidden', 'Only the owner of the circle can remove members.');
    if (memberId === ownerId) throw new KlatschError('forbidden', 'You cannot remove yourself.');
    // A friendship ends with endFriendship, which keeps both signed in and closes it for good.
    if (!options.keepAccess && this.isFriendship(circleId)) throw new KlatschError('forbidden', 'Use Remove friend to end a friendship.');
    transaction(this.db, () => {
      const removed = this.db.prepare('DELETE FROM memberships WHERE circle_id = ? AND user_id = ?').run(circleId, memberId);
      if (!removed.changes) throw new KlatschError('not-found', 'No such member.');
      const now = Date.now();
      this.db
        .prepare('INSERT OR REPLACE INTO removals (circle_id, user_id, removed_by, created_at) VALUES (?, ?, ?, ?)')
        .run(circleId, memberId, ownerId, now);
      // Intros with them that no circle of the solved sip backs any more (they may still share another one).
      this.declineUnbacked(now, memberId);
      // Quotes not yet read that came from or went to the removed member, of sips no circle shared by the two backs any more.
      this.dropQuotes(
        `(user_id = ? OR from_user_id = ?) AND NOT EXISTS (SELECT 1 FROM sip_circles sc JOIN memberships a ON a.circle_id = sc.circle_id AND a.user_id = handoffs.from_user_id
           JOIN memberships b ON b.circle_id = sc.circle_id AND b.user_id = handoffs.user_id WHERE sc.sip_id = handoffs.sip_id)`,
        memberId,
        memberId,
      );
      // Grants are per person, but only between people who share a circle: once they share none, theirs end,
      // and a later invite does not bring them back.
      const ended = this.db
        .prepare(
          `SELECT id, grantor_id, grantee_id, kind FROM grants g WHERE revoked_at IS NULL AND (grantor_id = ? OR grantee_id = ?)
             AND NOT EXISTS (SELECT 1 FROM memberships a JOIN memberships b ON a.circle_id = b.circle_id WHERE a.user_id = g.grantor_id AND b.user_id = g.grantee_id)`,
        )
        .all(memberId, memberId) as { id: string; grantor_id: string; grantee_id: string; kind: GrantView['kind'] }[];
      for (const g of ended) {
        this.endGrant(g.id, g.kind === 'show' ? g.grantee_id : g.grantor_id, g.kind === 'show' ? g.grantor_id : g.grantee_id, g.kind);
        this.audit(g.grantor_id, 'web', 'grant.end', g.id);
      }
      if (!options.keepAccess && !this.inAnyCircle(memberId)) {
        revokeTokens(this.db, memberId);
        this.db.prepare('DELETE FROM web_sessions WHERE user_id = ?').run(memberId);
        this.db.prepare('DELETE FROM web_logins WHERE user_id = ? AND used_at IS NULL').run(memberId);
        this.db.prepare('UPDATE users SET badge_id = NULL WHERE id = ?').run(memberId);
      }
      this.audit(ownerId, 'web', 'member.remove', `${circleId}/${memberId}`);
    });
  }

  /**
   * The person asked for their account to be deleted (Settings, or the operator by `klatsch delete`): everything
   * that is theirs goes, now, in one transaction. Their sips, drafts, cards, asks, quotes, matches and intros
   * with others, thanks, grants, tokens, sessions, passkeys, sign-in records, and their lines in the security
   * log; other people's news about those things too. A circle they own passes to its longest-standing member
   * (if it has no other owner); a circle with nobody else in it goes. What is left is one log line without a
   * name, so the operator can show a deletion happened. Backups still hold it for as long as the privacy page says.
   * Walks the foreign keys of the schema, so a table added later is covered without a change here.
   */
  deleteAccount(userId: string, via: Via): void {
    this.user(userId);
    transaction(this.db, () => {
      const owned = this.db.prepare(`SELECT circle_id FROM memberships WHERE user_id = ? AND role = 'owner'`).all(userId) as { circle_id: string }[];
      const removed = new Set<string>();
      for (const { circle_id } of owned) {
        const others = this.db.prepare(`SELECT user_id, role FROM memberships WHERE circle_id = ? AND user_id <> ? ORDER BY created_at, user_id`).all(circle_id, userId) as {
          user_id: string;
          role: string;
        }[];
        if (!others.length) purge(this.db, 'circles', 'id', [circle_id], removed);
        else if (!others.some((m) => m.role === 'owner')) this.db.prepare(`UPDATE memberships SET role = 'owner' WHERE circle_id = ? AND user_id = ?`).run(circle_id, others[0]!.user_id);
      }
      this.db.prepare('DELETE FROM connect_requests WHERE user_id = ?').run(userId);
      purge(this.db, 'users', 'id', [userId], removed);
      const ids = JSON.stringify([...removed]);
      this.db.prepare('DELETE FROM events WHERE ref IN (SELECT value FROM json_each(?))').run(ids);
      this.db.prepare(`DELETE FROM audit WHERE user_id = ? OR ref LIKE '%' || ? || '%' OR ref IN (SELECT value FROM json_each(?))`).run(userId, userId, ids);
      this.audit(null, via, 'account.delete');
    });
  }

  /**
   * Intros still waiting for the solver that no circle backs any more, one both sips were shared in and both
   * people are still in (a removal, a circle gone public) are declined; the seeker hears so, as with any decline, unless they are the one `removed`.
   */
  private declineUnbacked(now = Date.now(), removed?: string): void {
    const open = this.db
      .prepare(
        `SELECT i.id, m.seeker_id FROM intros i JOIN matches m ON m.id = i.match_id JOIN sips s ON s.id = m.sip_id
         WHERE i.state = 'awaiting-solver' AND NOT ${jointScope('i.seeker_sip_id', 'm.seeker_id')}`,
      )
      .all() as { id: string; seeker_id: string }[];
    const decline = this.db.prepare(`UPDATE intros SET state = 'declined', updated_at = ? WHERE id = ?`);
    for (const intro of open) {
      decline.run(now, intro.id);
      if (intro.seeker_id !== removed) this.event(intro.seeker_id, 'intro.declined', intro.id);
    }
  }

  private primaryCircle(userId: string): string {
    const row = this.db
      .prepare('SELECT circle_id FROM memberships WHERE user_id = ? ORDER BY created_at LIMIT 1')
      .get(userId) as { circle_id: string } | undefined;
    if (!row) throw new KlatschError('forbidden', 'You are not in a circle yet.');
    return row.circle_id;
  }

  // ---------- sips ----------

  /**
   * Agents only ever create drafts. A draft is invisible to everyone else until its human approves it.
   * A solved sip asks first unless `visibility` says otherwise; the approval page offers open as its default.
   */
  draftSip(userId: string, input: UpdateCardInput, via: Via): { sipId: string; tags: string[]; flags: Flag[] } {
    const { tags, flags, source } = this.previewSip(input);
    const sipId = newId('sip');
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO sips (id, user_id, circle_id, status, failed, summary, state, visibility, flags, source_url, source_title, source_author, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sipId,
          userId,
          this.primaryCircle(userId),
          // A tried sip is a note like a solved one: the same matching, consent and scope rules hold.
          input.status === 'tried' ? 'solved' : input.status,
          input.status === 'tried' ? 1 : 0,
          sealText(this.db, input.summary),
          (input.status === 'solved' || input.status === 'tried') && input.visibility === 'open' ? 'open' : 'ask',
          sealText(this.db, JSON.stringify(flags)),
          sealOptional(this.db, source?.url),
          sealOptional(this.db, source?.title),
          sealOptional(this.db, source?.author),
          Date.now(),
        );
      const tag = this.db.prepare('INSERT INTO sip_tags (sip_id, slug) VALUES (?, ?)');
      for (const slug of tags) tag.run(sipId, slug);
      this.audit(userId, via, 'sip.draft', sipId);
    });
    return { sipId, tags, flags };
  }

  /**
   * `visibility`: who reads a solved sip, as the human chose it when approving; without it, what the draft says.
   * The sip is shared in `matchIn`, the circles the human ticked (of those they are in now), and matches and
   * asks for intros only there; an open note is readable there without an intro. Without that choice, in their
   * private circles only, never silently in a public one. Nothing ticked is refused.
   */
  approveSip(userId: string, sipId: string, via: Via = 'web', visibility?: Visibility, matchIn?: string[], feed = false): void {
    const draft = this.ownDraft(userId, sipId);
    const sip = draft.status === 'solved' && visibility ? { ...draft, visibility } : draft;
    const scope = this.sharingCircles(userId).filter((c) => (matchIn ? matchIn.includes(c.id) : !c.public && !c.pair));
    if (!scope.length) throw new KlatschError('invalid', consent.pickCircle);
    const open = sip.status === 'solved' && sip.visibility === 'open' ? 1 : 0;
    const now = Date.now();
    const expiresAt = sip.status === 'looking' ? now + this.config.lookingTtlDays * DAY : null;
    const notified = transaction(this.db, () => {
      this.db.prepare(`UPDATE sips SET state = 'approved', approved_at = ?, expires_at = ?, visibility = ? WHERE id = ?`).run(now, expiresAt, sip.visibility, sipId);
      const row = this.db.prepare('INSERT INTO sip_circles (sip_id, circle_id, open, feed) VALUES (?, ?, ?, ?)');
      // Never in a public circle: a page of everything strangers wrote, with their names, is a directory of people.
      for (const circle of scope) row.run(sipId, circle.id, open, open && feed && !circle.public ? 1 : 0);
      this.audit(userId, via, 'sip.approve', sipId);
      return this.matchApprovedSip({ ...sip, state: 'approved', approved_at: now, expires_at: expiresAt });
    });
    for (const { userId: seekerId, solved } of notified) this.notifyUser(seekerId, solved ? notifications.match : notifications.other);
    // Once it is committed: the decision may be part of a larger transaction.
    afterCommit(this.db, () => this.embedLater(sipId, sip.summary));
  }

  /**
   * Checks tags, the source and flags without storing anything, for the approval dialog. A source goes only
   * with a solved sip; its title and author are flagged like the summary, the link is shown in full instead.
   */
  previewSip(input: UpdateCardInput): { tags: string[]; flags: Flag[]; source?: Source } {
    refuseHidden(input.summary);
    const { resolved, unknown } = resolveTags(this.db, input.tags);
    if (unknown.length) {
      throw new KlatschError('unknown-tags', 'Some tags are not in the Klatsch vocabulary. Use the suggestions and try again.', unknown);
    }
    if (!input.source) return { tags: resolved, flags: detect(input.summary) };
    if (input.status !== 'solved') throw new KlatschError('invalid', SOURCE_REFUSED.notSolved);
    const source = checkSource(input.source);
    if ('refused' in source) throw new KlatschError('invalid', source.refused);
    return { tags: resolved, flags: detect([input.summary, source.title, source.author ?? ''].join('\n')), source };
  }

  /** Draft and approve in one step, once the human approved it with a code. */
  shareSip(userId: string, input: UpdateCardInput, via: Via, matchIn?: string[], feed = false): { sipId: string; tags: string[]; flags: Flag[] } {
    const draft = this.draftSip(userId, input, via);
    this.approveSip(userId, draft.sipId, via, undefined, matchIn, feed);
    return draft;
  }

  /** The approval payload's sip, as `update_card` stored it (the source in three plain fields). */
  private payloadSip(p: Record<string, string | undefined>, visibility?: Visibility): UpdateCardInput {
    return {
      status: p.status as SipStatus,
      tags: JSON.parse(p.tags!) as string[],
      summary: p.summary!,
      ...(visibility ? { visibility } : {}),
      ...(p.source_url !== undefined && p.source_title !== undefined
        ? { source: { url: p.source_url, title: p.source_title, ...(p.source_author !== undefined ? { author: p.source_author } : {}) } }
        : {}),
    };
  }

  // ---------- approvals ----------

  /** What the human approves, for the approval page. Other people's text appears only there, in the human's session. */
  describeApproval(userId: string, approval: Approval): ApprovalView {
    const p = approval.payload;
    if (approval.action === 'share_sip') {
      const input = this.payloadSip(p);
      const preview = this.previewSip(input);
      return {
        action: 'share_sip',
        status: input.status,
        tags: preview.tags,
        summary: input.summary,
        flags: preview.flags,
        askForIntro: p.ask_for_intro === 'true' && input.status === 'looking',
        visibility: p.visibility === 'open' ? 'open' : 'ask',
        ...(preview.source ? { source: preview.source } : {}),
        circles: this.sharingCircles(userId),
      };
    }
    if (approval.action === 'send_intro') return { action: 'send_intro', ...this.seekerPreview(userId, p.match_id!, consent.noIntroNeeded) };
    if (approval.action === 'ask_person') {
      const helper = this.askTarget(userId, p.handle!);
      const preview = this.previewAsk(JSON.parse(p.tags!) as string[], p.question!);
      return { action: 'ask_person', to: { name: helper.display_name, handle: helper.handle }, tags: preview.tags, question: p.question!, flags: preview.flags };
    }
    if (approval.action === 'answer_ask') {
      const ask = this.openAskFor(userId, p.ask_id!);
      refuseHidden(p.answer!);
      return { action: 'answer_ask', from: ask.asker, tags: ask.tags, question: ask.question, answer: p.answer!, tried: p.tried === 'true', flags: detect(p.answer!) };
    }
    const intro = this.introOf(userId, p.intro_id!);
    return { action: 'answer_intro', tags: intro.tags, request: intro.request?.summary ?? '', ...(intro.request?.circle ? { circle: intro.request.circle } : {}) };
  }

  /**
   * Runs the approved action in the human's web session. Single use: a decided or expired approval does nothing.
   * `choice` is what the human picked on the page: who reads a solved sip (the page preselects the agent's
   * proposal; without a choice it asks first, so nothing opens that the human did not pick), and whether an
   * intro they allow also lets that person read their future notes.
   */
  decideApproval(userId: string, approval: Approval, decision: 'approved' | 'declined', choice: Choice = {}): Record<string, unknown> | undefined {
    const p = approval.payload;
    // Claim first, act second, in one transaction: an approval that expired or was decided meanwhile never runs.
    return transaction(this.db, () => {
      if (!claim(this.db, userId, approval.id, decision)) throw new KlatschError('forbidden', 'This approval is no longer open.');
      let result: Record<string, unknown> | undefined;
      if (decision === 'approved') {
        if (approval.action === 'share_sip') {
          // Open only when the human picked it on the page; the agent's proposal alone never opens a note.
          const visibility = choice.visibility ?? 'ask';
          const shared = this.shareSip(userId, this.payloadSip(p, visibility), 'web', choice.matchIn, choice.feed);
          // Only within the circles ticked for this looking sip: no intro (and no reading of it) elsewhere.
          const found = p.status === 'looking' ? this.findMatches(userId, shared.tags, 'web', shared.sipId).matches : [];
          // A note open to the human needs no intro, and its author is not disturbed.
          const intros =
            // Nor is someone asked for whom it did not work: their note is a warning, the seeker may still ask by hand.
            p.ask_for_intro === 'true' ? found.filter((m) => !m.open && !m.outcome).slice(0, 3).map((m) => this.requestIntro(userId, m.match_id).introId) : [];
          const open = found.filter((m) => m.open).map(({ open: _, ...m }) => m);
          result = { sip_id: shared.sipId, intros, ...(open.length ? { matches: open } : {}) };
        } else if (approval.action === 'send_intro') {
          result = { intro_id: this.requestIntro(userId, p.match_id!).introId };
        } else if (approval.action === 'ask_person') {
          result = { ask_id: this.createAsk(userId, p.handle!, JSON.parse(p.tags!) as string[], this.editedText(choice.text, p.question!, QUESTION_MAX)) };
        } else if (approval.action === 'answer_ask') {
          this.answerAsk(userId, p.ask_id!, this.editedText(choice.text, p.answer!, ANSWER_MAX), p.tried === 'true');
          result = { ask_id: p.ask_id };
        } else {
          result = { intro_id: p.intro_id, state: this.approveIntro(userId, p.intro_id!, 'web', choice.always) };
        }
        setResult(this.db, approval.id, result);
      } else if (approval.action === 'answer_intro') {
        this.declineIntro(userId, p.intro_id!, 'web');
      }
      this.event(userId, `approval.${decision}`, approval.id);
      this.audit(userId, 'web', `approval.${approval.action}.${decision}`, approval.id);
      return result;
    });
  }

  // ---------- asking one person directly ----------

  /**
   * The person a handle names, if they share a private circle with `askerId`. Everyone else, unknown handles and
   * the asker themselves get one answer, so a handle tells an agent nothing about who is on the relay.
   */
  askTarget(askerId: string, handle: string): UserRow {
    const clean = handle.replace(/^@/, '');
    const row = HANDLE.test(clean) ? (this.db.prepare('SELECT id FROM users WHERE handle = ?').get(clean) as { id: string } | undefined) : undefined;
    if (!row || row.id === askerId || !this.sharePrivateCircle(askerId, row.id)) throw new KlatschError('invalid', ASK.noOne);
    return this.user(row.id);
  }

  /** Two people in one private circle: the only pairs a direct question may join. Strangers in a commons are not one. */
  private sharePrivateCircle(a: string, b: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM memberships x JOIN memberships y ON x.circle_id = y.circle_id JOIN circles c ON c.id = x.circle_id AND c.public = 0 WHERE x.user_id = ? AND y.user_id = ?')
        .get(a, b),
    );
  }

  /** Checks a question before anyone approves it: tags from the vocabulary, nothing hidden, identifiers flagged. */
  previewAsk(tags: string[], question: string): { tags: string[]; flags: Flag[] } {
    refuseHidden(question);
    if (!tags.length) return { tags: [], flags: detect(question) };
    const { resolved, unknown } = resolveTags(this.db, tags);
    if (unknown.length) throw new KlatschError('unknown-tags', 'Some tags are not in the Klatsch vocabulary. Use the suggestions and try again.', unknown);
    return { tags: resolved, flags: detect(question) };
  }

  /** Whether `askerId` may open another question now. */
  canAsk(askerId: string): boolean {
    const now = Date.now();
    const open = this.db.prepare(`SELECT count(*) AS n FROM asks WHERE asker_id = ? AND state = 'open' AND expires_at > ?`).get(askerId, now) as { n: number };
    const today = this.db.prepare('SELECT count(*) AS n FROM asks WHERE asker_id = ? AND created_at > ?').get(askerId, now - DAY) as { n: number };
    return open.n < ASKS_OPEN && today.n < ASKS_PER_DAY;
  }

  /**
   * Runs once the asker's human approved it. Only the person asked reads the question, with the asker's name; it
   * reaches their agent only by their own click, or because they chose to always get this person's notes.
   */
  private createAsk(askerId: string, handle: string, tags: string[], question: string): string {
    const helper = this.askTarget(askerId, handle);
    if (!this.canAsk(askerId)) throw new KlatschError('forbidden', ASK.tooMany);
    const resolved = this.previewAsk(tags, question).tags;
    const id = newId('k');
    const now = Date.now();
    const always = this.hasGrant(helper.id, askerId, 'deliver');
    this.db
      .prepare(`INSERT INTO asks (id, asker_id, helper_id, question, tags, state, question_for_agent, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
      .run(id, askerId, helper.id, sealText(this.db, question), JSON.stringify(resolved), always ? 1 : 0, now, now + ASK_DAYS * DAY);
    this.event(helper.id, 'ask.received', id);
    if (always) this.event(helper.id, 'ask.question', id);
    this.audit(askerId, 'web', 'ask.create', id);
    this.notifyUser(helper.id, notifications.other);
    return id;
  }

  private askRow(id: string) {
    return this.db.prepare('SELECT * FROM asks WHERE id = ?').get(id) as
      | { id: string; asker_id: string; helper_id: string; question: string; tags: string; answer: string | null; answer_failed: number; state: AskView['state']; question_for_agent: number; answer_for_agent: number; created_at: number; expires_at: number }
      | undefined;
  }

  /** A question waiting for `helperId`, while the two still share a private circle. One refusal for everything else. */
  private openAskFor(helperId: string, askId: string) {
    const row = this.askRow(askId);
    if (!row || row.helper_id !== helperId || row.state !== 'open' || row.expires_at <= Date.now() || !this.sharePrivateCircle(helperId, row.asker_id)) {
      throw new KlatschError('forbidden', ASK.notOpen);
    }
    const asker = this.user(row.asker_id);
    return { row, asker: { name: asker.display_name, handle: asker.handle }, tags: JSON.parse(row.tags) as string[], question: row.question };
  }

  /** An answer's own checks, before anyone approves it: nothing hidden, identifiers flagged. */
  previewAnswer(answer: string): Flag[] {
    refuseHidden(answer);
    return detect(answer);
  }

  /** A question waiting for `helperId`, with who asked: for the card in their own chat, never for their agent. */
  questionFor(helperId: string, askId: string): { from: { name: string; handle: string }; question: string } {
    const { asker, question } = this.openAskFor(helperId, askId);
    return { from: asker, question };
  }

  /** Throws unless this question waits for `helperId`. */
  checkAnswerable(helperId: string, askId: string): void {
    this.openAskFor(helperId, askId);
  }

  /** The person's own edit of a drafted question or answer, checked like the draft was; the draft when there is none. */
  private editedText(edited: string | undefined, draft: string, max: number): string {
    if (edited === undefined) return draft;
    const text = edited.trim();
    if (!text) throw new KlatschError('invalid', ASK.emptyAnswer);
    if (text.length > max) throw new KlatschError('invalid', `At most ${max} characters.`);
    refuseHidden(text);
    return text;
  }

  /** The person asked writes the answer themselves, on their page: their click is the approval. */
  answerByHand(helperId: string, askId: string, answer: string): void {
    const text = answer.trim();
    if (!text) throw new KlatschError('invalid', ASK.emptyAnswer);
    if (text.length > ANSWER_MAX) throw new KlatschError('invalid', ASK.longAnswer);
    this.answerAsk(helperId, askId, text, false, 'web');
  }

  private answerAsk(helperId: string, askId: string, answer: string, tried: boolean, via: Via = 'web'): void {
    const { row } = this.openAskFor(helperId, askId);
    refuseHidden(answer);
    // The asker's agent asked it, so the answer goes there at once; the person answering is told so first.
    this.db
      .prepare(`UPDATE asks SET state = 'answered', answer = ?, answer_failed = ?, answered_at = ?, answer_for_agent = 1, question_for_agent = 0 WHERE id = ? AND state = 'open'`)
      .run(sealText(this.db, answer), tried ? 1 : 0, Date.now(), askId);
    this.event(row.asker_id, 'ask.answered', askId);
    this.event(row.asker_id, 'ask.answer', askId);
    this.audit(helperId, via, 'ask.answer', askId);
    this.notifyUser(row.asker_id, notifications.other);
  }

  /** The person asked hands the question to their own agent, once, by a click in their session. */
  sendAskToAgent(userId: string, askId: string): { from: string } {
    const row = this.askRow(askId);
    if (row?.helper_id === userId) {
      const { asker } = this.openAskFor(userId, askId);
      this.db.prepare('UPDATE asks SET question_for_agent = 1 WHERE id = ?').run(askId);
      this.event(userId, 'ask.question', askId, true);
      this.audit(userId, 'web', 'ask.send', askId);
      return { from: `@${asker.handle}` };
    }
    // The asker's agent already got the answer when it came; a click from an old page sends nothing twice.
    if (!row || row.asker_id !== userId || row.state !== 'answered' || row.expires_at <= Date.now() || !this.sharePrivateCircle(userId, row.helper_id)) {
      throw new KlatschError('forbidden', ASK.notOpen);
    }
    return { from: `@${this.user(row.helper_id).handle}` };
  }

  /** The person asked declines; the asker hears it. Nothing of theirs reaches anyone. */
  declineAsk(helperId: string, askId: string): void {
    const { row } = this.openAskFor(helperId, askId);
    this.db.prepare(`UPDATE asks SET state = 'declined', question_for_agent = 0 WHERE id = ?`).run(askId);
    this.event(row.asker_id, 'ask.declined', askId);
    this.audit(helperId, 'web', 'ask.decline', askId);
  }

  /** The asker takes the question back: it leaves the other person's page and their agent's inbox. */
  withdrawAsk(askerId: string, askId: string): void {
    const result = this.db.prepare(`UPDATE asks SET state = 'withdrawn', question_for_agent = 0 WHERE id = ? AND asker_id = ? AND state = 'open'`).run(askId, askerId);
    if (!result.changes) throw new KlatschError('forbidden', ASK.notOpen);
    this.audit(askerId, 'web', 'ask.withdraw', askId);
  }

  /** The questions a person asked and was asked, for their own Home, while they last and the two share a private circle. */
  asksOf(userId: string): AskView[] {
    const rows = this.db
      .prepare(`SELECT * FROM asks WHERE (asker_id = ? OR helper_id = ?) AND state != 'withdrawn' AND expires_at > ? ORDER BY created_at DESC`)
      .all(userId, userId, Date.now()) as NonNullable<ReturnType<Klatsch['askRow']>>[];
    return rows
      .filter((row) => this.sharePrivateCircle(row.asker_id, row.helper_id))
      .map((row) => {
        const asker = row.asker_id === userId;
        const other = this.user(asker ? row.helper_id : row.asker_id);
        return {
          id: row.id,
          role: asker ? ('asker' as const) : ('helper' as const),
          other: { name: other.display_name, handle: other.handle },
          tags: JSON.parse(row.tags) as string[],
          question: row.question,
          answer: row.answer,
          tried: row.answer_failed === 1,
          state: row.state,
          createdAt: row.created_at,
        };
      });
  }

  /** The question or answer for an agent, once, cleaned and labelled, while it may still be read. */
  private deliverAsk(userId: string, askId: string, answer: boolean, auto: boolean): InboxEvent | undefined {
    const row = this.askRow(askId);
    const mine = answer ? row?.asker_id === userId && row.answer_for_agent === 1 && row.state === 'answered' : row?.helper_id === userId && row.question_for_agent === 1 && row.state === 'open';
    if (!row || !mine || row.expires_at <= Date.now() || !this.sharePrivateCircle(row.asker_id, row.helper_id)) return undefined;
    this.db.prepare(`UPDATE asks SET ${answer ? 'answer_for_agent' : 'question_for_agent'} = 0 WHERE id = ?`).run(askId);
    const from = agentHandle(this.user(answer ? row.helper_id : row.asker_id).handle);
    if (!from) return undefined;
    this.audit(userId, 'mcp', 'ask.deliver', askId);
    return {
      kind: answer ? 'ask.answer' : 'ask.question',
      ref: askId,
      at: new Date().toISOString(),
      type: 'quote',
      from,
      quote: cleanQuote(answer ? (row.answer ?? '') : row.question),
      text: askQuoteLine(from, answer, auto),
      note: ASK_QUOTE_NOTE(from, answer && row.answer_failed === 1),
    };
  }

  rejectSip(userId: string, sipId: string): void {
    this.ownDraft(userId, sipId);
    this.db.prepare(`UPDATE sips SET state = 'rejected' WHERE id = ?`).run(sipId);
    this.audit(userId, 'web', 'sip.reject', sipId);
  }

  retireSip(userId: string, sipId: string): void {
    transaction(this.db, () => {
      const result = this.db
        .prepare(`UPDATE sips SET state = 'retired' WHERE id = ? AND user_id = ? AND state = 'approved'`)
        .run(sipId, userId);
      if (!result.changes) throw new KlatschError('not-found', 'No such approved sip.');
      // Quotes of it that no agent has read yet go with it.
      this.dropQuotes('sip_id = ?', sipId);
      this.db.prepare('DELETE FROM sip_vectors WHERE sip_id = ?').run(sipId);
      this.audit(userId, 'web', 'sip.retire', sipId);
    });
  }

  /** Turns semantic matching on (the operator's choice), or off. `settled` lets a test wait for the background work. */
  useEmbedder(embedder: Embedder | undefined): void {
    this.embedder = embedder;
  }

  get semanticOn(): boolean {
    return Boolean(this.embedder);
  }

  /** Resolves when no embedding is running. */
  async semanticSettled(): Promise<void> {
    while (this.embedding) await this.embedding;
  }

  /**
   * After a looking or solved sip was approved, in the background (a tool call never waits for a model): its
   * summary becomes a vector, and sips of the other kind that say something close get a match, as if they had
   * shared a tag. Only ever between sips a human approved, so no agent's search can probe what people wrote, and
   * only through a private circle both sips were shared in and both people are in: in a public circle a stranger
   * could use it as an oracle. Fails quietly: tags keep working.
   */
  private embedLater(sipId: string, summary: string): void {
    const { embedder } = this;
    if (!embedder) return;
    const work = (this.embedding ?? Promise.resolve())
      .then(() => embedder.embed(summary))
      .then((vector) => this.matchByMeaning(sipId, embedder.model, vector))
      .catch(() => console.error('[klatsch] semantic matching failed for one sip; tags still match.'))
      .finally(() => {
        if (this.embedding === work) this.embedding = undefined;
      });
    this.embedding = work;
  }

  private matchByMeaning(sipId: string, model: string, vector: Float32Array): void {
    const now = Date.now();
    const notified = transaction(this.db, () => {
      // What can no longer be read is no longer compared.
      this.db.prepare(`DELETE FROM sip_vectors WHERE sip_id IN (SELECT id FROM sips WHERE state != 'approved' OR (expires_at IS NOT NULL AND expires_at <= ?))`).run(now);
      const sip = this.db.prepare(`SELECT * FROM sips WHERE id = ? AND state = 'approved' AND (expires_at IS NULL OR expires_at > ?)`).get(sipId, now) as SipRow | undefined;
      if (!sip) return [];
      this.db.prepare('INSERT OR REPLACE INTO sip_vectors (sip_id, model, vector, created_at) VALUES (?, ?, ?, ?)').run(sipId, model, sealText(this.db, Buffer.from(toBlob(vector)).toString('base64')), now);
      const looking = sip.status === 'looking';
      if (!looking && sip.status !== 'solved') return [];
      const rows = this.db
        .prepare(
          `SELECT o.id, o.user_id, o.failed, v.vector FROM sip_vectors v JOIN sips o ON o.id = v.sip_id
           WHERE v.model = ? AND o.state = 'approved' AND o.status = ? AND o.user_id != ?
             AND (o.expires_at IS NULL OR o.expires_at > ?)
             AND EXISTS (SELECT 1 FROM sip_circles a JOIN sip_circles b ON b.circle_id = a.circle_id AND b.sip_id = o.id
               JOIN circles c ON c.id = a.circle_id AND c.public = 0
               JOIN memberships ma ON ma.circle_id = a.circle_id AND ma.user_id = ?
               JOIN memberships mb ON mb.circle_id = a.circle_id AND mb.user_id = o.user_id
               WHERE a.sip_id = ?)`,
        )
        .all(model, looking ? 'solved' : 'looking', sip.user_id, now, sip.user_id, sipId) as { id: string; user_id: string; failed: number; vector: string }[];
      const close = rows
        .map((row) => ({ ...row, score: similarity(vector, fromBlob(Buffer.from(row.vector, 'base64'))) }))
        .filter((row) => row.score >= SEMANTIC_THRESHOLD)
        .sort((a, b) => b.score - a.score)
        .slice(0, SEMANTIC_MAX_MATCHES);
      const told: { userId: string; solved: boolean }[] = [];
      for (const row of close) {
        const [seekerId, lookingId, solvedId] = looking ? [sip.user_id, sipId, row.id] : [row.user_id, row.id, sipId];
        const solvedTags = this.tagsOf(solvedId);
        const match = this.upsertMatch(seekerId, solvedId, solvedTags, lookingId);
        if (!match.created && !match.backed) continue;
        const delivered = match.backed && this.noteFound(seekerId, match.id, false, 'web');
        if (match.created && !delivered) this.event(seekerId, 'match.new', match.id);
        if (match.created) told.push({ userId: seekerId, solved: (looking ? row.failed : sip.failed) !== 1 });
        this.audit(seekerId, 'web', 'match.semantic', match.id);
      }
      return told;
    });
    for (const { userId, solved } of notified) this.notifyUser(userId, solved ? notifications.match : notifications.other);
  }

  /** The author says their note still holds: its date moves on, and Home stops asking for a while. */
  confirmSip(userId: string, sipId: string): void {
    const result = this.db
      .prepare(`UPDATE sips SET checked_at = ? WHERE id = ? AND user_id = ? AND state = 'approved' AND status = 'solved'`)
      .run(Date.now(), sipId, userId);
    if (!result.changes) throw new KlatschError('not-found', 'No such note.');
    this.audit(userId, 'web', 'sip.confirm', sipId);
  }

  sipsOf(userId: string): (SipRow & { tags: string[] })[] {
    const rows = this.db
      .prepare(`SELECT s.*, EXISTS (SELECT 1 FROM sip_circles sc WHERE sc.sip_id = s.id AND sc.feed = 1) AS in_feed FROM sips s WHERE s.user_id = ? AND s.state IN ('draft', 'approved') ORDER BY s.created_at DESC`)
      .all(userId) as unknown as SipRow[];
    return rows.map((row) => ({ ...row, tags: this.tagsOf(row.id) }));
  }

  private ownDraft(userId: string, sipId: string): SipRow {
    const sip = this.db.prepare(`SELECT * FROM sips WHERE id = ? AND user_id = ? AND state = 'draft'`).get(sipId, userId) as
      | SipRow
      | undefined;
    if (!sip) throw new KlatschError('not-found', 'No such draft.');
    return sip;
  }

  private tagsOf(sipId: string): string[] {
    const rows = this.db.prepare('SELECT slug FROM sip_tags WHERE sip_id = ? ORDER BY slug').all(sipId) as { slug: string }[];
    return rows.map((r) => r.slug);
  }

  // ---------- matching ----------

  private expand(slugs: string[]): string[] {
    return [...new Set(slugs.flatMap((slug) => relatedTags(this.db, slug)))];
  }

  /**
   * Approved, unexpired `solved` sips of other people that share a related tag, through a circle of the sip both
   * are in; with `lookingSipId`, only through a circle that looking sip was shared in too. Without it (an agent's
   * own search), only through a private circle: a public one is searched only through a looking sip the human
   * shared there.
   */
  private solvedFor(seekerId: string, slugs: string[], lookingSipId?: string): { sipId: string; tags: string[]; tried: boolean }[] {
    const expanded = this.expand(slugs);
    if (!expanded.length) return [];
    const rows = this.db
      .prepare(
        `SELECT s.id AS sip_id, s.failed, group_concat(st.slug) AS tags
         FROM sips s JOIN sip_tags st ON st.sip_id = s.id
         WHERE s.state = 'approved' AND s.status = 'solved' AND s.user_id != ? AND ${lookingSipId ? jointScope('?', '?') : inScope('?', true)}
           AND (s.expires_at IS NULL OR s.expires_at > ?)
           AND st.slug IN (${expanded.map(() => '?').join(', ')})
         GROUP BY s.id
         ORDER BY s.failed, count(*) DESC, s.approved_at DESC
         LIMIT ${MAX_MATCHES}`,
      )
      .all(seekerId, ...(lookingSipId ? [lookingSipId] : []), seekerId, Date.now(), ...expanded) as { sip_id: string; failed: number; tags: string }[];
    return rows.map((r) => ({ sipId: r.sip_id, tags: r.tags.split(',').sort(), tried: r.failed === 1 }));
  }

  /**
   * Returns the match id, whether it is new, and whether `seekerSipId` (the seeker's approved looking sip,
   * when their human's share made the match) backs it for the first time. A search by an agent passes none.
   */
  private upsertMatch(seekerId: string, sipId: string, tags: string[], seekerSipId?: string): { id: string; created: boolean; backed: boolean } {
    const existing = this.db.prepare('SELECT id, seeker_sip_id FROM matches WHERE seeker_id = ? AND sip_id = ?').get(seekerId, sipId) as
      | { id: string; seeker_sip_id: string | null }
      | undefined;
    if (existing) {
      if (seekerSipId) this.db.prepare('UPDATE matches SET seeker_sip_id = ? WHERE id = ?').run(seekerSipId, existing.id);
      return { id: existing.id, created: false, backed: Boolean(seekerSipId) && existing.seeker_sip_id === null };
    }
    const id = newId('m');
    this.db
      .prepare('INSERT INTO matches (id, seeker_id, sip_id, tags, seeker_sip_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, seekerId, sipId, JSON.stringify(tags), seekerSipId ?? null, Date.now());
    return { id, created: true, backed: Boolean(seekerSipId) };
  }

  /** Creates matches for a freshly approved sip; returns the users that got a new match, and whether one is a real fix. */
  private matchApprovedSip(sip: SipRow): { userId: string; solved: boolean }[] {
    const tags = this.tagsOf(sip.id);
    const notified = new Map<string, boolean>();
    if (sip.status === 'looking') {
      for (const candidate of this.solvedFor(sip.user_id, tags, sip.id)) {
        const match = this.upsertMatch(sip.user_id, candidate.sipId, candidate.tags, sip.id);
        // Their own share found it: no wake (the agent that shared gets the result in the same call).
        const delivered = match.backed && this.noteFound(sip.user_id, match.id, true, 'web');
        if (match.created) {
          if (!delivered) this.event(sip.user_id, 'match.new', match.id, true);
          notified.set(sip.user_id, Boolean(notified.get(sip.user_id)) || !candidate.tried);
        }
      }
    }
    // Mirrors solvedFor: seekers whose looking sip was shared in a circle of this one, where both are still members.
    if (sip.status === 'solved') {
      const expanded = this.expand(tags);
      const seekers = this.db
        .prepare(
          // Per seeker, the matching looking sip that lasts longest (SQLite takes s.id from the max row).
          `SELECT s.user_id, s.id, max(coalesce(s.expires_at, 9e15))
           FROM sips s JOIN sip_tags st ON st.sip_id = s.id
           WHERE s.state = 'approved' AND s.status = 'looking' AND s.user_id != ?
             AND EXISTS (SELECT 1 FROM sip_circles sc JOIN sip_circles lc ON lc.circle_id = sc.circle_id AND lc.sip_id = s.id
               JOIN memberships a ON a.circle_id = sc.circle_id AND a.user_id = ? JOIN memberships b ON b.circle_id = sc.circle_id AND b.user_id = s.user_id
               WHERE sc.sip_id = ?)
             AND (s.expires_at IS NULL OR s.expires_at > ?)
             AND st.slug IN (${expanded.map(() => '?').join(', ')})
           GROUP BY s.user_id`,
        )
        .all(sip.user_id, sip.user_id, sip.id, Date.now(), ...expanded) as { user_id: string; id: string }[];
      const solverTags = new Set(tags);
      for (const { user_id: seekerId, id: lookingId } of seekers) {
        const matched = this.expand(this.lookingTagsOf(seekerId)).filter((slug) => solverTags.has(slug));
        const match = this.upsertMatch(seekerId, sip.id, matched.length ? matched.sort() : tags, lookingId);
        const delivered = match.backed && this.noteFound(seekerId, match.id, false, 'web');
        if (match.created) {
          if (!delivered) this.event(seekerId, 'match.new', match.id);
          notified.set(seekerId, sip.failed !== 1);
        }
      }
    }
    return [...notified].map(([userId, solved]) => ({ userId, solved }));
  }

  private lookingTagsOf(userId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT st.slug FROM sips s JOIN sip_tags st ON st.sip_id = s.id
         WHERE s.user_id = ? AND s.state = 'approved' AND s.status = 'looking'`,
      )
      .all(userId) as { slug: string }[];
    return rows.map((r) => r.slug);
  }

  /**
   * The seeker's human's share just backed a match on a note they may read without an intro: its author
   * gets a count (no wake, no name; the event names only the author's own sip, once until read), and if
   * the seeker chose to always get this author's notes, the note goes to their agent. True when the note
   * went (or had gone) to the agent, so the caller sends no separate match news.
   */
  private noteFound(seekerId: string, matchId: string, ownAction: boolean, via: Via): boolean {
    const note = this.visibleNotes(seekerId, { matchId })[0];
    if (!note) return false;
    if (!this.db.prepare(`SELECT 1 FROM events WHERE user_id = ? AND kind = 'note.seen' AND ref = ? AND read_at IS NULL`).get(note.userId, note.sipId)) {
      this.event(note.userId, 'note.seen', note.sipId);
    }
    return note.sends && this.autoQuote(seekerId, note.userId, note.sipId, note.summary, null, ownAction, via);
  }

  /**
   * Notes `userId` may read without an intro: approved, unexpired `solved` sips on a match their human's own
   * approved, unexpired looking sip backs (a search by their agent is not enough), in a circle both sips were
   * shared in and both people are still in, that the author opened there, or allowed this person always in that
   * very circle (the one their intro happened in) for notes approved since then with one of the intro's tags.
   */
  visibleNotes(userId: string, only: { sipId?: string; matchId?: string } = {}): NoteView[] {
    const now = Date.now();
    const rows = this.db
      .prepare(
        `SELECT s.id AS sip_id, m.id AS match_id, m.tags, s.summary, s.user_id, s.failed, coalesce(s.checked_at, s.approved_at) AS as_of, u.handle, u.display_name, s.source_url, s.source_title, s.source_author,
                EXISTS (SELECT 1 FROM grants d WHERE d.grantor_id = m.seeker_id AND d.grantee_id = s.user_id AND d.kind = 'deliver' AND d.revoked_at IS NULL) AS sends,
                EXISTS (SELECT 1 FROM thanks t WHERE t.from_user_id = m.seeker_id AND t.sip_id = s.id) AS thanked,
                (SELECT c.name FROM sip_circles sc JOIN sip_circles lc ON lc.circle_id = sc.circle_id AND lc.sip_id = m.seeker_sip_id
                   JOIN circles c ON c.id = sc.circle_id JOIN memberships a ON a.circle_id = sc.circle_id AND a.user_id = s.user_id
                   JOIN memberships b ON b.circle_id = sc.circle_id AND b.user_id = m.seeker_id
                 WHERE sc.sip_id = s.id ORDER BY c.public, c.name LIMIT 1) AS circle
         FROM matches m JOIN sips s ON s.id = m.sip_id JOIN users u ON u.id = s.user_id
         WHERE m.seeker_id = ? AND s.user_id != m.seeker_id AND s.state = 'approved' AND s.status = 'solved'
           AND (s.expires_at IS NULL OR s.expires_at > ?)
           AND EXISTS (SELECT 1 FROM sips q WHERE q.id = m.seeker_sip_id AND q.state = 'approved' AND (q.expires_at IS NULL OR q.expires_at > ?))
           AND (${jointScope('m.seeker_sip_id', 'm.seeker_id', ' AND sc.open = 1')} OR EXISTS (
             SELECT 1 FROM grants g WHERE g.grantor_id = s.user_id AND g.grantee_id = m.seeker_id AND g.kind = 'show' AND g.revoked_at IS NULL
               AND s.approved_at >= g.created_at AND ${jointScope('m.seeker_sip_id', 'm.seeker_id', ' AND sc.circle_id = g.circle_id')}
               AND EXISTS (SELECT 1 FROM sip_tags gt JOIN json_each(g.tags) j ON j.value = gt.slug WHERE gt.sip_id = s.id)))
           AND (? IS NULL OR s.id = ?) AND (? IS NULL OR m.id = ?)
         ORDER BY s.approved_at DESC`,
      )
      .all(userId, now, now, only.sipId ?? null, only.sipId ?? null, only.matchId ?? null, only.matchId ?? null) as {
      sip_id: string;
      match_id: string;
      tags: string;
      summary: string;
      user_id: string;
      failed: number;
      as_of: number;
      handle: string;
      display_name: string;
      sends: number;
      thanked: number;
      circle: string;
      source_url: string | null;
      source_title: string | null;
      source_author: string | null;
    }[];
    return rows.map((r) => {
      const source = sourceOfRow(r);
      return {
        sipId: r.sip_id,
        matchId: r.match_id,
        tags: JSON.parse(r.tags),
        summary: r.summary,
        userId: r.user_id,
        handle: r.handle,
        displayName: r.display_name,
        sends: Boolean(r.sends),
        thanked: Boolean(r.thanked),
        circle: r.circle,
        tried: r.failed === 1,
        asOf: r.as_of,
        ...(source ? { source } : {}),
      };
    });
  }

  /**
   * The Notes page: what people in the reader's private circles chose to show there, newest first, with their
   * names. Only ever in the human's web session: no tool reads it, and reading it tells nobody anything. Each note
   * needs its author's tick in a private circle both are still in, and to be open, approved and not expired.
   */
  feedNotes(userId: string, only: { sipId?: string } = {}): NoteView[] {
    const rows = this.db
      .prepare(
        `SELECT s.id AS sip_id, s.summary, s.user_id, s.failed, coalesce(s.checked_at, s.approved_at) AS as_of, u.handle, u.display_name, s.source_url, s.source_title, s.source_author,
                EXISTS (SELECT 1 FROM thanks t WHERE t.from_user_id = ? AND t.sip_id = s.id) AS thanked,
                (SELECT CASE WHEN c.pair = 1 THEN 'friends' ELSE c.name END FROM sip_circles sc JOIN circles c ON c.id = sc.circle_id AND c.public = 0
                   JOIN memberships a ON a.circle_id = sc.circle_id AND a.user_id = s.user_id
                   JOIN memberships b ON b.circle_id = sc.circle_id AND b.user_id = ?
                 WHERE sc.sip_id = s.id AND sc.feed = 1 AND sc.open = 1 ORDER BY c.name LIMIT 1) AS circle
         FROM sips s JOIN users u ON u.id = s.user_id
         WHERE s.user_id != ? AND s.state = 'approved' AND s.status = 'solved' AND (s.expires_at IS NULL OR s.expires_at > ?) AND (? IS NULL OR s.id = ?)
         ORDER BY s.approved_at DESC`,
      )
      .all(userId, userId, userId, Date.now(), only.sipId ?? null, only.sipId ?? null) as {
      sip_id: string;
      summary: string;
      user_id: string;
      failed: number;
      as_of: number;
      handle: string;
      display_name: string;
      thanked: number;
      circle: string | null;
      source_url: string | null;
      source_title: string | null;
      source_author: string | null;
    }[];
    return rows
      .filter((r) => r.circle !== null)
      .slice(0, FEED_NOTES)
      .map((r) => {
        const source = sourceOfRow(r);
        return {
          sipId: r.sip_id,
          matchId: '',
          tags: this.tagsOf(r.sip_id),
          summary: r.summary,
          userId: r.user_id,
          handle: r.handle,
          displayName: r.display_name,
          sends: false,
          thanked: Boolean(r.thanked),
          circle: r.circle!,
          tried: r.failed === 1,
          asOf: r.as_of,
          ...(source ? { source } : {}),
        };
      });
  }

  /**
   * The search (the agent's, or the one a human's approved share runs). Circle matches carry tags and a
   * templated reason only, never another person's text; a note open to the seeker on a match their human's
   * share backs adds its author's handle and where the note is (`open` says so even without a usable
   * handle). A search alone backs nothing: it reveals no handle, shows nothing on the human's page, counts
   * nothing for the author and delivers nothing. Your own sips come back in full: an LLM may read your own data.
   */
  findMatches(
    userId: string,
    inputTags: string[],
    via: Via = 'mcp',
    lookingSipId?: string,
  ): {
    matches: { match_id: string; tags: string[]; reason: string; from?: string; note?: string; open: boolean; outcome?: 'did-not-work' }[];
    own: { sip_id: string; status: SipStatus; tags: string[]; summary: string }[];
    unknown: UnknownTag[];
  } {
    const { resolved, unknown } = resolveTags(this.db, inputTags);
    const matches = transaction(this.db, () =>
      this.solvedFor(userId, resolved, lookingSipId).map((candidate) => {
        const match = this.upsertMatch(userId, candidate.sipId, candidate.tags);
        const reason = matchReason(candidate.tags.join(', '), candidate.tried);
        const outcome = candidate.tried ? { outcome: 'did-not-work' as const } : {};
        const note = this.visibleNotes(userId, { matchId: match.id })[0];
        if (!note) return { match_id: match.id, tags: candidate.tags, reason, open: false, ...outcome };
        const from = agentHandle(note.handle);
        const sent =
          note.sends &&
          this.db.prepare('SELECT 1 FROM handoffs WHERE user_id = ? AND sip_id = ? AND auto = 1 AND text IS NOT NULL').get(userId, candidate.sipId);
        const where = !from ? openNoteUnnamed(candidate.tried) : sent ? sentNote(from, candidate.tried) : openNote(from, candidate.tried);
        return { match_id: match.id, tags: candidate.tags, reason, ...(from ? { from } : {}), note: where, open: true, ...outcome };
      }),
    );
    const expanded = this.expand(resolved);
    const own = expanded.length
      ? (this.db
          .prepare(
            `SELECT DISTINCT s.id, s.status, s.failed, s.summary FROM sips s JOIN sip_tags st ON st.sip_id = s.id
             WHERE s.user_id = ? AND s.state = 'approved' AND st.slug IN (${expanded.map(() => '?').join(', ')})
             ORDER BY s.approved_at DESC LIMIT ${MAX_MATCHES}`,
          )
          .all(userId, ...expanded) as { id: string; status: SipStatus; failed: number; summary: string }[])
      : [];
    // The query itself is not stored; only the number of results is audited.
    this.audit(userId, via, 'matches.find', String(matches.length));
    return {
      matches,
      own: own.map((s) => ({ sip_id: s.id, status: s.failed ? ('tried' as const) : s.status, tags: this.tagsOf(s.id), summary: s.summary })),
      unknown,
    };
  }

  /** True if this token may search again: at most `SEARCHES_PER_HOUR` per token per hour. */
  allowSearch(tokenId: string): boolean {
    const now = Date.now();
    const recent = (this.searches.get(tokenId) ?? []).filter((at) => at > now - HOUR);
    if (recent.length >= SEARCHES_PER_HOUR) return false;
    recent.push(now);
    this.searches.set(tokenId, recent);
    return true;
  }

  // ---------- intros ----------

  /**
   * Runs once the seeker's human approved the request (decideApproval). It
   * needs an approved `looking` sip on the match's topic, which the solver's
   * human reads before deciding.
   */
  requestIntro(userId: string, matchId: string): { introId: string; state: IntroState } {
    const match = this.liveMatch(userId, matchId);
    if (this.visibleNotes(userId, { matchId }).length) throw new KlatschError('invalid', consent.noIntroNeeded);
    const existing = this.db.prepare('SELECT id, state FROM intros WHERE match_id = ?').get(matchId) as
      | { id: string; state: IntroState }
      | undefined;
    if (existing) return { introId: existing.id, state: existing.state };
    const seekerSipId = this.approvedLookingSip(userId, JSON.parse(match.tags), match.sip_id);
    if (!seekerSipId) throw this.noLookingSip(userId, JSON.parse(match.tags));
    const introId = newId('i');
    const now = Date.now();
    const { solverId } = this.introFor(userId, introId, matchId);
    transaction(this.db, () => {
      this.db
        .prepare(`INSERT INTO intros (id, match_id, state, seeker_sip_id, created_at, updated_at) VALUES (?, ?, 'awaiting-solver', ?, ?, ?)`)
        .run(introId, matchId, seekerSipId, now, now);
      this.audit(userId, 'web', 'intro.awaiting-solver', introId);
      this.event(solverId, 'intro.requested', introId);
    });
    this.notifyUser(solverId, notifications.other);
    return { introId, state: 'awaiting-solver' };
  }

  /** A match counts only while both people are still in a circle of the solved sip. */
  private liveMatch(userId: string, matchId: string): { id: string; tags: string; sip_id: string } {
    const match = this.db
      .prepare(`SELECT m.id, m.tags, m.sip_id FROM matches m JOIN sips s ON s.id = m.sip_id WHERE m.id = ? AND m.seeker_id = ? AND ${inScope('m.seeker_id')}`)
      .get(matchId, userId) as { id: string; tags: string; sip_id: string } | undefined;
    if (!match) throw new KlatschError('not-found', 'No such match.');
    return match;
  }

  /**
   * The solver allows the intro. With `always`, the seeker also reads the solver's future matching notes
   * without asking (a standing grant, revocable in Settings). Either side that chose to always get the
   * other's notes gets the other's sip in their agent now.
   */
  approveIntro(userId: string, introId: string, via: Via = 'web', always = false): IntroState {
    const intro = this.introFor(userId, introId);
    if (intro.state !== 'awaiting-solver' || intro.solverId !== userId) throw new KlatschError('forbidden', 'This intro is not waiting for you.');
    transaction(this.db, () => {
      const now = Date.now();
      this.db.prepare(`UPDATE intros SET state = 'accepted', updated_at = ?, accepted_at = ? WHERE id = ?`).run(now, now, introId);
      this.audit(userId, via, 'intro.accepted', introId);
      if (always) this.grant(userId, intro.seekerId, 'show', via, this.introOf(userId, introId).tags, this.introCircle(introId)?.id ?? null);
      for (const id of [intro.seekerId, intro.solverId]) {
        this.event(id, 'intro.accepted', introId, id === userId);
        this.notifyUser(id, notifications.other);
      }
      for (const id of [intro.seekerId, intro.solverId]) {
        const other = this.introOf(id, introId).other;
        if (other?.shared && other.sipId && this.hasGrant(id, other.userId, 'deliver')) {
          this.autoQuote(id, other.userId, other.sipId, other.summary, introId, id === userId, via);
        }
      }
    });
    return 'accepted';
  }

  /**
   * The circle an intro happened in: one both sips were shared in and both people are in (a private one first).
   * An "allow always" given on it holds only there.
   */
  private introCircle(introId: string): { id: string; name: string } | undefined {
    return this.db
      .prepare(
        `SELECT sc.circle_id AS id, c.name FROM intros i JOIN matches m ON m.id = i.match_id JOIN sips s ON s.id = m.sip_id
           JOIN sip_circles sc ON sc.sip_id = s.id JOIN sip_circles lc ON lc.circle_id = sc.circle_id AND lc.sip_id = i.seeker_sip_id
           JOIN circles c ON c.id = sc.circle_id
           JOIN memberships a ON a.circle_id = sc.circle_id AND a.user_id = s.user_id JOIN memberships b ON b.circle_id = sc.circle_id AND b.user_id = m.seeker_id
         WHERE i.id = ? ORDER BY c.public, c.name LIMIT 1`,
      )
      .get(introId) as { id: string; name: string } | undefined;
  }

  declineIntro(userId: string, introId: string, via: Via = 'web'): void {
    const intro = this.introFor(userId, introId);
    if (intro.state === 'accepted' || intro.state === 'declined') throw new KlatschError('forbidden', 'This intro is already closed.');
    transaction(this.db, () => {
      this.db.prepare(`UPDATE intros SET state = 'declined', updated_at = ? WHERE id = ?`).run(Date.now(), introId);
      this.audit(userId, via, 'intro.decline', introId);
      if (intro.state === 'awaiting-solver' && userId === intro.solverId) this.event(intro.seekerId, 'intro.declined', introId);
    });
  }

  private introFor(
    userId: string,
    introId: string,
    pendingMatchId?: string,
  ): { state: IntroState; seekerId: string; solverId: string; matchId: string } {
    const row = (
      pendingMatchId
        ? this.db
            .prepare(
              `SELECT NULL AS state, m.seeker_id, s.user_id AS solver_id, m.id AS match_id
               FROM matches m JOIN sips s ON s.id = m.sip_id WHERE m.id = ?`,
            )
            .get(pendingMatchId)
        : this.db
            .prepare(
              `SELECT i.state, m.seeker_id, s.user_id AS solver_id, m.id AS match_id
               FROM intros i JOIN matches m ON m.id = i.match_id JOIN sips s ON s.id = m.sip_id
               WHERE i.id = ?`,
            )
            .get(introId)
    ) as { state: IntroState; seeker_id: string; solver_id: string; match_id: string } | undefined;
    if (!row || (row.seeker_id !== userId && row.solver_id !== userId)) throw new KlatschError('not-found', 'No such intro.');
    return { state: row.state, seekerId: row.seeker_id, solverId: row.solver_id, matchId: row.match_id };
  }

  /**
   * For the human web UI only. The solver's human reads the seeker's sip
   * before deciding; names appear only once both people have accepted.
   */
  introsOf(userId: string): IntroView[] {
    const rows = this.db
      .prepare(
        `SELECT i.id, i.state, i.accepted_at, m.tags, m.seeker_id, s.user_id AS solver_id,
                s.id AS solver_sip, s.summary AS solver_summary, s.state AS solver_state, s.expires_at AS solver_expires,
                s.source_url, s.source_title, s.source_author,
                q.id AS seeker_sip, q.summary AS seeker_summary, q.state AS seeker_state, q.expires_at AS seeker_expires
         FROM intros i JOIN matches m ON m.id = i.match_id JOIN sips s ON s.id = m.sip_id
         LEFT JOIN sips q ON q.id = i.seeker_sip_id
         WHERE m.seeker_id = ? OR s.user_id = ?
         ORDER BY i.updated_at DESC`,
      )
      .all(userId, userId) as {
      id: string;
      state: IntroState;
      accepted_at: number | null;
      tags: string;
      seeker_id: string;
      solver_id: string;
      solver_sip: string;
      solver_summary: string;
      solver_state: string;
      solver_expires: number | null;
      source_url: string | null;
      source_title: string | null;
      source_author: string | null;
      seeker_sip: string | null;
      seeker_summary: string | null;
      seeker_state: string | null;
      seeker_expires: number | null;
    }[];
    const now = Date.now();
    return rows.map((row) => {
      const role = row.seeker_id === userId ? 'seeker' : 'solver';
      const seekerSummary = row.seeker_summary ?? '';
      const view: IntroView = { id: row.id, state: row.state, role, tags: JSON.parse(row.tags) };
      if (role === 'solver') {
        const circle = row.state === 'awaiting-solver' ? this.introCircle(row.id)?.name : undefined;
        view.request = { summary: seekerSummary, ...(circle ? { circle } : {}) };
      }
      if (row.state === 'accepted') {
        const otherId = role === 'seeker' ? row.solver_id : row.seeker_id;
        const other = this.user(otherId);
        const [sipId, summary, state, expires] =
          role === 'seeker'
            ? [row.solver_sip, row.solver_summary, row.solver_state, row.solver_expires]
            : [row.seeker_sip, seekerSummary, row.seeker_state, row.seeker_expires];
        const visibleUntil = (row.accepted_at ?? 0) + this.config.connectedTextHours * HOUR;
        // Readable for a while after the acceptance, and only while the sip is still on the card and a circle
        // still backs the intro (both sips shared there, both people in it); after that only the names stay.
        const shared = now < visibleUntil && state === 'approved' && (expires === null || expires > now) && sipId !== null && Boolean(this.introCircle(row.id));
        // Only the solved sip carries a link card.
        const source = shared && role === 'seeker' ? sourceOfRow(row) : undefined;
        view.other = {
          handle: other.handle,
          displayName: other.display_name,
          summary: shared ? summary : '',
          shared,
          visibleUntil,
          userId: otherId,
          sipId,
          sends: this.hasGrant(userId, otherId, 'deliver'),
          thanked: Boolean(this.db.prepare('SELECT 1 FROM thanks WHERE from_user_id = ? AND intro_id = ?').get(userId, row.id)),
          canThank: this.shareCircle(userId, otherId),
          ...(source ? { source } : {}),
        };
        view.mine = { summary: role === 'seeker' ? seekerSummary : row.solver_summary };
      }
      return view;
    });
  }

  introForMatch(userId: string, matchId: string): { id: string; state: IntroState } | undefined {
    return this.db
      .prepare('SELECT i.id, i.state FROM intros i JOIN matches m ON m.id = i.match_id WHERE m.id = ? AND m.seeker_id = ?')
      .get(matchId, userId) as { id: string; state: IntroState } | undefined;
  }

  /** One intro as the human sees it (dialogs and web UI). */
  introOf(userId: string, introId: string): IntroView {
    const intro = this.introsOf(userId).find((i) => i.id === introId);
    if (!intro) throw new KlatschError('not-found', 'No such intro.');
    return intro;
  }

  /** What the seeker will share with the solver if the intro goes out. */
  /** `openNote` is the refusal for a note already open to the seeker: the agent's words, or the human's on the page. */
  seekerPreview(userId: string, matchId: string, openNote: string = NO_INTRO_NEEDED): { tags: string[]; summary: string } {
    const match = this.liveMatch(userId, matchId);
    if (this.visibleNotes(userId, { matchId }).length) throw new KlatschError('invalid', openNote);
    const tags = JSON.parse(match.tags) as string[];
    const sipId = this.approvedLookingSip(userId, tags, match.sip_id);
    if (!sipId) throw this.noLookingSip(userId, tags);
    const sip = this.db.prepare('SELECT summary FROM sips WHERE id = ?').get(sipId) as { summary: string };
    return { tags, summary: sip.summary };
  }

  /**
   * Why an intro cannot go out: no approved looking sip on these tags at all, or none shared in a circle where
   * the solved note is (the human kept it to other circles; it is never sent elsewhere). Says which, plainly.
   */
  private noLookingSip(userId: string, tags: string[]): KlatschError {
    const expanded = this.expand(tags);
    const any =
      expanded.length > 0 &&
      this.db
        .prepare(
          `SELECT 1 FROM sips s JOIN sip_tags st ON st.sip_id = s.id WHERE s.user_id = ? AND s.status = 'looking' AND s.state = 'approved'
             AND (s.expires_at IS NULL OR s.expires_at > ?) AND st.slug IN (${expanded.map(() => '?').join(', ')})`,
        )
        .get(userId, Date.now(), ...expanded);
    return new KlatschError('invalid', any ? NOT_SHARED_THERE : NO_LOOKING_SIP);
  }

  /**
   * The seeker's approved looking sip on these tags that the solver may read: one shared in a circle the solved
   * sip `solvedSipId` was shared in, where both are still members. A looking sip kept to other circles never goes.
   */
  private approvedLookingSip(userId: string, tags: string[], solvedSipId: string): string | undefined {
    const expanded = this.expand(tags);
    // The looking sip that made this match also counts: a semantic match shares no tag with it.
    const made = this.db.prepare('SELECT seeker_sip_id FROM matches WHERE seeker_id = ? AND sip_id = ?').get(userId, solvedSipId) as { seeker_sip_id: string | null } | undefined;
    if (!expanded.length && !made?.seeker_sip_id) return undefined;
    const row = this.db
      .prepare(
        `SELECT s.id FROM sips s JOIN sip_tags st ON st.sip_id = s.id
         WHERE s.user_id = ? AND s.status = 'looking' AND s.state = 'approved'
           AND (s.expires_at IS NULL OR s.expires_at > ?)
           AND EXISTS (SELECT 1 FROM sip_circles lc JOIN sip_circles sc ON sc.circle_id = lc.circle_id AND sc.sip_id = ?
             JOIN sips o ON o.id = sc.sip_id JOIN memberships a ON a.circle_id = lc.circle_id AND a.user_id = s.user_id
             JOIN memberships b ON b.circle_id = lc.circle_id AND b.user_id = o.user_id WHERE lc.sip_id = s.id)
           AND (s.id = ? OR st.slug IN (${expanded.map(() => '?').join(', ')}))
         ORDER BY s.approved_at DESC LIMIT 1`,
      )
      .get(userId, Date.now(), solvedSipId, made?.seeker_sip_id ?? null, ...expanded) as { id: string } | undefined;
    return row?.id;
  }

  // ---------- inbox ----------

  /** Unread counts by kind, without marking anything read: for the per-prompt reminder. */
  /** Counts of what waits, and the handles of people an intro now connects the human with. */
  pending(userId: string): PendingCounts {
    const rows = this.db
      .prepare(`SELECT kind, count(*) AS n FROM events WHERE user_id = ? AND read_at IS NULL GROUP BY kind`)
      .all(userId) as { kind: string; n: number }[];
    const count = (kind: string) => rows.find((r) => r.kind === kind)?.n ?? 0;
    const accepted = this.db.prepare(`SELECT ref FROM events WHERE user_id = ? AND read_at IS NULL AND kind = 'intro.accepted' ORDER BY id`).all(userId) as {
      ref: string;
    }[];
    // At most ten: the reminder is one line, and the hook refuses more.
    const connectedWith = accepted.map((row) => this.connectedWith(userId, row.ref)).filter((h): h is string => Boolean(h)).slice(0, 10);
    const senders = this.db
      .prepare(
        `SELECT DISTINCT u.handle FROM events e JOIN handoffs h ON h.id = e.ref JOIN users u ON u.id = h.from_user_id
         WHERE e.user_id = ? AND e.read_at IS NULL AND e.kind = 'quote.received'`,
      )
      .all(userId) as { handle: string }[];
    const quotesFrom = senders.map((row) => agentHandle(row.handle)).filter((h): h is string => Boolean(h)).slice(0, 10);
    // Notes, not people: the event names only the author's own sip. Never who.
    const notesMatched = (
      this.db.prepare(`SELECT count(DISTINCT ref) AS n FROM events WHERE user_id = ? AND read_at IS NULL AND kind = 'note.seen'`).get(userId) as { n: number }
    ).n;
    return {
      matches: count('match.new'),
      introRequests: count('intro.requested'),
      introsAccepted: count('intro.accepted'),
      connectedWith,
      quotes: count('quote.received'),
      quotesFrom,
      notesMatched,
      asks: count('ask.received') + count('ask.answered') + count('ask.declined') + count('ask.question') + count('ask.answer'),
    };
  }

  /**
   * The human sends the other person's sip from an accepted intro to their own agent: one of the two ways
   * another person's free text reaches an agent, and only by a click in the human's web session (no tool
   * asks for it). Only while the sip is readable (see `IntroView.other`). With `always`, that person's
   * future notes go to the agent too (see `autoQuote`).
   */
  sendQuote(userId: string, introId: string, always = false): { from: string } {
    const other = this.introsOf(userId).find((i) => i.id === introId && i.state === 'accepted')?.other;
    if (!other?.shared || !other.sipId) throw new KlatschError('forbidden', handoff.notConnected);
    return this.handOff(userId, other.userId, other.sipId, other.summary, introId, always);
  }

  /** The same for a note open to the human without an intro (see `visibleNotes`). */
  sendNote(userId: string, sipId: string, always = false): { from: string } {
    // A note on the Notes page goes once, by this click. "Always" stays with notes that matched what the person shared.
    const note = this.visibleNotes(userId, { sipId })[0] ?? (always ? undefined : this.feedNotes(userId, { sipId })[0]);
    if (!note) throw new KlatschError('forbidden', consent.notVisible);
    return this.handOff(userId, note.userId, sipId, note.summary, null, always);
  }

  /**
   * The text is cleaned and snapshot now, delivered once by `inbox` with a label, then cleared. A second
   * click before the agent read the first changes nothing, except that `always` still records the grant.
   * Over the hourly cap nothing happens at all, "always" included: one click has one outcome, and the
   * refusal says so.
   */
  private handOff(userId: string, fromId: string, sipId: string, summary: string, introId: string | null, always: boolean): { from: string } {
    this.forgetOldQuotes();
    const text = cleanQuote(summary);
    if (!text) throw new KlatschError('forbidden', handoff.notConnected);
    const from = this.user(fromId).handle;
    return transaction(this.db, () => {
      if (always) this.grant(userId, fromId, 'deliver', 'web');
      if (this.db.prepare('SELECT 1 FROM handoffs WHERE user_id = ? AND sip_id = ? AND text IS NOT NULL').get(userId, sipId)) return { from };
      if (this.quotesLastHour(userId) >= QUOTES_PER_HOUR) throw new KlatschError('forbidden', always ? consent.tooManyAlways : handoff.tooMany);
      const id = newId('q');
      const source = this.sourceOf(sipId);
      this.db
        .prepare(
          'INSERT INTO handoffs (id, user_id, from_user_id, intro_id, sip_id, text, source_url, source_title, source_author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, userId, fromId, introId, sipId, sealText(this.db, text), sealOptional(this.db, source?.url), sealOptional(this.db, source?.title), sealOptional(this.db, source?.author), Date.now());
      this.audit(userId, 'web', 'quote.send', id);
      this.event(userId, 'quote.received', id);
      return { from };
    });
  }

  /**
   * A note that just became readable for `userId`, from someone whose notes they chose to always get: it
   * goes to their agent like a quote they sent, without the click. Once per note and reader, within the
   * same hourly cap as clicks (beyond it the note stays on the page only). Audited. True if it went now or before.
   */
  private autoQuote(userId: string, fromId: string, sipId: string, summary: string, introId: string | null, ownAction: boolean, via: Via): boolean {
    if (this.db.prepare('SELECT 1 FROM handoffs WHERE user_id = ? AND sip_id = ?').get(userId, sipId)) return true;
    const text = cleanQuote(summary);
    if (!text || this.quotesLastHour(userId) >= QUOTES_PER_HOUR) return false;
    const id = newId('q');
    const source = this.sourceOf(sipId);
    this.db
      .prepare(
        'INSERT INTO handoffs (id, user_id, from_user_id, intro_id, sip_id, text, source_url, source_title, source_author, auto, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
      )
      .run(id, userId, fromId, introId, sipId, sealText(this.db, text), sealOptional(this.db, source?.url), sealOptional(this.db, source?.title), sealOptional(this.db, source?.author), Date.now());
    this.audit(userId, via, 'quote.auto', id);
    this.event(userId, 'quote.received', id, ownAction);
    return true;
  }

  /** A sip's link card, snapshot with its text when it is handed to an agent. */
  private sourceOf(sipId: string): Source | undefined {
    const row = this.db.prepare('SELECT source_url, source_title, source_author FROM sips WHERE id = ?').get(sipId) as
      | { source_url: string | null; source_title: string | null; source_author: string | null }
      | undefined;
    return row && sourceOfRow(row);
  }

  private quotesLastHour(userId: string): number {
    return (this.db.prepare('SELECT count(*) AS n FROM handoffs WHERE user_id = ? AND created_at > ?').get(userId, Date.now() - HOUR) as { n: number }).n;
  }

  // ---------- standing grants ----------

  /**
   * `show` (one per allowed intro, with its `tags` and the `circle` it happened in): the grantee reads the
   * grantor's notes approved from now on that carry one of those tags and are shared in that circle, without an intro. `deliver`: the grantee's readable notes go to the
   * grantor's agent without a click; granting it again changes nothing. Per person, never for a whole circle; made
   * only by the grantor's click in their web session, never by a tool.
   */
  private grant(grantorId: string, granteeId: string, kind: GrantView['kind'], via: Via, tags: string[] = [], circle: string | null = null): void {
    if (kind === 'deliver' && this.hasGrant(grantorId, granteeId, kind)) return;
    const id = newId('g');
    this.db
      .prepare('INSERT INTO grants (id, grantor_id, grantee_id, kind, tags, circle_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, grantorId, granteeId, kind, kind === 'show' ? JSON.stringify(tags) : null, kind === 'show' ? circle : null, Date.now());
    this.audit(grantorId, via, `grant.${kind}`, id);
  }

  private hasGrant(grantorId: string, granteeId: string, kind: GrantView['kind']): boolean {
    return Boolean(
      this.db.prepare('SELECT 1 FROM grants WHERE grantor_id = ? AND grantee_id = ? AND kind = ? AND revoked_at IS NULL').get(grantorId, granteeId, kind),
    );
  }

  /** The live grants a person gave, for their Settings page. */
  grantsOf(userId: string): GrantView[] {
    const rows = this.db
      .prepare(
        `SELECT g.id, g.kind, g.tags, g.created_at, u.handle, u.display_name, c.name AS circle FROM grants g JOIN users u ON u.id = g.grantee_id
         LEFT JOIN circles c ON c.id = g.circle_id
         WHERE g.grantor_id = ? AND g.revoked_at IS NULL ORDER BY g.created_at, u.handle`,
      )
      .all(userId) as { id: string; kind: GrantView['kind']; tags: string | null; created_at: number; handle: string; display_name: string; circle: string | null }[];
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      tags: r.tags ? JSON.parse(r.tags) : [],
      circle: r.circle,
      handle: r.handle,
      displayName: r.display_name,
      createdAt: r.created_at,
    }));
  }

  /** Only the grantor revokes, at once: quotes not yet read that depended on the grant are dropped with it. */
  revokeGrant(userId: string, grantId: string): void {
    transaction(this.db, () => {
      const grant = this.db
        .prepare('SELECT grantee_id, kind FROM grants WHERE id = ? AND grantor_id = ? AND revoked_at IS NULL')
        .get(grantId, userId) as { grantee_id: string; kind: GrantView['kind'] } | undefined;
      if (!grant) throw new KlatschError('not-found', consent.notGranted);
      // show: the grantee read the grantor's notes; deliver: the grantor's agent got the grantee's.
      this.endGrant(grantId, grant.kind === 'show' ? grant.grantee_id : userId, grant.kind === 'show' ? userId : grant.grantee_id, grant.kind);
      this.audit(userId, 'web', 'grant.revoke', grantId);
    });
  }

  /**
   * Ends a grant and drops the quotes not yet read that depended on it: for `deliver`, the automatic ones;
   * for `show`, those of open-note hand-offs (not intro ones) whose note the reader can no longer read.
   * A quote the human sent once of a note still readable to them stays.
   */
  private endGrant(grantId: string, reader: string, author: string, kind: GrantView['kind']): void {
    this.db.prepare('UPDATE grants SET revoked_at = ? WHERE id = ?').run(Date.now(), grantId);
    if (kind === 'deliver') return this.dropQuotes('user_id = ? AND from_user_id = ? AND auto = 1', reader, author);
    const waiting = this.db
      .prepare('SELECT id, sip_id FROM handoffs WHERE user_id = ? AND from_user_id = ? AND intro_id IS NULL AND text IS NOT NULL AND delivered_at IS NULL')
      .all(reader, author) as { id: string; sip_id: string }[];
    for (const q of waiting) if (!this.visibleNotes(reader, { sipId: q.sip_id }).length && !this.feedNotes(reader, { sipId: q.sip_id }).length) this.dropQuotes('id = ?', q.id);
  }

  /** Quotes no agent read: cleared (and their events dropped) for `where` on handoffs. */
  private dropQuotes(where: string, ...params: (string | number)[]): void {
    const ids = (this.db.prepare(`SELECT id FROM handoffs WHERE delivered_at IS NULL AND text IS NOT NULL AND ${where}`).all(...params) as { id: string }[]).map((r) => r.id);
    for (const id of ids) {
      this.db.prepare('UPDATE handoffs SET text = NULL, source_url = NULL, source_title = NULL, source_author = NULL WHERE id = ?').run(id);
      this.db.prepare(`DELETE FROM events WHERE kind = 'quote.received' AND ref = ? AND read_at IS NULL`).run(id);
    }
  }

  /** A quote no agent read within seven days is cleared. */
  private forgetOldQuotes(): void {
    this.dropQuotes('created_at < ?', Date.now() - 7 * DAY);
  }

  /** The other person's `@handle` once both accepted intro `introId`; nothing before, and never a name or text. */
  connectedWith(userId: string, introId: string): string | undefined {
    const intro = this.introsOf(userId).find((i) => i.id === introId);
    return intro?.state === 'accepted' ? agentHandle(intro.other?.handle) : undefined;
  }

  /**
   * Rendered from templates, from ids, tags and handles. The one exception is a quote the human sent from
   * their web page: delivered here once, in its own `quote` field with a label, then cleared. Reading and
   * delivering happen in one transaction, so a quote is never both marked read and lost.
   */
  inbox(userId: string): InboxEvent[] {
    this.forgetOldQuotes();
    return transaction(this.db, () => {
      const rows = this.db
        .prepare(`SELECT id, kind, ref, created_at FROM events WHERE user_id = ? AND read_at IS NULL AND kind != 'sip.draft' ORDER BY id`)
        .all(userId) as { id: number; kind: string; ref: string; created_at: number }[];
      if (rows.length) {
        this.db.prepare('UPDATE events SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id <= ?').run(Date.now(), userId, rows.at(-1)!.id);
      }
      this.audit(userId, 'mcp', 'inbox.read', String(rows.length));
      return rows.flatMap((row): InboxEvent[] => {
        const at = new Date(row.created_at).toISOString();
        if (row.kind === 'ask.question' || row.kind === 'ask.answer') {
          // An event the person caused (their click) does not wake; one a standing "always" brought does.
          const auto = Boolean((this.db.prepare('SELECT wakes FROM events WHERE id = ?').get(row.id) as { wakes: number } | undefined)?.wakes);
          const delivered = this.deliverAsk(userId, row.ref, row.kind === 'ask.answer', auto);
          return delivered ? [delivered] : [];
        }
        if (row.kind.startsWith('ask.')) {
          const ask = this.askRow(row.ref);
          const otherId = ask && (ask.asker_id === userId ? ask.helper_id : ask.asker_id);
          const other = otherId ? agentHandle(this.user(otherId).handle) : undefined;
          return [{ kind: row.kind, ref: row.ref, text: this.render(row.kind, row.ref, other), at, ...(other ? { with: other } : {}) }];
        }
        if (row.kind === 'quote.received') {
          const quote = this.deliverQuote(userId, row.ref);
          if (!quote) return [];
          const linked = Boolean(quote.source);
          return [
            {
              kind: row.kind,
              ref: row.ref,
              at,
              type: 'quote',
              from: quote.from,
              quote: quote.text,
              text: quoteLine(quote.from, quote.auto, linked),
              note: QUOTE_NOTE(quote.from, quote.auto, linked, quote.tried),
              ...(quote.asOf ? { as_of: quote.asOf } : {}),
              ...(quote.source ? { source: quote.source } : {}),
            },
          ];
        }
        const other =
          row.kind === 'intro.accepted'
            ? this.connectedWith(userId, row.ref)
            : row.kind === 'match.new'
              ? agentHandle(this.visibleNotes(userId, { matchId: row.ref })[0]?.handle)
              : undefined;
        return [{ kind: row.kind, ref: row.ref, text: this.render(row.kind, row.ref, other), at, ...(other ? { with: other } : {}) }];
      });
    });
  }

  /**
   * One-shot: hands the quote's text, and its link card if it has one, to the agent once, then clears both.
   * The title and author are cleaned like the text; the link was checked when it was written.
   */
  private deliverQuote(userId: string, handoffId: string): { from: string; text: string; auto: boolean; tried: boolean; asOf?: string; source?: Source } | undefined {
    const row = this.db
      .prepare(
        `SELECT h.text, h.auto, h.source_url, h.source_title, h.source_author, u.handle,
                EXISTS (SELECT 1 FROM sips s WHERE s.id = h.sip_id AND s.failed = 1) AS tried,
                (SELECT coalesce(s.checked_at, s.approved_at) FROM sips s WHERE s.id = h.sip_id) AS as_of
         FROM handoffs h JOIN users u ON u.id = h.from_user_id
         WHERE h.id = ? AND h.user_id = ? AND h.text IS NOT NULL`,
      )
      .get(handoffId, userId) as
      | { text: string; auto: number; source_url: string | null; source_title: string | null; source_author: string | null; handle: string; tried: number; as_of: number | null }
      | undefined;
    const from = agentHandle(row?.handle);
    this.db
      .prepare('UPDATE handoffs SET text = NULL, source_url = NULL, source_title = NULL, source_author = NULL, delivered_at = ? WHERE id = ? AND user_id = ?')
      .run(Date.now(), handoffId, userId);
    if (!row || !from) return undefined;
    this.audit(userId, 'mcp', 'quote.deliver', handoffId);
    const stored = sourceOfRow(row);
    const title = stored && clip(cleanQuote(stored.title), SOURCE_TITLE_MAX);
    const author = stored?.author && clip(cleanQuote(stored.author), SOURCE_AUTHOR_MAX);
    const source = stored && title ? { url: stored.url, title, ...(author ? { author } : {}) } : undefined;
    return { from, text: row.text, auto: Boolean(row.auto), tried: Boolean(row.tried), ...(row.as_of ? { asOf: new Date(row.as_of).toISOString().slice(0, 10) } : {}), ...(source ? { source } : {}) };
  }

  private render(kind: string, ref: string, other?: string): string {
    const tried = kind === 'match.new' && Boolean(this.db.prepare('SELECT 1 FROM matches m JOIN sips s ON s.id = m.sip_id WHERE m.id = ? AND s.failed = 1').get(ref));
    return inboxText(kind, ref, this.tagsForRef(kind, ref), `${this.config.publicUrl}/ui`, other, tried);
  }

  private tagsForRef(kind: string, ref: string): string {
    let raw: string | undefined;
    if (kind === 'note.seen') {
      // The author's own sip: its own tags.
      const tags = this.tagsOf(ref);
      raw = tags.length ? JSON.stringify(tags) : undefined;
    } else if (kind.startsWith('match.')) {
      raw = (this.db.prepare('SELECT tags FROM matches WHERE id = ?').get(ref) as { tags: string } | undefined)?.tags;
    } else if (kind.startsWith('ask.')) {
      raw = (this.db.prepare('SELECT tags FROM asks WHERE id = ?').get(ref) as { tags: string } | undefined)?.tags;
    } else if (kind.startsWith('intro.')) {
      raw = (
        this.db.prepare('SELECT m.tags FROM intros i JOIN matches m ON m.id = i.match_id WHERE i.id = ?').get(ref) as
          | { tags: string }
          | undefined
      )?.tags;
    }
    return raw ? (JSON.parse(raw) as string[]).join(', ') : 'a topic';
  }

  // ---------- thanks ----------

  /**
   * "Thanks, this helped" for a note that reached the human: one open or allowed to them now, or one a quote
   * brought to their agent (sent once, or always), while they still share a circle with its author. By a
   * click in their web session (the agent's own path is `agentThankNote`). Once per note: a second click
   * changes nothing.
   */
  thankNote(userId: string, sipId: string): void {
    const author = (this.db.prepare('SELECT user_id FROM sips WHERE id = ?').get(sipId) as { user_id: string } | undefined)?.user_id;
    if (author === userId) throw new KlatschError('forbidden', thanks.self);
    const received =
      author !== undefined &&
      (this.visibleNotes(userId, { sipId }).length > 0 ||
        this.feedNotes(userId, { sipId }).length > 0 ||
        Boolean(this.db.prepare('SELECT 1 FROM handoffs WHERE user_id = ? AND from_user_id = ? AND sip_id = ?').get(userId, author, sipId)));
    if (!received || !this.shareCircle(userId, author)) throw new KlatschError('forbidden', thanks.notReceived);
    this.thank(userId, author, sipId, null, 'human');
    // A click on a note the agent already thanked makes that thanks the human's own: final, no longer undoable.
    const claimed = this.db.prepare(`UPDATE thanks SET given_by = 'human' WHERE from_user_id = ? AND sip_id = ? AND given_by = 'agent'`).run(userId, sipId);
    if (claimed.changes) this.audit(userId, 'web', 'thanks.confirm', sipId);
  }

  /**
   * The agent's thanks, for a note a quote brought it (`quoteId`: the quote's ref in its inbox) and it
   * read, while the two still share a circle. Anything else gets the web path's refusal, so an id tells
   * nothing. Only while the human allows it, never again for a note whose agent thanks they undid, and at
   * most AGENT_THANKS_PER_DAY in 24 hours (undone ones included), which bounds what an injected instruction
   * can do. Shares the once-per-note row with the human's click. True if it was given now.
   */
  agentThankNote(userId: string, quoteId: string): boolean {
    if (!this.user(userId).agent_thanks) throw new KlatschError('forbidden', THANKS.off);
    const quote = this.db
      .prepare('SELECT from_user_id, sip_id FROM handoffs WHERE id = ? AND user_id = ? AND delivered_at IS NOT NULL')
      .get(quoteId, userId) as { from_user_id: string; sip_id: string } | undefined;
    if (!quote || !this.shareCircle(userId, quote.from_user_id)) throw new KlatschError('forbidden', thanks.notReceived);
    return transaction(this.db, () => {
      if (this.db.prepare('SELECT 1 FROM thanks_undone WHERE user_id = ? AND sip_id = ?').get(userId, quote.sip_id)) throw new KlatschError('forbidden', THANKS.undone);
      if (this.db.prepare('SELECT 1 FROM thanks WHERE from_user_id = ? AND sip_id = ?').get(userId, quote.sip_id)) return false;
      if (this.agentThanksLastDay(userId) >= AGENT_THANKS_PER_DAY) throw new KlatschError('forbidden', THANKS.tooMany);
      this.thank(userId, quote.from_user_id, quote.sip_id, null, 'agent');
      return true;
    });
  }

  private agentThanksLastDay(userId: string): number {
    const since = Date.now() - DAY;
    const given = this.db.prepare(`SELECT count(*) AS n FROM thanks WHERE from_user_id = ? AND given_by = 'agent' AND created_at > ?`).get(userId, since) as { n: number };
    const undone = this.db.prepare('SELECT count(*) AS n FROM thanks_undone WHERE user_id = ? AND thanked_at > ?').get(userId, since) as { n: number };
    return given.n + undone.n;
  }

  /**
   * Every thanks the person's agent gave in the last seven days, newest first, for Home. No cap: each must
   * stay undoable, and the daily limit keeps them to at most 70.
   */
  agentThanksOf(userId: string): AgentThanksView[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.sip_id, u.display_name, u.handle FROM thanks t JOIN users u ON u.id = t.to_user_id
         WHERE t.from_user_id = ? AND t.given_by = 'agent' AND t.created_at > ? ORDER BY t.created_at DESC, t.rowid DESC`,
      )
      .all(userId, Date.now() - 7 * DAY) as { id: string; sip_id: string; display_name: string; handle: string }[];
    return rows.map((r) => ({ id: r.id, displayName: r.display_name, handle: r.handle, tags: this.tagsOf(r.sip_id) }));
  }

  /**
   * The human takes back a thanks their agent gave: the row goes (the author's count drops) and the note is
   * remembered, so the agent cannot thank for it again; the human's own click still can. A thanks the human
   * gave is not undone here.
   */
  undoAgentThanks(userId: string, thanksId: string): void {
    transaction(this.db, () => {
      const row = this.db
        .prepare(`SELECT sip_id, created_at FROM thanks WHERE id = ? AND from_user_id = ? AND given_by = 'agent'`)
        .get(thanksId, userId) as { sip_id: string; created_at: number } | undefined;
      if (!row) throw new KlatschError('not-found', thanks.notUndoable);
      this.db.prepare('DELETE FROM thanks WHERE id = ?').run(thanksId);
      this.db
        .prepare('INSERT INTO thanks_undone (user_id, sip_id, thanked_at, undone_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING')
        .run(userId, row.sip_id, row.created_at, Date.now());
      this.audit(userId, 'web', 'thanks.undo', thanksId);
    });
  }

  /** "Not now" to the passkey offer on Home: it is not shown again. */
  dismissPasskeyOffer(userId: string): void {
    if (this.user(userId).passkey_offer_dismissed_at !== null) return;
    this.db.prepare('UPDATE users SET passkey_offer_dismissed_at = ? WHERE id = ?').run(Date.now(), userId);
    this.audit(userId, 'web', 'passkey.offer.dismiss');
  }

  /** "Not now" to Home's offer of notifications: it is not shown again (Settings still has them). */
  dismissPushOffer(userId: string): void {
    if (this.user(userId).push_offer_dismissed_at !== null) return;
    this.db.prepare('UPDATE users SET push_offer_dismissed_at = ? WHERE id = ?').run(Date.now(), userId);
    this.audit(userId, 'web', 'push.offer.dismiss');
  }

  /** Whether the person's agent may say thanks for them; on unless they turn it off. */
  setAgentThanks(userId: string, on: boolean): void {
    if (on === Boolean(this.user(userId).agent_thanks)) return;
    this.db.prepare('UPDATE users SET agent_thanks = ? WHERE id = ?').run(on ? 1 : 0, userId);
    this.audit(userId, 'web', on ? 'thanks.agent.on' : 'thanks.agent.off');
  }

  /** The same for an intro both accepted, to the other person in it, while the two still share a circle. */
  thankIntro(userId: string, introId: string): void {
    const other = this.introsOf(userId).find((i) => i.id === introId && i.state === 'accepted')?.other;
    if (!other?.canThank) throw new KlatschError('forbidden', thanks.notReceived);
    this.thank(userId, other.userId, null, introId, 'human');
  }

  private thank(fromId: string, toId: string, sipId: string | null, introId: string | null, by: 'human' | 'agent'): void {
    const id = newId('t');
    const added = this.db
      // Only the once-per-note/intro indexes may swallow a second click; a self-thanks still fails its CHECK.
      .prepare('INSERT INTO thanks (id, from_user_id, to_user_id, sip_id, intro_id, given_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
      .run(id, fromId, toId, sipId, introId, by, Date.now());
    if (added.changes) this.audit(fromId, by === 'agent' ? 'mcp' : 'web', 'thanks.give', id);
  }

  /**
   * How many people thanked `userId` (by their own click or their agent's): distinct people this calendar
   * month (UTC) and since they joined. For their own pages only, numbers without names; no tool reads it.
   */
  helped(userId: string): { month: number; total: number } {
    const now = new Date();
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const row = this.db
      .prepare(
        `SELECT count(DISTINCT CASE WHEN created_at >= ? THEN from_user_id END) AS month, count(DISTINCT from_user_id) AS total
         FROM thanks WHERE to_user_id = ?`,
      )
      .get(monthStart, userId) as { month: number; total: number };
    return { month: row.month, total: row.total };
  }

  /** Turns the public badge on (a new random id each time) or off (the id is gone, so the old link stops). */
  setBadge(userId: string, on: boolean): void {
    if (on && !this.inAnyCircle(userId)) throw new KlatschError('forbidden', thanks.noCircle);
    if (on === (this.user(userId).badge_id !== null)) return;
    this.db.prepare('UPDATE users SET badge_id = ? WHERE id = ?').run(on ? randomToken(16) : null, userId);
    this.audit(userId, 'web', on ? 'badge.on' : 'badge.off');
  }

  /** The number a badge shows, or nothing for an id that is unknown, turned off, or of someone in no circle. */
  badgeCount(badgeId: string): number | undefined {
    if (!BADGE_ID.test(badgeId)) return undefined;
    const row = this.db.prepare('SELECT id FROM users WHERE badge_id = ?').get(badgeId) as { id: string } | undefined;
    return row && this.inAnyCircle(row.id) ? this.helped(row.id).total : undefined;
  }

  private shareCircle(a: string, b: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM memberships x JOIN memberships y ON x.circle_id = y.circle_id WHERE x.user_id = ? AND y.user_id = ?').get(a, b));
  }

  // ---------- plumbing ----------

  /** `ownAction`: the person caused it themselves, so it does not wake their watch (see WAKES). */
  private event(userId: string, kind: string, ref: string, ownAction = false): void {
    const wakes = (WAKES as readonly string[]).includes(kind) && !ownAction;
    this.db.prepare('INSERT INTO events (user_id, kind, ref, created_at, wakes) VALUES (?, ?, ?, ?, ?)').run(userId, kind, ref, Date.now(), wakes ? 1 : 0);
    // News an agent may be watching for; told after the commit, like a notification, and only as counts.
    // A failure here is logged and never undoes the action or stops what else runs after the commit.
    if (wakes) {
      afterCommit(this.db, () => {
        try {
          completeWatches(this.db, userId, this.watchText(userId));
        } catch (error) {
          console.error(`[klatsch] completing watches failed: ${String(error)}`);
        }
      });
    }
  }

  /** What a completed watch tells the agent: the reminder, counts and handles only, and to listen again. */
  watchText(userId: string): string {
    const reminder = pendingReminder(this.pending(userId));
    return `${reminder || WATCH.quiet} ${WATCH.again}`;
  }

  audit(userId: string | null, via: Via, action: string, ref?: string): void {
    this.db.prepare('INSERT INTO audit (ts, user_id, via, action, ref) VALUES (?, ?, ?, ?, ?)').run(Date.now(), userId, via, action, ref ?? null);
  }

  /** Sent after the surrounding transaction commits, so nobody hears about something that was rolled back. */
  notifyUser(userId: string, message: string): void {
    const user = this.user(userId);
    afterCommit(this.db, () => this.notify({ id: user.id, handle: user.handle }, message));
  }
}

/**
 * Deletes the rows of `table` whose `column` is one of `values`, and first whatever refers to them, following
 * the schema's foreign keys: a row that must have its parent goes too, an optional reference is cleared.
 * Every `id` of a deleted row is added to `removed`, so references kept as plain text (event refs) can go after.
 */
function purge(db: Db, table: string, column: string, values: readonly unknown[], removed: Set<string>, depth = 0): void {
  if (!values.length) return;
  if (depth > 12) throw new Error(`purge: references nest too deep at ${table}`);
  const list = JSON.stringify(values);
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]).map((t) => t.name);
  for (const child of tables) {
    const keys = db.prepare(`SELECT "from", "to", "table" FROM pragma_foreign_key_list(?)`).all(child) as { from: string; to: string | null; table: string }[];
    for (const key of keys) {
      if (key.table !== table || (key.to ?? 'id') !== column) continue;
      const info = db.prepare(`SELECT "notnull" FROM pragma_table_info(?) WHERE name = ?`).get(child, key.from) as { notnull: number };
      if (!info.notnull && !(child === table && key.from === column)) {
        db.prepare(`UPDATE "${child}" SET "${key.from}" = NULL WHERE "${key.from}" IN (SELECT value FROM json_each(?))`).run(list);
        continue;
      }
      if (child === table) continue;
      // Columns of `child` that other tables point at: their values lead to the next rows to go.
      const targets = new Set<string>();
      for (const other of tables) {
        for (const k of db.prepare(`SELECT "to", "table" FROM pragma_foreign_key_list(?)`).all(other) as { to: string | null; table: string }[]) {
          if (k.table === child) targets.add(k.to ?? 'id');
        }
      }
      const columns = (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(child) as { name: string }[]).map((c) => c.name);
      if (columns.includes('id')) targets.add('id');
      for (const target of targets) {
        const rows = db.prepare(`SELECT DISTINCT "${target}" AS v FROM "${child}" WHERE "${key.from}" IN (SELECT value FROM json_each(?)) AND "${target}" IS NOT NULL`).all(list) as { v: unknown }[];
        purge(db, child, target, rows.map((r) => r.v), removed, depth + 1);
      }
      if (columns.includes('id')) {
        for (const r of db.prepare(`SELECT id FROM "${child}" WHERE "${key.from}" IN (SELECT value FROM json_each(?))`).all(list) as { id: unknown }[]) removed.add(String(r.id));
      }
      db.prepare(`DELETE FROM "${child}" WHERE "${key.from}" IN (SELECT value FROM json_each(?))`).run(list);
    }
  }
  if (column === 'id') for (const v of values) removed.add(String(v));
  db.prepare(`DELETE FROM "${table}" WHERE "${column}" IN (SELECT value FROM json_each(?))`).run(list);
}
