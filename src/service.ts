import { randomBytes } from 'node:crypto';
import { hashPassword, newReviewPassword, passwordMatches } from './auth/review.ts';
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
import { ATTACH, ASK, ASKAROUND, FILE_ONLY, GUEST, HOW_MAX, HOW_NOTE, MESSAGE, ROOM, VOICE_NOTE, ASK_QUOTE_NOTE, askQuoteLine, AGENT_THANKS_PER_DAY, inboxText, matchReason, NO_INTRO_NEEDED, openNote, openNoteUnnamed, pendingReminder, SEARCHES_PER_HOUR, QUOTE_NOTE, quoteLine, sentNote, THANKS, WATCH, type PendingCounts } from './copy/agent.ts';
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
import { afterCommit, openBytes, sealBytes, sealOptional, sealText, transaction, useSealer, type Db } from './store/db.ts';
import { ATTACHMENT_BYTES_PER_DAY, ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_SIDE, cleanName, sniff } from './attachments.ts';
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

/** Where an action came from; 'dialog' is a decision in a chat app's card or dialog. */
export type Via = 'mcp' | 'web' | 'cli' | 'dialog';

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
  | { action: 'answer_ask'; from: { name: string; handle: string }; tags: string[]; question: string; answer: string; tried: boolean; flags: Flag[] }
  | { action: 'send_message'; to: { name: string; handle: string }; text: string; flags: Flag[] };

/** A conversation with one friend, for the person's own page or card. */
export interface ConversationView {
  circleId: string;
  other: { name: string; handle: string };
  /** The friend's messages the person has not read yet. */
  unread: number;
  /** The person chose to always let their agent read this friend's words. */
  sends: boolean;
  messages: { id: string; mine: boolean; text: string; at: number; read: boolean; files: { id: string; name: string; mime: string; size: number }[]; starred: boolean; pinned: boolean; deleted: boolean }[];
  /** The message pinned in this conversation, if any: both people see it at the top. */
  pinned?: { id: string; text: string; deleted: boolean };
}
/** A room of a circle, with how many messages the person has not read. */
export interface RoomView {
  id: string;
  name: string;
  /** Only hosts write here. */
  announce: boolean;
  unread: number;
}
/** A circle as a community: its rooms, the person's place in it, and what its hosts set. */
export interface CircleSpace {
  id: string;
  name: string;
  people: number;
  public: boolean;
  owner: boolean;
  host: boolean;
  rules: string | null;
  /** The person still has to accept the rules before writing. */
  mustAccept: boolean;
  /** What the person hears from this circle. */
  notify: 'all' | 'mentions' | 'none';
  /** Listed in Explore by its owner, with a line about it. */
  listed: boolean;
  about: string | null;
  slowSeconds: number;
  /** The person may not write until then (a host's timeout). */
  timeoutUntil: number | null;
  rooms: RoomView[];
}
export interface RoomMessageView {
  id: string;
  mine: boolean;
  from: { name: string; handle: string };
  text: string;
  at: number;
  deleted: boolean;
  files: { id: string; name: string; mime: string; size: number }[];
}
export interface RoomReportView {
  id: string;
  messageId: string;
  roomId: string;
  text: string;
  from: { name: string; handle: string };
  reporter: { name: string; handle: string };
  reason: string | null;
  at: number;
}
/** A question in a circle's Ask around, as a list shows it. */
export interface QuestionSummary {
  id: string;
  title: string;
  author: { name: string; handle: string };
  mine: boolean;
  answers: number;
  solved: boolean;
  /** One of the circle's Picks. */
  picked: boolean;
  at: number;
}
export interface AnswerView {
  id: string;
  author: { name: string; handle: string };
  mine: boolean;
  text: string;
  at: number;
  helped: number;
  helpedByMe: boolean;
  solved: boolean;
}
export interface QuestionView extends QuestionSummary {
  circleId: string;
  body: string | null;
  answerList: AnswerView[];
  canDelete: boolean;
}
/** A circle listed in Explore, as someone outside it sees it. */
export interface ListedCircle {
  id: string;
  name: string;
  about: string | null;
  people: number;
  /** The person asked to join and waits. */
  asked: boolean;
}
export interface JoinRequestView {
  userId: string;
  name: string;
  handle: string;
  at: number;
}
/** A message the person starred, for their own list of starred messages. */
export interface StarredView {
  id: string;
  other: { name: string; handle: string };
  mine: boolean;
  text: string;
  at: number;
}
export interface ConversationSummary {
  circleId: string;
  other: { name: string; handle: string };
  unread: number;
  last?: { mine: boolean; text: string; at: number; deleted?: boolean };
}

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
  /** Files with it: names, types and sizes, never the bytes. */
  attachments: { id: string; side: 'question' | 'answer'; name: string; mime: string; size: number }[];
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
/** A message between friends: longer than a question, still one message. */
export const MESSAGE_MAX = 2000;
const MESSAGES_PER_DAY = 200;
const MESSAGE_DAYS = 90;
/** How long after sending its sender may delete a message for everyone. */
const DELETE_FOR_EVERYONE_MS = 2 * DAY;
/** Rooms: one message's length, how many a person writes in a day across rooms, and a new member's first day without links. */
const ROOM_MESSAGE_MAX = 2000;
const ROOM_MESSAGES_PER_DAY = 300;
const NEW_MEMBER_MS = DAY;
const ROOMS_PER_CIRCLE = 20;
const RULES_MAX = 2000;
/** Ask around: a question's title and details, and an answer. */
const QUESTION_TITLE_MAX = 200;
const QUESTION_BODY_MAX = 4000;
const ANSWER_BODY_MAX = 4000;
const QUESTIONS_PER_DAY = 20;
const ATTACHMENT_DAYS = 14;
/** How many of the friend's messages one "Brew a reply" hands over. */
const THREAD_FOR_AGENT = 10;
/** The demo friend of a review account: answers at once, and always has one question waiting. */
const DEMO_HANDLE = 'klatsch-demo';
/** Handles nobody can pick: the demo friend's, and names that would look like Klatsch speaking. */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([DEMO_HANDLE, 'klatsch', 'admin', 'support', 'review']);
/** Every guest's handle starts with this, so nobody else can pick one that looks like a guest. */
const GUEST_PREFIX = 'guest-';
/** Whether nobody may pick `handle`: a reserved one, or one that looks like a guest's. */
export const reservedHandle = (handle: string) => RESERVED_HANDLES.has(handle) || handle.startsWith(GUEST_PREFIX);
/**
 * Guests ("Try it without an account"): how long one lasts (from the click, never renewed), how many live at once
 * on a relay, and what one may do in that time. A guest's only friend is the demo friend.
 */
export const GUEST_HOURS = 5;
const GUEST_LIVE_MAX = 300;
const GUEST_MESSAGES = 30;
const GUEST_ASKS = 5;
/** A guest's voice notes, together, in a day. */
const GUEST_VOICE_BYTES_PER_DAY = 5 * 1024 * 1024;
/** Friend links a guest may make in all: enough to try it with a friend or two. */
const GUEST_LINKS = 3;
/**
 * What the demo friend says. It plays a friend, not Klatsch: it writes back about what was written to it, so a
 * reviewer sees what Klatsch is for (a plan made in a chat reaching a friend, a friend's opinion coming back).
 * Fixed lines picked by a few words, no model, so every review sees the same thing.
 */
const DEMO = {
  /** Its question waiting for the reviewer: a real one between friends. */
  question: 'Are we still on for the hike on Sunday? I can drive if you want, just tell me when to pick you up.',
  /** The conversation a review account starts with, oldest first; the last line, the demo friend's, is unread. */
  history: [
    { demo: true, text: 'Thanks again for the book tip! I finished it on the train this morning.', hoursAgo: 50 },
    { demo: false, text: 'So glad you liked it! Tell me what you read next.', hoursAgo: 49 },
    { demo: true, text: 'Hey! Free on Saturday? It has been too long. Maybe a museum? You pick, I am in for anything.', hoursAgo: 3 },
  ],
  /** What it writes back once its question (the hike) is answered. */
  answered(text: string): string {
    if (/\b(no|not|can't|cannot|can’t|sorry|another time)\b/i.test(text)) return 'No worries, another time! Let me know when you are free.';
    return 'Great! I will pick you up at 9:00. Bring a jacket, it gets windy at the top.';
  },
  reply(text: string): string {
    const t = text.toLowerCase();
    if (/\b(museum|exhibition|gallery|ticket|tickets)\b/.test(t)) {
      return 'Perfect, count me in! Could we meet half an hour later? I have brunch with my sister before. Can’t wait!';
    }
    if (/\b(book|booked|reserv|table|dinner|lunch|brunch|restaurant|trattoria|bistro|caf[eé])/.test(t)) {
      return 'Perfect, count me in! Could we make it half an hour later? I finish work late that day. I will be there, can’t wait.';
    }
    if (/\b(hike|hiking|sunday|pick you up|drive)\b/.test(t)) return 'Great! I will pick you up at 9:00. Bring a jacket, it gets windy at the top.';
    if (/\b(thank|thanks|thx)\b/.test(t)) return 'Anytime! 😊';
    if (/\b(which|should i|what do you think|would you|or)\b.*\?|\b(recommend|opinion|advice)\b/.test(t)) return DEMO.opinion(t);
    if (/\b(birthday|gift|present)\b/.test(t)) return 'Oh nice! She loves anything handmade, and she has been talking about that pottery class for months.';
    return 'Got it, thanks for letting me know! I will get back to you tonight.';
  },
  /** Its answer to a question, or to a message asking what it thinks. */
  opinion(question: string): string {
    const q = question.toLowerCase();
    if (/\b(restaurant|dinner|eat|food|place)\b/.test(q)) return 'Go for the small one by the canal. The pasta is the best I had this year, and it is quiet enough to talk. Book ahead on Fridays.';
    if (/\b(flat|apartment|neighbou?rhood|move|rent)\b/.test(q)) return 'I would take the first one. I lived around there for two years: the U-Bahn is two minutes away and the street is quiet at night. The other is nicer inside, but you will hate the commute.';
    if (/\b(laptop|phone|camera|buy|model)\b/.test(q)) return 'Take the lighter one. I had the heavier model and stopped carrying it after a month. The battery matters more than the extra speed.';
    if (/\b(or|which|between|pick|choose|vs)\b/.test(q)) return 'Honestly, the first one. It fits how you live now, not how you think you should live. You can always switch later.';
    return 'I think you should go for it. You have been thinking about it for weeks, and I think you would regret not trying.';
  },
};/** A handle as people type it: no @, no spaces, lower case. */
export const normalHandle = (handle: string) => handle.trim().replace(/^@/, '').toLowerCase();
/** A stored hash nobody's password matches, compared when a handle has none, so both cases take as long. */
const DUMMY_HASH = hashPassword(randomBytes(16).toString('hex'));
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
  /** Files that came with a question or an answer: names and types; the person opens them on their Klatsch page. */
  files?: { type: string; size: number }[];
  /** A conversation the human let through: the friend's messages and their own around them, oldest first. */
  messages?: { from: string; text: string; at: string }[];
  /** The human's own words on how to answer, given with "Send to my AI". */
  how?: string;
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

  /**
   * How long the demo friend takes to write back or answer: long enough that its words arrive as new (unread,
   * with a notification), as a real friend's would. Tests set 0 to have them at once.
   */
  demoDelayMs = 20_000;

  /** Runs what the demo friend does, after its delay; a failure there (the reviewer deleted meanwhile) is dropped. */
  private asDemo(work: () => void): void {
    if (this.demoDelayMs <= 0) return work();
    setTimeout(() => {
      try {
        work();
      } catch {
        // Nothing to tell anyone: the demo friend simply does not answer.
      }
    }, this.demoDelayMs).unref();
  }

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
        if (!HANDLE.test(handle) || reservedHandle(handle) || this.db.prepare('SELECT 1 FROM users WHERE handle = ?').get(handle)) return 'taken';
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
        if (!HANDLE.test(handle) || reservedHandle(handle) || this.db.prepare('SELECT 1 FROM users WHERE handle = ?').get(handle)) return 'taken';
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
    if (this.isGuest(userId)) throw new KlatschError('forbidden', GUEST.noAccount);
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
        if (!HANDLE.test(handle) || reservedHandle(handle) || this.db.prepare('SELECT 1 FROM users WHERE handle = ?').get(handle)) return 'taken';
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
    if (this.isGuest(userId)) throw new KlatschError('forbidden', GUEST.noAccount);
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
    if (this.isGuest(userId)) throw new KlatschError('forbidden', GUEST.noAccount);
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
    if (this.isGuest(ownerId)) throw new KlatschError('forbidden', GUEST.guestsOnly);
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
    // A guest's link is only for another guest (`refuseGuest` when it is used), and a guest makes few.
    if (this.isGuest(userId)) {
      const made = this.db.prepare(`SELECT count(*) AS n FROM memberships m JOIN circles c ON c.id = m.circle_id WHERE m.user_id = ? AND m.role = 'owner' AND c.pair = 1`).get(userId) as { n: number };
      if (made.n >= GUEST_LINKS) throw new KlatschError('forbidden', GUEST.links);
    }
    // A review account may make a link, so a reviewer sees how adding a friend works; nobody can use it to join
    // (acceptInvite), so the account still reaches no real person.
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
      this.dropConversation(circleId);
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
    this.refuseGuest(userId, circleId);
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
    if (this.isGuest(userId)) throw new KlatschError('forbidden', GUEST.noAccount);
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
  savePushSubscription(userId: string, sub: { endpoint: string; p256dh: string; auth: string }, resync = false): 'on' | 'off' | 'other' {
    const endpoint = pushEndpoint(sub.endpoint);
    if (!endpoint || !pushKeyValid(sub.p256dh) || Buffer.from(sub.auth, 'base64url').length !== 16) {
      throw new KlatschError('invalid', 'This browser sent a subscription Klatsch cannot use.');
    }
    return transaction(this.db, () => {
      if (resync) {
        // The page re-sends what the browser holds on every visit, so a row lost on the relay comes back; but not
        // one the person turned off from another device: that browser is told so and drops it.
        if (this.db.prepare('SELECT 1 FROM push_off WHERE endpoint = ? AND user_id = ?').get(endpoint, userId)) return 'off' as const;
      } else this.db.prepare('DELETE FROM push_off WHERE endpoint = ?').run(endpoint);
      // Someone else's device: never taken over. Signing in as another person here starts with notifications off.
      const holder = this.db.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as { user_id: string } | undefined;
      if (holder && holder.user_id !== userId) {
        // On a visit the page only asks whose this browser's notifications are; it must not offer to turn them off.
        if (resync) return 'other' as const;
        throw new KlatschError('invalid', 'This browser gets notifications for someone else. Turn them off there first.');
      }
      this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, userId);
      this.db.prepare('INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(newId('push'), userId, endpoint, sub.p256dh, sub.auth, Date.now());
      // A guest gets one device.
      this.db
        .prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND rowid NOT IN (SELECT rowid FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)')
        .run(userId, userId, this.isGuest(userId) ? 1 : 10);
      if (!resync) this.audit(userId, 'web', 'push.on');
      return 'on' as const;
    });
  }

  pushSubscriptionsOf(userId: string): PushSubscriptionRow[] {
    return this.db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(userId) as unknown as PushSubscriptionRow[];
  }

  /**
   * Sends a test notification to every device of this person and says how each push service answered. Set by
   * whoever runs the relay with a push key (the CLI); without one there is nothing to test.
   */
  pushTest?: (subscriptions: PushSubscriptionRow[]) => Promise<('sent' | 'gone' | 'failed')[]>;
  private lastPushTest = new Map<string, number>();

  async testPush(userId: string): Promise<{ sent: number; failed: number; gone: number }> {
    const subscriptions = this.pushSubscriptionsOf(userId);
    if (!this.pushTest || subscriptions.length === 0) return { sent: 0, failed: 0, gone: 0 };
    const last = this.lastPushTest.get(userId) ?? 0;
    if (Date.now() - last < 30_000) throw new KlatschError('invalid', 'You just sent a test notification. Wait half a minute, then try again.');
    this.lastPushTest.set(userId, Date.now());
    const outcomes = await this.pushTest(subscriptions);
    this.audit(userId, 'web', 'push.test');
    const count = (o: string) => outcomes.filter((x) => x === o).length;
    return { sent: count('sent'), failed: count('failed'), gone: count('gone') };
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
    this.db
      .prepare('INSERT OR REPLACE INTO push_off (endpoint, user_id, created_at) SELECT endpoint, user_id, ? FROM push_subscriptions WHERE user_id = ?')
      .run(Date.now(), userId);
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
  /** A review account's credentials are held by outsiders: it never reaches real people by itself. */
  private isReviewAccount(userId: string): boolean {
    return Boolean((this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string | null } | undefined)?.password_hash);
  }

  /** When a guest goes; undefined for everyone else. */
  guestExpiresAt(userId: string): number | undefined {
    return (this.db.prepare('SELECT guest_expires_at AS at FROM users WHERE id = ?').get(userId) as { at: number | null } | undefined)?.at ?? undefined;
  }

  isGuest(userId: string): boolean {
    return this.guestExpiresAt(userId) !== undefined;
  }

  /**
   * The one rule that keeps guests and real people apart: a guest is only ever in a circle for two whose other
   * person is a guest too, and nobody else ever joins a circle a guest is in. `addMember` asks here with the
   * circle; `joinPublic` and `acceptInvite` ask first, for their own words; `ensureCircle` makes no circle for a
   * guest, and `friendCircle` makes the guest the only member of a new pair. A test counts the places that insert
   * memberships, so a new one cannot appear without this check.
   */
  private refuseGuest(userId: string, circleId?: string): void {
    const guest = this.isGuest(userId);
    if (circleId === undefined) {
      if (guest) throw new KlatschError('forbidden', GUEST.guestsOnly);
      return;
    }
    const circle = this.db.prepare('SELECT pair FROM circles WHERE id = ?').get(circleId) as { pair: number } | undefined;
    const members = (this.db.prepare('SELECT user_id FROM memberships WHERE circle_id = ?').all(circleId) as { user_id: string }[]).map((m) => m.user_id);
    const withGuests = members.some((m) => this.isGuest(m));
    if (guest && (!circle?.pair || members.some((m) => !this.isGuest(m)))) throw new KlatschError('forbidden', GUEST.guestsOnly);
    if (!guest && withGuests) throw new KlatschError('forbidden', GUEST.linkFromGuest);
  }

  joinPublic(userId: string, token: string): 'joined' | 'already-member' {
    if (this.isGuest(userId)) throw new KlatschError('forbidden', GUEST.guestsOnly);
    if (this.isReviewAccount(userId)) throw new KlatschError('forbidden', 'A review account does not join public circles.');
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
    // Outsiders hold a review account's password, and anyone can be a guest: neither reaches real people, by invite
    // or friend link. A guest's friend link is for another guest only.
    if (this.isGuest(userId) !== this.isGuest(invite.createdBy)) throw new KlatschError('forbidden', this.isGuest(userId) ? GUEST.guestsOnly : GUEST.linkFromGuest);
    this.refuseGuest(userId, invite.circleId);
    if (this.isReviewAccount(userId)) throw new KlatschError('forbidden', 'A review account has the demo friend only.');
    if (this.isReviewAccount(invite.createdBy)) throw new KlatschError('forbidden', 'This link comes from a Klatsch demo account. It adds nobody.');
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
    // A guest owns only circles for two (`refuseGuest`), whose one link is checked below like anyone's.
    if (!role || this.isReviewAccount(userId)) return false;
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
    if (approval.action === 'send_message') {
      const { other } = this.friendFor(userId, p.handle!);
      return { action: 'send_message', to: { name: other.display_name, handle: other.handle }, text: p.text!, flags: this.previewMessage(p.text!) };
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
        } else if (approval.action === 'send_message') {
          result = { message_id: this.sendMessage(userId, p.handle!, this.editedText(choice.text, p.text!, MESSAGE_MAX), 'web') };
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
    // A guest lives a few hours, so its day is its whole life.
    return open.n < ASKS_OPEN && today.n < (this.isGuest(askerId) ? GUEST_ASKS : ASKS_PER_DAY);
  }

  /**
   * Runs once the asker's human approved it. Only the person asked reads the question, with the asker's name; it
   * reaches their agent only by their own click, or because they chose to always get this person's notes.
   */
  private createAsk(askerId: string, handle: string, tags: string[], question: string, options: { demo?: boolean } = {}): string {
    const helper = this.askTarget(askerId, handle);
    // The demo friend's own seeded question is not one person's asking: no limit, or a busy review day would fail.
    if (!options.demo && !this.canAsk(askerId)) throw new KlatschError('forbidden', this.isGuest(askerId) ? GUEST.asks : ASK.tooMany);
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
    // The demo friend answers after a moment, so a reviewer sees the whole round trip alone.
    if (this.isDemo(helper.id)) this.asDemo(() => this.answerAsk(helper.id, id, DEMO.opinion(question), false, 'cli'));
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

  // ---------- review accounts ----------

  /**
   * Sets up a directory reviewer: the account (made if missing) gets a new password, and a demo friend that
   * answers at once, with one question from the demo friend waiting. Returns the password, once.
   */
  setReviewAccount(handle: string, name: string, options: { existing?: boolean } = {}): string {
    const password = newReviewPassword();
    transaction(this.db, () => {
      // A typo must not hand a real person's account a password that outsiders will hold.
      const known = this.db.prepare('SELECT id, password_hash FROM users WHERE handle = ?').get(handle) as { id: string; password_hash: string | null } | undefined;
      if (known && known.password_hash === null && !options.existing) throw new KlatschError('forbidden', `@${handle} is an existing account without a password. Use another handle, or --yes to make it a review account.`);
      if (this.isGuest(known?.id ?? '')) throw new KlatschError('forbidden', `@${handle} is a guest.`);
      const demo = this.demoFriend();
      const reviewer = this.ensureUser(handle, name);
      this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), reviewer);
      if (!this.friendshipOf(reviewer, demo)) {
        const circle = this.friendCircle(demo);
        this.addMember(circle, reviewer, demo);
      }
      this.seedDemoConversation(demo, reviewer, this.friendshipOf(reviewer, demo)!);
      this.seedDemoQuestion(demo, reviewer);
      this.audit(reviewer, 'cli', 'review.account');
    });
    return password;
  }

  /** The person behind a review account's handle and password; anything else is simply not found. */
  async passwordSignIn(handle: string, password: string): Promise<string | undefined> {
    const row = this.db.prepare('SELECT id, password_hash FROM users WHERE handle = ?').get(normalHandle(handle)) as
      | { id: string; password_hash: string | null }
      | undefined;
    // The same work whether or not the handle has a password, so timing tells nobody which accounts are review accounts.
    const ok = (await passwordMatches(password, row?.password_hash ?? DUMMY_HASH)) && Boolean(row?.password_hash);
    if (!ok || !row) return undefined;
    this.audit(row.id, 'web', 'review.signin');
    return row.id;
  }

  /** The demo friend, made the first time it is needed. */
  private demoFriend(): string {
    // The demo friend answers in its own name only: a real person who has its handle is never made one.
    const demoRow = this.db.prepare('SELECT demo FROM users WHERE handle = ?').get(DEMO_HANDLE) as { demo: number } | undefined;
    if (demoRow && !demoRow.demo) throw new KlatschError('forbidden', `@${DEMO_HANDLE} belongs to a real person here; the demo friend cannot be set up.`);
    const demo = this.ensureUser(DEMO_HANDLE, 'Klatsch Demo');
    this.db.prepare('UPDATE users SET demo = 1 WHERE id = ?').run(demo);
    return demo;
  }

  // ---------- guests ----------

  /**
   * "Try it without an account": a guest for GUEST_HOURS, with no friend yet. It invites a friend by link, who joins
   * as a guest too, and the two write to each other. A guest picks no name and no handle, adds no sign-in, sends
   * no files, and is only ever in a circle for two with another guest (`refuseGuest`), so nothing it writes reaches
   * a real person and no real person's words reach it. Everything goes when its hours are up (`sweepGuests`).
   */
  startGuest(now = Date.now()): string {
    if (!this.config.guest) throw new KlatschError('forbidden', GUEST.off);
    this.sweepGuests(now);
    return transaction(this.db, () => {
      const live = this.db.prepare('SELECT count(*) AS n FROM users WHERE guest_expires_at IS NOT NULL').get() as { n: number };
      if (live.n >= GUEST_LIVE_MAX) throw new KlatschError('forbidden', GUEST.busy);
      const letters = 'abcdefghjkmnpqrstuvwxyz23456789';
      let handle: string;
      do handle = GUEST_PREFIX + [...randomBytes(6)].map((b) => letters[b % letters.length]).join('');
      while (this.db.prepare('SELECT 1 FROM users WHERE handle = ?').get(handle));
      const guest = newId('usr');
      // Two guests talking need to tell each other apart: "Guest K7M", from the handle.
      const name = `Guest ${handle.slice(GUEST_PREFIX.length, GUEST_PREFIX.length + 3).toUpperCase()}`;
      this.db.prepare('INSERT INTO users (id, handle, display_name, created_at, guest_expires_at) VALUES (?, ?, ?, ?, ?)').run(guest, handle, name, now, now + GUEST_HOURS * HOUR);
      this.audit(guest, 'web', 'guest.start');
      return guest;
    });
  }

  /**
   * A guest ends now ("End guest session", or its hours are up): its circles for two and everything in them (so the
   * other guest loses that friend at once), then the account.
   */
  endGuest(userId: string, via: Via): void {
    if (!this.isGuest(userId)) throw new KlatschError('forbidden', 'This is not a guest.');
    transaction(this.db, () => {
      const removed = new Set<string>();
      const circles = (this.db.prepare('SELECT circle_id FROM memberships WHERE user_id = ?').all(userId) as { circle_id: string }[]).map((r) => r.circle_id);
      if (circles.length) purge(this.db, 'circles', 'id', circles, removed);
      this.db.prepare('DELETE FROM events WHERE ref IN (SELECT value FROM json_each(?))').run(JSON.stringify([...removed]));
      this.deleteAccount(userId, via);
    });
  }

  /** A guest's first steps, done or not: a friend, a first message, an AI connected. */
  guestSteps(userId: string): { friend: boolean; message: boolean; ai: boolean } {
    return {
      friend: this.inAnyCircle(userId),
      message: Boolean(this.db.prepare('SELECT 1 FROM messages WHERE sender_id = ? LIMIT 1').get(userId)),
      ai: Boolean(this.db.prepare('SELECT 1 FROM tokens WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1').get(userId, Date.now())),
    };
  }

  /** Ends every guest whose hours are up. Cheap (an index); the relay calls it on every signed-in request and tool call. */
  sweepGuests(now = Date.now()): void {
    const due = this.db.prepare('SELECT id FROM users WHERE guest_expires_at IS NOT NULL AND guest_expires_at <= ?').all(now) as { id: string }[];
    for (const { id } of due) this.endGuest(id, 'cli');
  }

  hasReviewAccounts(): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM users WHERE password_hash IS NOT NULL').get());
  }

  private isDemo(userId: string): boolean {
    return Boolean((this.db.prepare('SELECT demo FROM users WHERE id = ?').get(userId) as { demo: number } | undefined)?.demo);
  }

  /** The conversation a review account starts with, unless the two already wrote to each other. */
  private seedDemoConversation(demo: string, reviewer: string, circleId: string): void {
    if (this.db.prepare('SELECT 1 FROM messages WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)').get(demo, reviewer, reviewer, demo)) return;
    const now = Date.now();
    const insert = this.db.prepare('INSERT INTO messages (id, circle_id, sender_id, recipient_id, body, created_at, read_at, for_agent) VALUES (?, ?, ?, ?, ?, ?, ?, 0)');
    DEMO.history.forEach((line, i) => {
      const at = now - line.hoursAgo * 60 * 60 * 1000;
      const last = i === DEMO.history.length - 1;
      const id = newId('m');
      insert.run(id, circleId, line.demo ? demo : reviewer, line.demo ? reviewer : demo, sealText(this.db, line.text), at, last ? null : at);
      if (last) this.event(reviewer, 'message.received', id);
    });
  }

  /**
   * Puts a review account back as a new reviewer finds it: the demo conversation and question as seeded, nothing
   * else between the two. Its password and connections stay, so the directory's copy of them still works.
   */
  resetReviewDemo(handle: string): void {
    transaction(this.db, () => {
      const reviewer = this.db.prepare('SELECT id FROM users WHERE handle = ? AND password_hash IS NOT NULL').get(normalHandle(handle)) as { id: string } | undefined;
      const demo = this.db.prepare('SELECT id FROM users WHERE handle = ? AND demo = 1').get(DEMO_HANDLE) as { id: string } | undefined;
      if (!reviewer || !demo) throw new KlatschError('not-found', `@${normalHandle(handle)} is not a review account with the demo friend.`);
      const between = '(sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)';
      const ids = (this.db.prepare(`SELECT id FROM messages WHERE ${between}`).all(demo.id, reviewer.id, reviewer.id, demo.id) as { id: string }[]).map((r) => r.id);
      for (const id of ids) {
        this.db.prepare('DELETE FROM message_files WHERE message_id = ?').run(id);
        this.db.prepare('DELETE FROM events WHERE ref = ?').run(id);
      }
      this.db.prepare(`DELETE FROM messages WHERE ${between}`).run(demo.id, reviewer.id, reviewer.id, demo.id);
      // Every question between the two goes too, with its files and events: a closed one left in the inbox would
      // open in a chat as if it could still be answered.
      const asks = `(asker_id = ? AND helper_id = ?) OR (asker_id = ? AND helper_id = ?)`;
      for (const { id } of this.db.prepare(`SELECT id FROM asks WHERE ${asks}`).all(demo.id, reviewer.id, reviewer.id, demo.id) as { id: string }[]) {
        this.db.prepare('DELETE FROM attachments WHERE ask_id = ?').run(id);
        this.db.prepare('DELETE FROM events WHERE ref = ?').run(id);
      }
      this.db.prepare(`DELETE FROM asks WHERE ${asks}`).run(demo.id, reviewer.id, reviewer.id, demo.id);
      this.seedDemoConversation(demo.id, reviewer.id, this.friendshipOf(reviewer.id, demo.id)!);
      this.seedDemoQuestion(demo.id, reviewer.id);
      this.audit(reviewer.id, 'cli', 'review.reset');
    });
  }

  /** The demo friend's question to the reviewer, unless one is still waiting. */
  private seedDemoQuestion(demo: string, reviewer: string): void {
    const waiting = this.db.prepare(`SELECT 1 FROM asks WHERE asker_id = ? AND helper_id = ? AND state = 'open' AND expires_at > ?`).get(demo, reviewer, Date.now());
    if (!waiting) this.createAsk(demo, this.user(reviewer).handle, [], DEMO.question, { demo: true });
  }

  // ---------- files with a question or an answer ----------

  /**
   * A file with a question (by the asker, while it waits) or its answer (by the person asked, while it waits or
   * within ten minutes of answering). Its type is read from its bytes; it is sealed, and goes with the question.
   */
  attach(userId: string, askId: string, file: { name: string; bytes: Uint8Array }, via: Via = 'web'): { id: string; name: string; mime: string; size: number } {
    if (this.isGuest(userId)) throw new KlatschError('forbidden', GUEST.noFiles);
    this.dropExpiredAttachments();
    const row = this.askRow(askId);
    if (!row || row.expires_at <= Date.now() || !this.sharePrivateCircle(row.asker_id, row.helper_id)) throw new KlatschError('forbidden', ASK.notOpen);
    const answeredAt = (this.db.prepare('SELECT answered_at FROM asks WHERE id = ?').get(askId) as { answered_at: number | null }).answered_at;
    const recent = row.state === 'answered' && answeredAt !== null && answeredAt > Date.now() - 10 * 60 * 1000;
    const side =
      row.asker_id === userId && (row.state === 'open' || (recent && this.isDemo(row.helper_id)))
        ? 'question'
        : row.helper_id === userId && (row.state === 'open' || (row.state === 'answered' && answeredAt !== null && answeredAt > Date.now() - 10 * 60 * 1000))
          ? 'answer'
          : undefined;
    if (!side) throw new KlatschError('forbidden', ATTACH.notNow);
    const bytes = Buffer.from(file.bytes);
    if (bytes.length > ATTACHMENT_MAX_BYTES) throw new KlatschError('invalid', ATTACH.tooBig);
    const kind = sniff(bytes);
    if (!kind) throw new KlatschError('invalid', ATTACH.wrongType);
    const count = this.db.prepare('SELECT count(*) AS n FROM attachments WHERE ask_id = ? AND side = ?').get(askId, side) as { n: number };
    if (count.n >= ATTACHMENTS_PER_SIDE) throw new KlatschError('forbidden', ATTACH.tooMany);
    if (this.bytesToday(userId) + bytes.length > ATTACHMENT_BYTES_PER_DAY) throw new KlatschError('forbidden', ATTACH.dayLimit);
    const id = newId('att');
    const name = cleanName(file.name, kind);
    this.db
      .prepare('INSERT INTO attachments (id, ask_id, user_id, side, name, mime, size, data, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, askId, userId, side, sealText(this.db, name), kind.mime, bytes.length, sealBytes(this.db, bytes), Date.now(), row.expires_at);
    this.audit(userId, via, 'attach', askId);
    // The other person hears of it like of the question or the answer: a line, never the file.
    const other = side === 'question' ? row.helper_id : row.asker_id;
    if (row.state !== 'open' || side === 'question') this.notifyUser(other, notifications.other);
    return { id, name, mime: kind.mime, size: bytes.length };
  }

  /** The files with a question and its answer, for its two people only: names, types and sizes, never the bytes. */
  attachmentsOf(userId: string, askId: string): { id: string; side: 'question' | 'answer'; name: string; mime: string; size: number }[] {
    this.dropExpiredAttachments();
    const row = this.askRow(askId);
    if (!row || (row.asker_id !== userId && row.helper_id !== userId) || !this.sharePrivateCircle(row.asker_id, row.helper_id)) return [];
    return this.db
      .prepare('SELECT id, side, name, mime, size FROM attachments WHERE ask_id = ? AND expires_at > ? ORDER BY created_at')
      .all(askId, Date.now()) as { id: string; side: 'question' | 'answer'; name: string; mime: string; size: number }[];
  }

  /** One file, opened for one of the two people while they still share a private circle; one answer for all else. */
  openAttachment(userId: string, id: string): { name: string; mime: string; bytes: Buffer } {
    this.dropExpiredAttachments();
    if (id.startsWith('mf_')) return this.openMessageFile(userId, id);
    if (id.startsWith('rf_')) return this.openRoomFile(userId, id);
    const row = this.db.prepare('SELECT ask_id, name, mime, data FROM attachments WHERE id = ? AND expires_at > ?').get(id, Date.now()) as
      | { ask_id: string; name: string; mime: string; data: Uint8Array }
      | undefined;
    const ask = row && this.askRow(row.ask_id);
    if (!row || !ask || ask.state === 'withdrawn' || (ask.asker_id !== userId && ask.helper_id !== userId) || !this.sharePrivateCircle(ask.asker_id, ask.helper_id)) {
      throw new KlatschError('not-found', ATTACH.gone);
    }
    const bytes = openBytes(this.db, row.data);
    if (!bytes) throw new KlatschError('not-found', ATTACH.gone);
    this.audit(userId, 'web', 'attach.open', row.ask_id);
    return { name: row.name, mime: row.mime, bytes };
  }

  /** A file with a message, for its two friends while they are friends; one answer for everything else. */
  private openMessageFile(userId: string, id: string): { name: string; mime: string; bytes: Buffer } {
    const row = this.db
      .prepare('SELECT f.name, f.mime, f.data, m.id AS message_id, m.circle_id, m.sender_id, m.recipient_id FROM message_files f JOIN messages m ON m.id = f.message_id WHERE f.id = ? AND f.expires_at > ?')
      .get(id, Date.now()) as { name: string; mime: string; data: Uint8Array; message_id: string; circle_id: string; sender_id: string; recipient_id: string } | undefined;
    if (!row || (row.sender_id !== userId && row.recipient_id !== userId) || this.friendshipOf(row.sender_id, row.recipient_id) !== row.circle_id) {
      throw new KlatschError('not-found', ATTACH.gone);
    }
    const bytes = openBytes(this.db, row.data);
    if (!bytes) throw new KlatschError('not-found', ATTACH.gone);
    this.audit(userId, 'web', 'attach.open', row.message_id);
    return { name: row.name, mime: row.mime, bytes };
  }

  /** A file in a room, for the members of its circle; one answer for everything else. */
  private openRoomFile(userId: string, id: string): { name: string; mime: string; bytes: Buffer } {
    const row = this.db
      .prepare('SELECT f.name, f.mime, f.data, m.id AS message_id, r.circle_id FROM room_files f JOIN room_messages m ON m.id = f.message_id JOIN rooms r ON r.id = m.room_id WHERE f.id = ? AND f.expires_at > ? AND m.deleted_at IS NULL')
      .get(id, Date.now()) as { name: string; mime: string; data: Uint8Array; message_id: string; circle_id: string } | undefined;
    if (!row || !this.memberRole(userId, row.circle_id)) throw new KlatschError('not-found', ATTACH.gone);
    const bytes = openBytes(this.db, row.data);
    if (!bytes) throw new KlatschError('not-found', ATTACH.gone);
    this.audit(userId, 'web', 'attach.open', row.message_id);
    return { name: row.name, mime: row.mime, bytes };
  }

  /**
   * A file with a room message, by its writer, just after writing it. Its type is read from its bytes; at most
   * three, and the day's limit counts with every other file. A new member's first day: none.
   */
  attachToRoomMessage(userId: string, messageId: string, file: { name: string; bytes: Uint8Array }): void {
    const row = this.db.prepare('SELECT m.sender_id, m.created_at, r.circle_id FROM room_messages m JOIN rooms r ON r.id = m.room_id WHERE m.id = ? AND m.deleted_at IS NULL').get(messageId) as
      | { sender_id: string; created_at: number; circle_id: string }
      | undefined;
    if (!row || row.sender_id !== userId || row.created_at < Date.now() - 10 * 60 * 1000) throw new KlatschError('forbidden', ATTACH.notNow);
    const joined = (this.db.prepare('SELECT created_at FROM memberships WHERE circle_id = ? AND user_id = ?').get(row.circle_id, userId) as { created_at: number } | undefined)?.created_at ?? 0;
    if (!this.isHost(userId, row.circle_id) && Date.now() - joined < NEW_MEMBER_MS) throw new KlatschError('forbidden', ROOM.newMemberFiles);
    const bytes = Buffer.from(file.bytes);
    if (bytes.length > ATTACHMENT_MAX_BYTES) throw new KlatschError('invalid', ATTACH.tooBig);
    const kind = sniff(bytes);
    if (!kind) throw new KlatschError('invalid', ATTACH.wrongType);
    const count = this.db.prepare('SELECT count(*) AS n FROM room_files WHERE message_id = ?').get(messageId) as { n: number };
    if (count.n >= ATTACHMENTS_PER_SIDE) throw new KlatschError('forbidden', ATTACH.tooMany);
    if (this.bytesToday(userId) + bytes.length > ATTACHMENT_BYTES_PER_DAY) throw new KlatschError('forbidden', ATTACH.dayLimit);
    this.db
      .prepare('INSERT INTO room_files (id, message_id, user_id, name, mime, size, data, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(newId('rf'), messageId, userId, sealText(this.db, cleanName(file.name, kind)), kind.mime, bytes.length, sealBytes(this.db, bytes), Date.now(), Date.now() + ATTACHMENT_DAYS * DAY);
    this.audit(userId, 'web', 'room.attach', messageId);
  }

  private dropExpiredAttachments(): void {
    this.db.prepare('DELETE FROM attachments WHERE expires_at <= ?').run(Date.now());
    this.db.prepare('DELETE FROM message_files WHERE expires_at <= ?').run(Date.now());
    this.db.prepare('DELETE FROM room_files WHERE expires_at <= ?').run(Date.now());
  }

  // ---------- messages between friends ----------

  /**
   * The friend a handle names, with the friendship the conversation lives in. Everyone else, unknown handles and
   * the person themselves get one answer, so a handle tells an agent nothing about who is on the relay.
   */
  friendFor(userId: string, handle: string): { circleId: string; other: UserRow } {
    const clean = normalHandle(handle);
    const row = HANDLE.test(clean) ? (this.db.prepare('SELECT id FROM users WHERE handle = ?').get(clean) as { id: string } | undefined) : undefined;
    const circleId = row && row.id !== userId ? this.friendshipOf(userId, row.id) : undefined;
    if (!row || !circleId) throw new KlatschError('invalid', MESSAGE.noFriend);
    return { circleId, other: this.user(row.id) };
  }

  /** A message's own checks, before anyone approves it: nothing hidden, not empty, not too long; identifiers flagged. */
  previewMessage(text: string): Flag[] {
    const clean = text.trim();
    if (!clean) throw new KlatschError('invalid', MESSAGE.empty);
    if (clean.length > MESSAGE_MAX) throw new KlatschError('invalid', MESSAGE.tooLong);
    refuseHidden(clean);
    return detect(clean);
  }

  /** Whether `userId` may send another message now. */
  canMessage(userId: string): boolean {
    // The demo friend writes back to every reviewer and guest: no daily limit, or a busy day would silence it.
    if (this.isDemo(userId)) return true;
    const today = this.db.prepare('SELECT count(*) AS n FROM messages WHERE sender_id = ? AND created_at > ?').get(userId, Date.now() - DAY) as { n: number };
    return today.n < (this.isGuest(userId) ? GUEST_MESSAGES : MESSAGES_PER_DAY);
  }

  /**
   * Sends a message the person approved (in the card, on the approval page) or typed themselves (on their page,
   * in the card): their click is the approval. Only the friend reads it. It reaches the friend's agent only if
   * the friend chose to always get this person's words there.
   */
  sendMessage(senderId: string, handle: string, typed: string, via: Via = 'web'): string {
    // A form sends a line break as CRLF; one line break is one \n, so a message of several lines is not refused as hidden.
    const text = typed.replace(/\r\n?/g, '\n');
    const { circleId, other } = this.friendFor(senderId, handle);
    this.previewMessage(text);
    if (!this.canMessage(senderId)) throw new KlatschError('forbidden', this.isGuest(senderId) ? GUEST.messages : MESSAGE.tooMany);
    this.dropOldMessages();
    const id = newId('m');
    const always = this.hasGrant(other.id, senderId, 'deliver');
    this.db
      .prepare('INSERT INTO messages (id, circle_id, sender_id, recipient_id, body, created_at, for_agent) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, circleId, senderId, other.id, sealText(this.db, text.trim()), Date.now(), always ? 1 : 0);
    this.event(other.id, always ? 'message.thread' : 'message.received', id);
    this.audit(senderId, via, 'message.send', id);
    this.notifyUser(other.id, notifications.message);
    // The demo friend writes back after a moment, so a reviewer sees a conversation alone.
    if (this.isDemo(other.id)) {
      const reply = DEMO.reply(text.trim());
      this.asDemo(() => {
        this.db.prepare('UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL').run(Date.now(), id);
        this.sendMessage(other.id, this.user(senderId).handle, reply, 'cli');
      });
    }
    return id;
  }

  /** A file with a message, by its sender, within ten minutes of sending it. Its type is read from its bytes. */
  attachToMessage(userId: string, messageId: string, file: { name: string; bytes: Uint8Array }, via: Via = 'web'): { id: string; name: string; mime: string; size: number } {
    // Guests send voice notes only (no photos or documents), a few MB a day; they go with the guest.
    const guest = this.isGuest(userId);
    if (guest && sniff(file.bytes)?.kind !== 'audio') throw new KlatschError('forbidden', GUEST.voiceOnly);
    this.dropExpiredAttachments();
    const row = this.db.prepare('SELECT sender_id, recipient_id, circle_id, created_at FROM messages WHERE id = ?').get(messageId) as
      | { sender_id: string; recipient_id: string; circle_id: string; created_at: number }
      | undefined;
    if (!row || row.sender_id !== userId || row.created_at < Date.now() - 10 * 60 * 1000 || this.friendshipOf(row.sender_id, row.recipient_id) !== row.circle_id) {
      throw new KlatschError('forbidden', ATTACH.notNow);
    }
    const bytes = Buffer.from(file.bytes);
    if (bytes.length > ATTACHMENT_MAX_BYTES) throw new KlatschError('invalid', ATTACH.tooBig);
    const kind = sniff(bytes);
    if (!kind) throw new KlatschError('invalid', ATTACH.wrongType);
    const count = this.db.prepare('SELECT count(*) AS n FROM message_files WHERE message_id = ?').get(messageId) as { n: number };
    if (count.n >= ATTACHMENTS_PER_SIDE) throw new KlatschError('forbidden', ATTACH.tooMany);
    if (this.bytesToday(userId) + bytes.length > (guest ? GUEST_VOICE_BYTES_PER_DAY : ATTACHMENT_BYTES_PER_DAY)) throw new KlatschError('forbidden', ATTACH.dayLimit);
    const id = newId('mf');
    const name = cleanName(file.name, kind);
    this.db
      .prepare('INSERT INTO message_files (id, message_id, user_id, name, mime, size, data, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, messageId, userId, sealText(this.db, name), kind.mime, bytes.length, sealBytes(this.db, bytes), Date.now(), Date.now() + ATTACHMENT_DAYS * DAY);
    this.audit(userId, via, 'message.attach', messageId);
    return { id, name, mime: kind.mime, size: bytes.length };
  }

  /** What a person uploaded in the last day, with questions and with messages together. */
  private bytesToday(userId: string): number {
    const since = Date.now() - DAY;
    const a = this.db.prepare('SELECT coalesce(sum(size), 0) AS n FROM attachments WHERE user_id = ? AND created_at > ?').get(userId, since) as { n: number };
    const b = this.db.prepare('SELECT coalesce(sum(size), 0) AS n FROM message_files WHERE user_id = ? AND created_at > ?').get(userId, since) as { n: number };
    const r = this.db.prepare('SELECT coalesce(sum(size), 0) AS n FROM room_files WHERE user_id = ? AND created_at > ?').get(userId, since) as { n: number };
    return a.n + b.n + r.n;
  }

  /**
   * The conversation with one friend, oldest first, for the person's own page or their card in the chat: the
   * last `limit` messages, with their files (names, types, sizes). `markRead` marks the friend's messages read.
   */
  conversation(userId: string, handle: string, options: { limit?: number; markRead?: boolean } = {}): ConversationView {
    const { circleId, other } = this.friendFor(userId, handle);
    this.dropOldMessages();
    this.dropExpiredAttachments();
    const rows = (
      this.db
        .prepare(
          `SELECT m.id, m.sender_id, m.body, m.created_at, m.read_at, m.deleted_at, m.pinned_at, k.starred_at FROM messages m
           LEFT JOIN message_marks k ON k.message_id = m.id AND k.user_id = ?
           WHERE m.circle_id = ? AND k.hidden_at IS NULL ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
        )
        .all(userId, circleId, options.limit ?? 50) as {
        id: string; sender_id: string; body: string; created_at: number; read_at: number | null; deleted_at: number | null; pinned_at: number | null; starred_at: number | null;
      }[]
    ).reverse();
    const files = (messageId: string) =>
      this.db
        .prepare('SELECT id, name, mime, size FROM message_files WHERE message_id = ? AND expires_at > ? ORDER BY created_at')
        .all(messageId, Date.now()) as { id: string; name: string; mime: string; size: number }[];
    const unread = this.unreadFrom(userId, circleId);
    if (options.markRead && unread) {
      transaction(this.db, () => {
        this.db.prepare('UPDATE messages SET read_at = ? WHERE circle_id = ? AND recipient_id = ? AND read_at IS NULL').run(Date.now(), circleId, userId);
        // Read on the page or in the card: the agent's inbox no longer says it waits.
        this.db
          .prepare(`UPDATE events SET read_at = ? WHERE user_id = ? AND kind = 'message.received' AND read_at IS NULL AND ref IN (SELECT id FROM messages WHERE circle_id = ?)`)
          .run(Date.now(), userId, circleId);
      });
    }
    return {
      circleId,
      other: { name: other.display_name, handle: other.handle },
      unread,
      sends: this.hasGrant(userId, other.id, 'deliver'),
      messages: rows.map((r) => ({
        id: r.id,
        mine: r.sender_id === userId,
        text: r.deleted_at ? '' : r.body,
        at: r.created_at,
        read: r.read_at !== null,
        files: r.deleted_at ? [] : files(r.id),
        starred: r.starred_at !== null,
        pinned: r.pinned_at !== null,
        deleted: r.deleted_at !== null,
      })),
      ...(() => {
        const pin = this.db.prepare('SELECT id, body, deleted_at FROM messages WHERE circle_id = ? AND pinned_at IS NOT NULL ORDER BY pinned_at DESC LIMIT 1').get(circleId) as
          | { id: string; body: string; deleted_at: number | null }
          | undefined;
        return pin ? { pinned: { id: pin.id, text: pin.deleted_at ? '' : pin.body, deleted: pin.deleted_at !== null } } : {};
      })(),
    };
  }

  /**
   * One message of a conversation the person is in (sent or received, in a friendship that still stands), with
   * the friend's handle; anything else is "not yours", whoever asks.
   */
  private ownMessage(userId: string, messageId: string) {
    const row = this.db.prepare('SELECT id, sender_id, recipient_id, circle_id, created_at, deleted_at FROM messages WHERE id = ?').get(messageId) as
      | { id: string; sender_id: string; recipient_id: string; circle_id: string; created_at: number; deleted_at: number | null }
      | undefined;
    if (!row || (row.sender_id !== userId && row.recipient_id !== userId) || this.friendshipOf(row.sender_id, row.recipient_id) !== row.circle_id) {
      throw new KlatschError('forbidden', MESSAGE.notYours);
    }
    return { ...row, other: this.user(row.sender_id === userId ? row.recipient_id : row.sender_id).handle };
  }

  private mark(userId: string, messageId: string, column: 'starred_at' | 'hidden_at', value: number | null): void {
    this.db.prepare(`INSERT INTO message_marks (message_id, user_id, ${column}) VALUES (?, ?, ?) ON CONFLICT (message_id, user_id) DO UPDATE SET ${column} = excluded.${column}`).run(messageId, userId, value);
  }

  /** A star on a message, only for the person: their list of starred messages. Returns the friend's handle. */
  starMessage(userId: string, messageId: string, on: boolean): string {
    const row = this.ownMessage(userId, messageId);
    this.mark(userId, messageId, 'starred_at', on && !row.deleted_at ? Date.now() : null);
    return row.other;
  }

  /** "Delete for me": gone from this person's conversation only; the friend still has it. */
  hideMessage(userId: string, messageId: string): string {
    const row = this.ownMessage(userId, messageId);
    transaction(this.db, () => {
      this.mark(userId, messageId, 'hidden_at', Date.now());
      this.mark(userId, messageId, 'starred_at', null);
    });
    this.audit(userId, 'web', 'message.hide', messageId);
    return row.other;
  }

  /**
   * "Delete for everyone": by its sender, within two days. Its words and files go for both (the conversation shows
   * that a message was deleted), it is unpinned, and no agent gets it from now on. An agent that already got it
   * keeps what it got.
   */
  deleteMessageForEveryone(userId: string, messageId: string): string {
    const row = this.ownMessage(userId, messageId);
    if (row.sender_id !== userId || Date.now() - row.created_at > DELETE_FOR_EVERYONE_MS) throw new KlatschError('forbidden', MESSAGE.deleteTooLate);
    if (row.deleted_at) return row.other;
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM message_files WHERE message_id = ?').run(messageId);
      this.db.prepare('UPDATE messages SET body = ?, deleted_at = ?, pinned_at = NULL, pinned_by = NULL, for_agent = 0 WHERE id = ?').run(sealText(this.db, ''), Date.now(), messageId);
      this.db.prepare('UPDATE message_marks SET starred_at = NULL WHERE message_id = ?').run(messageId);
      this.db.prepare(`DELETE FROM events WHERE ref = ? AND kind IN ('message.received', 'message.thread')`).run(messageId);
      this.audit(userId, 'web', 'message.delete', messageId);
    });
    return row.other;
  }

  /** Pins a message at the top of the conversation, for both; one at a time. `on` false unpins it. */
  pinMessage(userId: string, messageId: string, on: boolean): string {
    const row = this.ownMessage(userId, messageId);
    if (on && row.deleted_at) throw new KlatschError('forbidden', MESSAGE.notYours);
    transaction(this.db, () => {
      if (on) this.db.prepare('UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE circle_id = ? AND pinned_at IS NOT NULL').run(row.circle_id);
      this.db.prepare('UPDATE messages SET pinned_at = ?, pinned_by = ? WHERE id = ?').run(on ? Date.now() : null, on ? userId : null, messageId);
    });
    return row.other;
  }

  /** The person's starred messages, newest first, from friendships that still stand. */
  starredOf(userId: string): StarredView[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.sender_id, m.recipient_id, m.circle_id, m.body, m.created_at FROM message_marks k JOIN messages m ON m.id = k.message_id
         WHERE k.user_id = ? AND k.starred_at IS NOT NULL AND k.hidden_at IS NULL AND m.deleted_at IS NULL ORDER BY k.starred_at DESC LIMIT 200`,
      )
      .all(userId) as { id: string; sender_id: string; recipient_id: string; circle_id: string; body: string; created_at: number }[];
    return rows
      .filter((r) => this.friendshipOf(r.sender_id, r.recipient_id) === r.circle_id)
      .map((r) => {
        const other = this.user(r.sender_id === userId ? r.recipient_id : r.sender_id);
        return { id: r.id, other: { name: other.display_name, handle: other.handle }, mine: r.sender_id === userId, text: r.body, at: r.created_at };
      });
  }


  // ---------- circles as communities: rooms, hosts, rules, moderation ----------

  /** The circle for someone in it, not a friendship (those are Chats); anyone else gets "not found". */
  private spaceRow(userId: string, circleId: string) {
    const role = this.memberRole(userId, circleId);
    const row = this.db.prepare('SELECT id, name, pair, ended_at, rules, slow_seconds, public, listed, about FROM circles WHERE id = ?').get(circleId) as
      | { id: string; name: string; pair: number; ended_at: number | null; rules: string | null; slow_seconds: number; public: number; listed: number; about: string | null }
      | undefined;
    if (!role || !row || row.pair || row.ended_at !== null) throw new KlatschError('not-found', ROOM.noCircle);
    return { ...row, role };
  }

  private person(circleId: string, userId: string) {
    return (this.db.prepare('SELECT host, rules_at, timeout_until, notify FROM circle_people WHERE circle_id = ? AND user_id = ?').get(circleId, userId) as
      | { host: number; rules_at: number | null; timeout_until: number | null; notify: 'all' | 'mentions' | 'none' }
      | undefined) ?? { host: 0, rules_at: null, timeout_until: null, notify: 'mentions' as const };
  }

  /** The owner is always a host; the owner makes others hosts. */
  isHost(userId: string, circleId: string): boolean {
    const role = this.memberRole(userId, circleId);
    return role === 'owner' || (role !== undefined && this.person(circleId, userId).host === 1);
  }

  private refuseNonHost(userId: string, circleId: string): void {
    if (!this.isHost(userId, circleId)) throw new KlatschError('forbidden', ROOM.hostsOnly);
  }

  private setPerson(circleId: string, userId: string, column: 'host' | 'rules_at' | 'timeout_until' | 'notify', value: number | string | null): void {
    this.db.prepare(`INSERT INTO circle_people (circle_id, user_id, ${column}) VALUES (?, ?, ?) ON CONFLICT (circle_id, user_id) DO UPDATE SET ${column} = excluded.${column}`).run(circleId, userId, value);
  }

  /** Anyone (not a guest) starts a circle and owns it; at most five of their own. */
  createCircle(userId: string, name: string): string {
    if (this.isGuest(userId)) throw new KlatschError('forbidden', GUEST.guestsOnly);
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!clean) throw new KlatschError('invalid', ROOM.circleName);
    refuseHidden(clean);
    const owned = (this.db.prepare(`SELECT count(*) AS n FROM memberships m JOIN circles c ON c.id = m.circle_id WHERE m.user_id = ? AND m.role = 'owner' AND c.pair = 0 AND c.ended_at IS NULL`).get(userId) as { n: number }).n;
    if (owned >= 5) throw new KlatschError('forbidden', ROOM.tooManyCircles);
    const id = newId('cir');
    transaction(this.db, () => {
      this.db.prepare('INSERT INTO circles (id, name, created_at) VALUES (?, ?, ?)').run(id, clean, Date.now());
      this.db.prepare(`INSERT INTO memberships (circle_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`).run(id, userId, Date.now());
      this.ensureRooms(id);
      this.audit(userId, 'web', 'circle.create', id);
    });
    return id;
  }

  /** A circle's first rooms, made the first time anyone opens it: general, and announcements for hosts. */
  private ensureRooms(circleId: string): void {
    if (this.db.prepare('SELECT 1 FROM rooms WHERE circle_id = ?').get(circleId)) return;
    const insert = this.db.prepare('INSERT INTO rooms (id, circle_id, name, announce, created_at) VALUES (?, ?, ?, ?, ?)');
    insert.run(newId('room'), circleId, 'general', 0, Date.now());
    insert.run(newId('room'), circleId, 'announcements', 1, Date.now() + 1);
  }

  /** The person's circles as communities (friendships are Chats), each with its unread count. */
  spacesOf(userId: string): (CircleSpace & { unread: number })[] {
    const ids = this.db
      .prepare(`SELECT c.id FROM memberships m JOIN circles c ON c.id = m.circle_id WHERE m.user_id = ? AND c.pair = 0 AND c.ended_at IS NULL ORDER BY c.created_at`)
      .all(userId) as { id: string }[];
    return ids.map(({ id }) => {
      const space = this.space(userId, id);
      return { ...space, unread: space.rooms.reduce((n, r) => n + r.unread, 0) };
    });
  }

  space(userId: string, circleId: string): CircleSpace {
    const row = this.spaceRow(userId, circleId);
    this.ensureRooms(circleId);
    const me = this.person(circleId, userId);
    const host = this.isHost(userId, circleId);
    const rooms = this.db.prepare('SELECT id, name, announce FROM rooms WHERE circle_id = ? ORDER BY created_at').all(circleId) as { id: string; name: string; announce: number }[];
    const people = (this.db.prepare('SELECT count(*) AS n FROM memberships WHERE circle_id = ?').get(circleId) as { n: number }).n;
    return {
      id: circleId,
      name: row.name,
      people,
      public: row.public === 1,
      owner: row.role === 'owner',
      host,
      rules: row.rules,
      mustAccept: Boolean(row.rules) && me.rules_at === null && !host,
      notify: me.notify,
      listed: row.listed === 1,
      about: row.about,
      slowSeconds: row.slow_seconds,
      timeoutUntil: me.timeout_until && me.timeout_until > Date.now() ? me.timeout_until : null,
      rooms: rooms.map((r) => ({ id: r.id, name: r.name, announce: r.announce === 1, unread: this.roomUnread(userId, r.id) })),
    };
  }

  private roomUnread(userId: string, roomId: string): number {
    const read = (this.db.prepare('SELECT read_at FROM room_reads WHERE room_id = ? AND user_id = ?').get(roomId, userId) as { read_at: number } | undefined)?.read_at ?? 0;
    return (this.db.prepare('SELECT count(*) AS n FROM room_messages WHERE room_id = ? AND created_at > ? AND sender_id != ? AND deleted_at IS NULL').get(roomId, read, userId) as { n: number }).n;
  }

  private roomRow(userId: string, roomId: string) {
    const room = this.db.prepare('SELECT id, circle_id, name, announce FROM rooms WHERE id = ?').get(roomId) as { id: string; circle_id: string; name: string; announce: number } | undefined;
    if (!room) throw new KlatschError('not-found', ROOM.noCircle);
    this.spaceRow(userId, room.circle_id);
    return room;
  }

  /** A room's last messages, oldest first; reading them marks the room read. */
  roomMessages(userId: string, roomId: string, limit = 80): RoomMessageView[] {
    const room = this.roomRow(userId, roomId);
    this.dropOldRoomMessages();
    const rows = (
      this.db
        .prepare('SELECT m.id, m.sender_id, m.body, m.created_at, m.deleted_at, u.handle, u.display_name FROM room_messages m JOIN users u ON u.id = m.sender_id WHERE m.room_id = ? ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?')
        .all(room.id, limit) as { id: string; sender_id: string; body: string; created_at: number; deleted_at: number | null; handle: string; display_name: string }[]
    ).reverse();
    this.db.prepare('INSERT INTO room_reads (room_id, user_id, read_at) VALUES (?, ?, ?) ON CONFLICT (room_id, user_id) DO UPDATE SET read_at = excluded.read_at').run(room.id, userId, Date.now());
    return rows.map((r) => ({
      id: r.id,
      mine: r.sender_id === userId,
      from: { name: r.display_name, handle: r.handle },
      text: r.deleted_at ? '' : r.body,
      at: r.created_at,
      deleted: r.deleted_at !== null,
      files: r.deleted_at
        ? []
        : (this.db.prepare('SELECT id, name, mime, size FROM room_files WHERE message_id = ? AND expires_at > ? ORDER BY created_at').all(r.id, Date.now()) as { id: string; name: string; mime: string; size: number }[]),
    }));
  }

  /**
   * Writes in a room, as the person typed it. Refused: before accepting the circle's rules, while timed out, in the
   * announcements room for anyone but hosts, faster than the room's slow mode, a link in a new member's first day,
   * hidden characters, too long, or too many in a day.
   */
  postRoomMessage(userId: string, roomId: string, typed: string, alone?: 'voice' | 'file'): string {
    const room = this.roomRow(userId, roomId);
    const space = this.space(userId, room.circle_id);
    // A voice note or a file alone says what it is.
    const text = typed.replace(/\r\n?/g, '\n').trim() || (alone === 'voice' ? VOICE_NOTE : alone === 'file' ? FILE_ONLY : '');
    if (!text) throw new KlatschError('invalid', MESSAGE.empty);
    if (text.length > ROOM_MESSAGE_MAX) throw new KlatschError('invalid', MESSAGE.tooLong);
    refuseHidden(text);
    if (space.mustAccept) throw new KlatschError('forbidden', ROOM.acceptRules);
    if (space.timeoutUntil) throw new KlatschError('forbidden', ROOM.timedOut(space.timeoutUntil));
    if (room.announce && !space.host) throw new KlatschError('forbidden', ROOM.announceOnly);
    const now = Date.now();
    if (!space.host && space.slowSeconds > 0) {
      const last = (this.db.prepare('SELECT max(created_at) AS at FROM room_messages WHERE room_id = ? AND sender_id = ?').get(room.id, userId) as { at: number | null }).at;
      if (last && now - last < space.slowSeconds * 1000) throw new KlatschError('forbidden', ROOM.slow(space.slowSeconds));
    }
    const joined = (this.db.prepare('SELECT created_at FROM memberships WHERE circle_id = ? AND user_id = ?').get(room.circle_id, userId) as { created_at: number }).created_at;
    if (!space.host && now - joined < NEW_MEMBER_MS && /https?:\/\/|www\./i.test(text)) throw new KlatschError('forbidden', ROOM.newMemberLinks);
    const today = (this.db.prepare('SELECT count(*) AS n FROM room_messages WHERE sender_id = ? AND created_at > ?').get(userId, now - DAY) as { n: number }).n;
    if (today >= ROOM_MESSAGES_PER_DAY) throw new KlatschError('forbidden', ROOM.tooMany);
    const id = newId('rm');
    this.db.prepare('INSERT INTO room_messages (id, room_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)').run(id, room.id, userId, sealText(this.db, text), now);
    this.db.prepare('INSERT INTO room_reads (room_id, user_id, read_at) VALUES (?, ?, ?) ON CONFLICT (room_id, user_id) DO UPDATE SET read_at = excluded.read_at').run(room.id, userId, now);
    this.audit(userId, 'web', 'room.post', id);
    // Who hears of it: members who want everything, and those mentioned by @handle who want mentions. Never the words,
    // and no agent: rooms are not in the agent's inbox.
    const mentioned = new Set([...text.matchAll(/(?:^|[^\w@])@([a-z0-9][a-z0-9-]{0,38})/gi)].map((m) => m[1]!.toLowerCase()));
    const members = this.db
      .prepare(`SELECT u.id, u.handle, coalesce(p.notify, 'mentions') AS notify FROM memberships m JOIN users u ON u.id = m.user_id LEFT JOIN circle_people p ON p.circle_id = m.circle_id AND p.user_id = m.user_id WHERE m.circle_id = ? AND m.user_id != ?`)
      .all(room.circle_id, userId) as { id: string; handle: string; notify: 'all' | 'mentions' | 'none' }[];
    for (const m of members) {
      const isMentioned = mentioned.has(m.handle);
      if (m.notify === 'none') continue;
      if (isMentioned) this.notifyUser(m.id, notifications.mention);
      else if (m.notify === 'all') this.notifyUser(m.id, notifications.room);
    }
    return id;
  }

  /** Deletes a room message: its writer, or a host of the circle. Its words go; the room shows that it was deleted. */
  deleteRoomMessage(userId: string, messageId: string): string {
    const row = this.db.prepare('SELECT m.id, m.sender_id, m.room_id, r.circle_id FROM room_messages m JOIN rooms r ON r.id = m.room_id WHERE m.id = ?').get(messageId) as
      | { id: string; sender_id: string; room_id: string; circle_id: string }
      | undefined;
    if (!row) throw new KlatschError('not-found', ROOM.noMessage);
    this.spaceRow(userId, row.circle_id);
    if (row.sender_id !== userId && !this.isHost(userId, row.circle_id)) throw new KlatschError('forbidden', ROOM.hostsOnly);
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM room_files WHERE message_id = ?').run(messageId);
      this.db.prepare('UPDATE room_messages SET body = ?, deleted_at = ?, deleted_by = ? WHERE id = ?').run(sealText(this.db, ''), Date.now(), userId, messageId);
      this.db.prepare('UPDATE room_reports SET resolved_at = ?, resolved_by = ? WHERE message_id = ? AND resolved_at IS NULL').run(Date.now(), userId, messageId);
      this.audit(userId, 'web', row.sender_id === userId ? 'room.delete' : 'room.moderate.delete', messageId);
    });
    return row.room_id;
  }

  /** Reports a room message to the circle's hosts, once per person. Returns the room. */
  reportRoomMessage(userId: string, messageId: string, reason: string): string {
    const row = this.db.prepare('SELECT m.id, m.sender_id, m.room_id, r.circle_id FROM room_messages m JOIN rooms r ON r.id = m.room_id WHERE m.id = ? AND m.deleted_at IS NULL').get(messageId) as
      | { id: string; sender_id: string; room_id: string; circle_id: string }
      | undefined;
    if (!row) throw new KlatschError('not-found', ROOM.noMessage);
    this.spaceRow(userId, row.circle_id);
    const clean = reason.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (clean) refuseHidden(clean);
    this.db.prepare('INSERT OR IGNORE INTO room_reports (id, message_id, reporter_id, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(newId('rr'), messageId, userId, clean ? sealText(this.db, clean) : null, Date.now());
    this.audit(userId, 'web', 'room.report', messageId);
    return row.room_id;
  }

  /** What waits for the hosts of a circle: open reports, oldest first. */
  roomReports(userId: string, circleId: string): RoomReportView[] {
    this.spaceRow(userId, circleId);
    this.refuseNonHost(userId, circleId);
    const rows = this.db
      .prepare(
        `SELECT p.id, p.reason, p.created_at, m.id AS message_id, m.room_id, m.body, s.handle AS s_handle, s.display_name AS s_name, q.handle AS q_handle, q.display_name AS q_name
         FROM room_reports p JOIN room_messages m ON m.id = p.message_id JOIN rooms r ON r.id = m.room_id JOIN users s ON s.id = m.sender_id JOIN users q ON q.id = p.reporter_id
         WHERE r.circle_id = ? AND p.resolved_at IS NULL ORDER BY p.created_at`,
      )
      .all(circleId) as { id: string; reason: string | null; created_at: number; message_id: string; room_id: string; body: string; s_handle: string; s_name: string; q_handle: string; q_name: string }[];
    return rows.map((r) => ({
      id: r.id,
      messageId: r.message_id,
      roomId: r.room_id,
      text: r.body,
      from: { name: r.s_name, handle: r.s_handle },
      reporter: { name: r.q_name, handle: r.q_handle },
      reason: r.reason,
      at: r.created_at,
    }));
  }

  /** A host leaves a report be: the message stays. */
  dismissReport(userId: string, reportId: string): string {
    const row = this.db.prepare('SELECT r.circle_id FROM room_reports p JOIN room_messages m ON m.id = p.message_id JOIN rooms r ON r.id = m.room_id WHERE p.id = ?').get(reportId) as { circle_id: string } | undefined;
    if (!row) throw new KlatschError('not-found', ROOM.noMessage);
    this.spaceRow(userId, row.circle_id);
    this.refuseNonHost(userId, row.circle_id);
    this.db.prepare('UPDATE room_reports SET resolved_at = ?, resolved_by = ? WHERE id = ?').run(Date.now(), userId, reportId);
    this.audit(userId, 'web', 'room.moderate.dismiss', reportId);
    return row.circle_id;
  }

  /** A host keeps someone from writing for a while (minutes; 0 lifts it). Hosts cannot be timed out by hosts; the owner never. */
  timeoutMember(userId: string, circleId: string, memberId: string, minutes: number): void {
    this.spaceRow(userId, circleId);
    this.refuseNonHost(userId, circleId);
    const role = this.memberRole(memberId, circleId);
    if (!role || memberId === userId || role === 'owner' || (this.isHost(memberId, circleId) && this.memberRole(userId, circleId) !== 'owner')) {
      throw new KlatschError('forbidden', ROOM.cannotTimeout);
    }
    const until = minutes > 0 ? Date.now() + Math.min(minutes, 7 * 24 * 60) * 60 * 1000 : null;
    this.setPerson(circleId, memberId, 'timeout_until', until);
    this.audit(userId, 'web', until ? 'room.moderate.timeout' : 'room.moderate.untimeout', circleId);
  }

  /** The owner makes a member a host, or no longer one. */
  setHost(userId: string, circleId: string, memberId: string, on: boolean): void {
    this.spaceRow(userId, circleId);
    if (this.memberRole(userId, circleId) !== 'owner') throw new KlatschError('forbidden', ROOM.ownerOnly);
    if (!this.memberRole(memberId, circleId) || memberId === userId) throw new KlatschError('forbidden', ROOM.cannotTimeout);
    this.setPerson(circleId, memberId, 'host', on ? 1 : 0);
    this.audit(userId, 'web', on ? 'circle.host.add' : 'circle.host.remove', circleId);
  }

  /** Hosts set the rules (shown before writing, accepted once) and the slow mode in seconds (0 is off). */
  setCircleSettings(userId: string, circleId: string, settings: { rules?: string; slowSeconds?: number }): void {
    this.spaceRow(userId, circleId);
    this.refuseNonHost(userId, circleId);
    transaction(this.db, () => {
      if (settings.rules !== undefined) {
        const rules = settings.rules.replace(/\r\n?/g, '\n').trim();
        if (rules.length > RULES_MAX) throw new KlatschError('invalid', ROOM.rulesTooLong);
        if (rules) refuseHidden(rules);
        const before = (this.db.prepare('SELECT rules FROM circles WHERE id = ?').get(circleId) as { rules: string | null }).rules ?? '';
        this.db.prepare('UPDATE circles SET rules = ? WHERE id = ?').run(rules ? sealText(this.db, rules) : null, circleId);
        // New rules are accepted again.
        if (rules !== before) this.db.prepare('UPDATE circle_people SET rules_at = NULL WHERE circle_id = ?').run(circleId);
      }
      if (settings.slowSeconds !== undefined) {
        const seconds = [0, 10, 30, 60, 300].includes(settings.slowSeconds) ? settings.slowSeconds : 0;
        this.db.prepare('UPDATE circles SET slow_seconds = ? WHERE id = ?').run(seconds, circleId);
      }
      this.audit(userId, 'web', 'circle.settings', circleId);
    });
  }

  /** What the person hears from a circle: everything, only mentions, or nothing. */
  setCircleNotify(userId: string, circleId: string, notify: string): void {
    this.spaceRow(userId, circleId);
    if (notify !== 'all' && notify !== 'mentions' && notify !== 'none') throw new KlatschError('invalid', ROOM.badNotify);
    this.setPerson(circleId, userId, 'notify', notify);
  }

  acceptRules(userId: string, circleId: string): void {
    this.spaceRow(userId, circleId);
    this.setPerson(circleId, userId, 'rules_at', Date.now());
  }

  /** Hosts add a room; announcement rooms only hosts write in. */
  addRoom(userId: string, circleId: string, name: string, announce = false): string {
    this.spaceRow(userId, circleId);
    this.refuseNonHost(userId, circleId);
    const clean = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
    if (!clean) throw new KlatschError('invalid', ROOM.badName);
    this.ensureRooms(circleId);
    const count = (this.db.prepare('SELECT count(*) AS n FROM rooms WHERE circle_id = ?').get(circleId) as { n: number }).n;
    if (count >= ROOMS_PER_CIRCLE) throw new KlatschError('forbidden', ROOM.tooManyRooms);
    if (this.db.prepare('SELECT 1 FROM rooms WHERE circle_id = ? AND name = ?').get(circleId, clean)) throw new KlatschError('invalid', ROOM.nameTaken);
    const id = newId('room');
    this.db.prepare('INSERT INTO rooms (id, circle_id, name, announce, created_at) VALUES (?, ?, ?, ?, ?)').run(id, circleId, clean, announce ? 1 : 0, Date.now());
    this.audit(userId, 'web', 'room.add', id);
    return id;
  }

  /** Whether the person may write in this circle now (rules accepted, not paused); the reason if not. */
  private refuseSilenced(userId: string, circleId: string): void {
    const space = this.space(userId, circleId);
    if (space.mustAccept) throw new KlatschError('forbidden', ROOM.acceptRules);
    if (space.timeoutUntil) throw new KlatschError('forbidden', ROOM.timedOut(space.timeoutUntil));
  }

  private cleanWords(typed: string, max: number, empty: string): string {
    const text = typed.replace(/\r\n?/g, '\n').trim();
    if (!text) throw new KlatschError('invalid', empty);
    if (text.length > max) throw new KlatschError('invalid', ASKAROUND.tooLong(max));
    refuseHidden(text);
    return text;
  }

  /** Asks the circle: a title, and details if any. */
  askAround(userId: string, circleId: string, title: string, body = ''): string {
    this.spaceRow(userId, circleId);
    this.refuseSilenced(userId, circleId);
    const cleanTitle = this.cleanWords(title, QUESTION_TITLE_MAX, ASKAROUND.noTitle).replace(/\s+/g, ' ');
    const details = body.trim() ? this.cleanWords(body, QUESTION_BODY_MAX, ASKAROUND.noTitle) : null;
    const today = (this.db.prepare('SELECT count(*) AS n FROM questions WHERE author_id = ? AND created_at > ?').get(userId, Date.now() - DAY) as { n: number }).n;
    if (today >= QUESTIONS_PER_DAY) throw new KlatschError('forbidden', ASKAROUND.tooMany);
    const id = newId('q');
    this.db.prepare('INSERT INTO questions (id, circle_id, author_id, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, circleId, userId, sealText(this.db, cleanTitle), details ? sealText(this.db, details) : null, Date.now());
    this.audit(userId, 'web', 'question.ask', id);
    return id;
  }

  private questionRow(userId: string, questionId: string) {
    const row = this.db.prepare('SELECT id, circle_id, author_id, title, body, created_at, solved_by, picked_at FROM questions WHERE id = ? AND deleted_at IS NULL').get(questionId) as
      | { id: string; circle_id: string; author_id: string; title: string; body: string | null; created_at: number; solved_by: string | null; picked_at: number | null }
      | undefined;
    if (!row) throw new KlatschError('not-found', ASKAROUND.gone);
    this.spaceRow(userId, row.circle_id);
    return row;
  }

  /** A circle's questions, newest first; `state` open or answered; `q` matches words in the title. */
  questionsOf(userId: string, circleId: string, options: { state?: 'open' | 'answered' | 'picks'; q?: string } = {}): QuestionSummary[] {
    this.spaceRow(userId, circleId);
    const rows = this.db
      .prepare(
        `SELECT q.id, q.title, q.author_id, q.created_at, q.solved_by, q.picked_at, u.handle, u.display_name,
           (SELECT count(*) FROM answers a WHERE a.question_id = q.id AND a.deleted_at IS NULL) AS answers
         FROM questions q JOIN users u ON u.id = q.author_id WHERE q.circle_id = ? AND q.deleted_at IS NULL ORDER BY q.created_at DESC LIMIT 300`,
      )
      .all(circleId) as { id: string; title: string; author_id: string; created_at: number; solved_by: string | null; picked_at: number | null; handle: string; display_name: string; answers: number }[];
    // The words are sealed: a search reads them here, never in the database.
    const words = (options.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    return rows
      .map((r) => ({ id: r.id, title: r.title, author: { name: r.display_name, handle: r.handle }, mine: r.author_id === userId, answers: r.answers, solved: r.solved_by !== null, picked: r.picked_at !== null, at: r.created_at }))
      .filter((q) => (options.state === 'open' ? !q.solved : options.state === 'answered' ? q.solved : options.state === 'picks' ? q.picked : true))
      .filter((q) => words.every((w) => q.title.toLowerCase().includes(w)));
  }

  question(userId: string, questionId: string): QuestionView {
    const row = this.questionRow(userId, questionId);
    const author = this.user(row.author_id);
    const answers = this.db
      .prepare(
        `SELECT a.id, a.author_id, a.body, a.created_at, u.handle, u.display_name,
           (SELECT count(*) FROM answer_helped h WHERE h.answer_id = a.id) AS helped,
           EXISTS (SELECT 1 FROM answer_helped h WHERE h.answer_id = a.id AND h.user_id = ?) AS mine_helped
         FROM answers a JOIN users u ON u.id = a.author_id WHERE a.question_id = ? AND a.deleted_at IS NULL ORDER BY a.created_at`,
      )
      .all(userId, questionId) as { id: string; author_id: string; body: string; created_at: number; handle: string; display_name: string; helped: number; mine_helped: number }[];
    const list = answers
      .map((a) => ({ id: a.id, author: { name: a.display_name, handle: a.handle }, mine: a.author_id === userId, text: a.body, at: a.created_at, helped: a.helped, helpedByMe: a.mine_helped === 1, solved: a.id === row.solved_by }))
      // The one that solved it first, then the most helpful, then the oldest.
      .sort((x, y) => Number(y.solved) - Number(x.solved) || y.helped - x.helped || x.at - y.at);
    return {
      id: row.id,
      circleId: row.circle_id,
      title: row.title,
      body: row.body,
      author: { name: author.display_name, handle: author.handle },
      mine: row.author_id === userId,
      answers: list.length,
      solved: row.solved_by !== null,
      picked: row.picked_at !== null,
      at: row.created_at,
      answerList: list,
      canDelete: row.author_id === userId || this.isHost(userId, row.circle_id),
    };
  }

  /** Answers a question; its asker hears that an answer came, without the words. */
  answerQuestion(userId: string, questionId: string, typed: string): string {
    const row = this.questionRow(userId, questionId);
    this.refuseSilenced(userId, row.circle_id);
    const text = this.cleanWords(typed, ANSWER_BODY_MAX, ASKAROUND.noAnswer);
    const id = newId('ans');
    this.db.prepare('INSERT INTO answers (id, question_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)').run(id, questionId, userId, sealText(this.db, text), Date.now());
    this.audit(userId, 'web', 'question.answer', id);
    if (row.author_id !== userId) this.notifyUser(row.author_id, notifications.answer);
    return id;
  }

  private answerRow(userId: string, answerId: string) {
    const row = this.db.prepare('SELECT a.id, a.author_id, a.question_id, q.author_id AS asker_id, q.circle_id FROM answers a JOIN questions q ON q.id = a.question_id WHERE a.id = ? AND a.deleted_at IS NULL AND q.deleted_at IS NULL').get(answerId) as
      | { id: string; author_id: string; question_id: string; asker_id: string; circle_id: string }
      | undefined;
    if (!row) throw new KlatschError('not-found', ASKAROUND.gone);
    this.spaceRow(userId, row.circle_id);
    return row;
  }

  /** The asker marks the answer that solved it (again to unmark). Returns the question. */
  solveWith(userId: string, answerId: string): string {
    const row = this.answerRow(userId, answerId);
    if (row.asker_id !== userId) throw new KlatschError('forbidden', ASKAROUND.askerOnly);
    const current = (this.db.prepare('SELECT solved_by FROM questions WHERE id = ?').get(row.question_id) as { solved_by: string | null }).solved_by;
    this.db.prepare('UPDATE questions SET solved_by = ? WHERE id = ?').run(current === answerId ? null : answerId, row.question_id);
    if (current !== answerId && row.author_id !== userId) this.notifyUser(row.author_id, notifications.solved);
    this.audit(userId, 'web', 'question.solve', answerId);
    return row.question_id;
  }

  /** "Helped me too", once per person (again to take it back); not on one's own answer. Returns the question. */
  helpedToo(userId: string, answerId: string): string {
    const row = this.answerRow(userId, answerId);
    if (row.author_id === userId) throw new KlatschError('forbidden', ASKAROUND.notOwn);
    const had = this.db.prepare('DELETE FROM answer_helped WHERE answer_id = ? AND user_id = ?').run(answerId, userId).changes;
    if (!had) this.db.prepare('INSERT INTO answer_helped (answer_id, user_id, created_at) VALUES (?, ?, ?)').run(answerId, userId, Date.now());
    return row.question_id;
  }

  /** A question goes, with its answers: its asker, or a host. Returns the circle. */
  deleteQuestion(userId: string, questionId: string): string {
    const row = this.questionRow(userId, questionId);
    if (row.author_id !== userId && !this.isHost(userId, row.circle_id)) throw new KlatschError('forbidden', ROOM.hostsOnly);
    transaction(this.db, () => {
      this.db.prepare('UPDATE answers SET body = ?, deleted_at = ? WHERE question_id = ? AND deleted_at IS NULL').run(sealText(this.db, ''), Date.now(), questionId);
      this.db.prepare('UPDATE questions SET title = ?, body = NULL, deleted_at = ? WHERE id = ?').run(sealText(this.db, ''), Date.now(), questionId);
      this.audit(userId, 'web', row.author_id === userId ? 'question.delete' : 'question.moderate.delete', questionId);
    });
    return row.circle_id;
  }

  /** An answer goes: its writer, or a host. Returns the question. */
  deleteAnswer(userId: string, answerId: string): string {
    const row = this.answerRow(userId, answerId);
    if (row.author_id !== userId && !this.isHost(userId, row.circle_id)) throw new KlatschError('forbidden', ROOM.hostsOnly);
    transaction(this.db, () => {
      this.db.prepare('UPDATE answers SET body = ?, deleted_at = ? WHERE id = ?').run(sealText(this.db, ''), Date.now(), answerId);
      this.db.prepare('UPDATE questions SET solved_by = NULL WHERE id = ? AND solved_by = ?').run(row.question_id, answerId);
      this.audit(userId, 'web', row.author_id === userId ? 'answer.delete' : 'answer.moderate.delete', answerId);
    });
    return row.question_id;
  }

  /** Hosts add a question to the circle's Picks, or take it out. Returns the question. */
  pickQuestion(userId: string, questionId: string, on: boolean): string {
    const row = this.questionRow(userId, questionId);
    this.refuseNonHost(userId, row.circle_id);
    this.db.prepare('UPDATE questions SET picked_at = ? WHERE id = ?').run(on ? Date.now() : null, questionId);
    this.audit(userId, 'web', on ? 'question.pick' : 'question.unpick', questionId);
    return questionId;
  }

  /** The owner lists the circle in Explore with a line about it, or takes it out. Never a friendship or a public circle. */
  setListing(userId: string, circleId: string, listed: boolean, about: string): void {
    const row = this.spaceRow(userId, circleId);
    if (row.role !== 'owner') throw new KlatschError('forbidden', ROOM.ownerOnly);
    const line = about.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (line) refuseHidden(line);
    if (listed && !line) throw new KlatschError('invalid', ROOM.aboutNeeded);
    this.db.prepare('UPDATE circles SET listed = ?, about = ? WHERE id = ?').run(listed ? 1 : 0, line ? sealText(this.db, line) : null, circleId);
    this.audit(userId, 'web', listed ? 'circle.list' : 'circle.unlist', circleId);
  }

  /** Explore: circles their owners listed, that the person is not in and was not removed from; `q` matches name or line. */
  explore(userId: string, q = ''): ListedCircle[] {
    if (this.isGuest(userId)) return [];
    const rows = this.db
      .prepare(
        `SELECT c.id, c.name, c.about, (SELECT count(*) FROM memberships m WHERE m.circle_id = c.id) AS people,
           EXISTS (SELECT 1 FROM join_requests r WHERE r.circle_id = c.id AND r.user_id = ? AND r.decided_at IS NULL) AS asked
         FROM circles c WHERE c.listed = 1 AND c.pair = 0 AND c.ended_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.circle_id = c.id AND m.user_id = ?)
           AND NOT EXISTS (SELECT 1 FROM removals x WHERE x.circle_id = c.id AND x.user_id = ?)
         ORDER BY people DESC, c.created_at LIMIT 200`,
      )
      .all(userId, userId, userId) as { id: string; name: string; about: string | null; people: number; asked: number }[];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return rows
      .map((r) => ({ id: r.id, name: r.name, about: r.about, people: r.people, asked: r.asked === 1 }))
      .filter((c) => words.every((w) => `${c.name} ${c.about ?? ''}`.toLowerCase().includes(w)));
  }

  /** Asks to join a listed circle; its hosts decide. Not a guest, not someone removed, at most 20 a day. */
  requestToJoin(userId: string, circleId: string): void {
    if (this.isGuest(userId)) throw new KlatschError('forbidden', GUEST.guestsOnly);
    const listed = this.db.prepare('SELECT 1 FROM circles WHERE id = ? AND listed = 1 AND pair = 0 AND ended_at IS NULL').get(circleId);
    if (!listed || this.memberRole(userId, circleId) || this.isRemoved(userId, circleId)) throw new KlatschError('not-found', ROOM.noCircle);
    const today = (this.db.prepare('SELECT count(*) AS n FROM join_requests WHERE user_id = ? AND created_at > ?').get(userId, Date.now() - DAY) as { n: number }).n;
    if (today >= 20) throw new KlatschError('forbidden', ROOM.tooManyRequests);
    this.db
      .prepare('INSERT INTO join_requests (circle_id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT (circle_id, user_id) DO UPDATE SET created_at = excluded.created_at, decided_at = NULL, accepted = NULL')
      .run(circleId, userId, Date.now());
    const hosts = this.db.prepare(`SELECT user_id FROM memberships WHERE circle_id = ? AND role = 'owner' UNION SELECT user_id FROM circle_people WHERE circle_id = ? AND host = 1`).all(circleId, circleId) as { user_id: string }[];
    for (const h of hosts) this.notifyUser(h.user_id, notifications.joinRequest);
    this.audit(userId, 'web', 'circle.request', circleId);
  }

  /** Waiting requests to join, for the circle's hosts. */
  joinRequests(userId: string, circleId: string): JoinRequestView[] {
    this.spaceRow(userId, circleId);
    this.refuseNonHost(userId, circleId);
    return (
      this.db
        .prepare('SELECT r.user_id, r.created_at, u.handle, u.display_name FROM join_requests r JOIN users u ON u.id = r.user_id WHERE r.circle_id = ? AND r.decided_at IS NULL ORDER BY r.created_at')
        .all(circleId) as { user_id: string; created_at: number; handle: string; display_name: string }[]
    ).map((r) => ({ userId: r.user_id, name: r.display_name, handle: r.handle, at: r.created_at }));
  }

  /** A host lets someone in, or not; they hear which, without more. */
  decideJoin(userId: string, circleId: string, requesterId: string, accept: boolean): void {
    this.spaceRow(userId, circleId);
    this.refuseNonHost(userId, circleId);
    const waiting = this.db.prepare('SELECT 1 FROM join_requests WHERE circle_id = ? AND user_id = ? AND decided_at IS NULL').get(circleId, requesterId);
    if (!waiting) throw new KlatschError('not-found', ROOM.noRequest);
    transaction(this.db, () => {
      this.db.prepare('UPDATE join_requests SET decided_at = ?, accepted = ? WHERE circle_id = ? AND user_id = ?').run(Date.now(), accept ? 1 : 0, circleId, requesterId);
      if (accept && !this.memberRole(requesterId, circleId)) this.addMember(circleId, requesterId, userId);
      this.audit(userId, 'web', accept ? 'circle.request.accept' : 'circle.request.decline', circleId);
    });
    this.notifyUser(requesterId, accept ? notifications.joinAccepted : notifications.joinDeclined);
  }

  /** Room messages go after the same 90 days as messages between friends. */
  private dropOldRoomMessages(): void {
    const old = Date.now() - MESSAGE_DAYS * DAY;
    if (!this.db.prepare('SELECT 1 FROM room_messages WHERE created_at < ? LIMIT 1').get(old)) return;
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM room_reports WHERE message_id IN (SELECT id FROM room_messages WHERE created_at < ?)').run(old);
      this.db.prepare('DELETE FROM room_files WHERE message_id IN (SELECT id FROM room_messages WHERE created_at < ?)').run(old);
      this.db.prepare('DELETE FROM room_messages WHERE created_at < ?').run(old);
    });
  }

  private unreadFrom(userId: string, circleId: string): number {
    return (this.db.prepare('SELECT count(*) AS n FROM messages WHERE circle_id = ? AND recipient_id = ? AND read_at IS NULL').get(circleId, userId) as { n: number }).n;
  }

  /** Every friend with the last message and how many of theirs wait unread: for Home, the Circle page and `friends`. */
  conversationsOf(userId: string): ConversationSummary[] {
    this.dropOldMessages();
    const friends = this.db
      .prepare(
        `SELECT c.id AS circle_id, u.id AS user_id, u.handle, u.display_name FROM memberships mine
         JOIN circles c ON c.id = mine.circle_id AND c.pair = 1 AND c.ended_at IS NULL
         JOIN memberships o ON o.circle_id = c.id AND o.user_id != mine.user_id JOIN users u ON u.id = o.user_id
         WHERE mine.user_id = ?`,
      )
      .all(userId) as { circle_id: string; user_id: string; handle: string; display_name: string }[];
    return friends
      .map((f) => {
        const last = this.db
          .prepare(
            `SELECT m.sender_id, m.body, m.created_at, m.deleted_at FROM messages m LEFT JOIN message_marks k ON k.message_id = m.id AND k.user_id = ?
             WHERE m.circle_id = ? AND k.hidden_at IS NULL ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`,
          )
          .get(userId, f.circle_id) as { sender_id: string; body: string; created_at: number; deleted_at: number | null } | undefined;
        return {
          circleId: f.circle_id,
          other: { name: f.display_name, handle: f.handle },
          unread: this.unreadFrom(userId, f.circle_id),
          ...(last ? { last: { mine: last.sender_id === userId, text: last.deleted_at ? '' : last.body, at: last.created_at, ...(last.deleted_at ? { deleted: true } : {}) } } : {}),
        };
      })
      .sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0) || a.other.handle.localeCompare(b.other.handle));
  }

  /**
   * The person hands the conversation to their own agent, once, by a click in their session (page or card): the
   * friend's recent messages go to its inbox, so it can draft a reply. Nothing reaches the agent otherwise.
   */
  sendConversationToAgent(userId: string, handle: string, via: Via = 'web', how?: string): { from: string } {
    const directions = this.cleanHow(how);
    const { circleId, other } = this.friendFor(userId, handle);
    const from = agentHandle(other.handle);
    if (!from) throw new KlatschError('forbidden', MESSAGE.noFriend);
    transaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE messages SET for_agent = 1 WHERE id IN (SELECT id FROM messages WHERE circle_id = ? AND recipient_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT ${THREAD_FOR_AGENT})`,
        )
        .run(circleId, userId, Date.now() - 7 * DAY);
      this.event(userId, 'message.thread', circleId, true, directions);
      this.audit(userId, via, 'message.send-to-agent', circleId);
    });
    return { from };
  }

  /**
   * The conversation for an agent, once per click or "always": the friend's messages its human let through (and
   * the human's own last words around them, for context), cleaned and labelled; then the flags are cleared.
   */
  private deliverThread(userId: string, ref: string): InboxEvent | undefined {
    const circleId = ref.startsWith('m_')
      ? (this.db.prepare('SELECT circle_id FROM messages WHERE id = ? AND recipient_id = ?').get(ref, userId) as { circle_id: string } | undefined)?.circle_id
      : ref;
    if (!circleId) return undefined;
    const otherId = (this.db.prepare('SELECT user_id FROM memberships WHERE circle_id = ? AND user_id != ?').get(circleId, userId) as { user_id: string } | undefined)?.user_id;
    if (!otherId || this.friendshipOf(userId, otherId) !== circleId) return undefined;
    const waiting = this.db.prepare('SELECT min(created_at) AS since FROM messages WHERE circle_id = ? AND recipient_id = ? AND for_agent = 1').get(circleId, userId) as {
      since: number | null;
    };
    if (waiting.since === null) return undefined;
    const rows = this.db
      .prepare(
        `SELECT sender_id, body, created_at, for_agent FROM messages WHERE circle_id = ? AND created_at >= ? AND deleted_at IS NULL ORDER BY created_at, rowid LIMIT ${THREAD_FOR_AGENT * 2}`,
      )
      .all(circleId, waiting.since) as { sender_id: string; body: string; created_at: number; for_agent: number }[];
    this.db.prepare('UPDATE messages SET for_agent = 0 WHERE circle_id = ? AND recipient_id = ? AND for_agent = 1').run(circleId, userId);
    const from = agentHandle(this.user(otherId).handle);
    if (!from) return undefined;
    const auto = this.hasGrant(userId, otherId, 'deliver');
    const messages = rows
      .filter((r) => r.sender_id === userId || r.for_agent === 1)
      .map((r) => ({ from: r.sender_id === userId ? 'you' : from, text: clip(cleanQuote(r.body), MESSAGE_MAX), at: new Date(r.created_at).toISOString() }));
    this.audit(userId, 'mcp', 'message.deliver', circleId);
    return {
      kind: 'message.thread',
      ref: circleId,
      at: new Date().toISOString(),
      type: 'quote',
      from,
      quote: clip(messages.filter((m) => m.from !== 'you').map((m) => m.text).join('\n'), 2000),
      messages,
      text: MESSAGE.threadLine(from, auto),
      note: MESSAGE.threadNote(from, auto),
    };
  }

  /** Messages are kept 90 days. */
  private dropOldMessages(): void {
    const old = Date.now() - MESSAGE_DAYS * DAY;
    if (!this.db.prepare('SELECT 1 FROM messages WHERE created_at < ? LIMIT 1').get(old)) return;
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM message_files WHERE message_id IN (SELECT id FROM messages WHERE created_at < ?)').run(old);
      this.db.prepare('DELETE FROM message_marks WHERE message_id IN (SELECT id FROM messages WHERE created_at < ?)').run(old);
      this.db.prepare('DELETE FROM messages WHERE created_at < ?').run(old);
    });
  }

  /** A friendship ended: its conversation and files go, for both. */
  private dropConversation(circleId: string): void {
    this.db.prepare('DELETE FROM message_files WHERE message_id IN (SELECT id FROM messages WHERE circle_id = ?)').run(circleId);
    this.db.prepare('DELETE FROM message_marks WHERE message_id IN (SELECT id FROM messages WHERE circle_id = ?)').run(circleId);
    this.db.prepare(`DELETE FROM events WHERE kind IN ('message.received', 'message.thread') AND (ref = ? OR ref IN (SELECT id FROM messages WHERE circle_id = ?))`).run(circleId, circleId);
    this.db.prepare('DELETE FROM messages WHERE circle_id = ?').run(circleId);
  }

  /** The person asked writes the answer themselves, on their page: their click is the approval. */
  answerByHand(helperId: string, askId: string, typed: string): void {
    const answer = typed.replace(/\r\n?/g, '\n');
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
    // The demo friend writes back to the answer in the conversation, as a friend would.
    if (this.isDemo(row.asker_id) && this.friendshipOf(row.asker_id, helperId)) {
      const handle = this.user(helperId).handle;
      this.asDemo(() => this.sendMessage(row.asker_id, handle, DEMO.answered(answer), 'cli'));
    }
    this.notifyUser(row.asker_id, notifications.other);
  }

  /**
   * The person's own word on how their agent should answer ("yes, 9 is fine, keep it short"), or undefined when
   * they left it empty. One line, nothing hidden, at most HOW_MAX characters.
   */
  private cleanHow(how: string | undefined): string | undefined {
    const clean = how?.replace(/\s+/g, ' ').trim();
    if (!clean) return undefined;
    if (clean.length > HOW_MAX) throw new KlatschError('invalid', `Say how to answer in at most ${HOW_MAX} characters.`);
    refuseHidden(clean);
    return clean;
  }

  /** The person asked hands the question to their own agent, once, by a click in their session. */
  sendAskToAgent(userId: string, askId: string, how?: string): { from: string } {
    const directions = this.cleanHow(how);
    const row = this.askRow(askId);
    if (row?.helper_id === userId) {
      const { asker } = this.openAskFor(userId, askId);
      this.db.prepare('UPDATE asks SET question_for_agent = 1 WHERE id = ?').run(askId);
      this.event(userId, 'ask.question', askId, true, directions);
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
    // Taken back: its files go with it, so an old link opens nothing.
    this.db.prepare('DELETE FROM attachments WHERE ask_id = ?').run(askId);
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
          attachments: this.attachmentsOf(userId, row.id),
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
      ...(() => {
        const files = this.attachmentsOf(userId, askId)
          .filter((f) => f.side === (answer ? 'answer' : 'question'))
          .map((f) => ({ type: f.mime, size: f.size }));
        return files.length ? { files } : {};
      })(),
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
    const writers = this.db
      .prepare(
        `SELECT DISTINCT u.handle FROM events e JOIN messages m ON m.id = e.ref JOIN users u ON u.id = m.sender_id
         WHERE e.user_id = ? AND e.read_at IS NULL AND e.kind IN ('message.received', 'message.thread')`,
      )
      .all(userId) as { handle: string }[];
    const messagesFrom = writers.map((row) => agentHandle(row.handle)).filter((h): h is string => Boolean(h)).slice(0, 10);
    return {
      messages: count('message.received') + count('message.thread'),
      messagesFrom,
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
        .prepare(`SELECT id, kind, ref, created_at, how FROM events WHERE user_id = ? AND read_at IS NULL AND kind != 'sip.draft' ORDER BY id`)
        .all(userId) as { id: number; kind: string; ref: string; created_at: number; how: string | null }[];
      /** The person's directions, with the event that carried them: shown to their own agent with the quote. */
      const withHow = (event: InboxEvent | undefined, how: string | null): InboxEvent[] =>
        !event ? [] : how ? [{ ...event, how, note: `${event.note ?? ''}${HOW_NOTE}`.trim() }] : [event];
      if (rows.length) {
        this.db.prepare('UPDATE events SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id <= ?').run(Date.now(), userId, rows.at(-1)!.id);
      }
      this.audit(userId, 'mcp', 'inbox.read', String(rows.length));
      return rows.flatMap((row): InboxEvent[] => {
        const at = new Date(row.created_at).toISOString();
        if (row.kind === 'ask.question' || row.kind === 'ask.answer') {
          // An event the person caused (their click) does not wake; one a standing "always" brought does.
          const auto = Boolean((this.db.prepare('SELECT wakes FROM events WHERE id = ?').get(row.id) as { wakes: number } | undefined)?.wakes);
          return withHow(this.deliverAsk(userId, row.ref, row.kind === 'ask.answer', auto), row.how);
        }
        if (row.kind === 'message.thread') {
          return withHow(this.deliverThread(userId, row.ref), row.how);
        }
        if (row.kind === 'message.received') {
          const sender = (this.db.prepare('SELECT sender_id FROM messages WHERE id = ? AND recipient_id = ?').get(row.ref, userId) as { sender_id: string } | undefined)?.sender_id;
          const other = sender ? agentHandle(this.user(sender).handle) : undefined;
          if (!other) return [];
          return [{ kind: row.kind, ref: row.ref, text: this.render(row.kind, row.ref, other), at, with: other }];
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
  private event(userId: string, kind: string, ref: string, ownAction = false, how?: string): void {
    const wakes = (WAKES as readonly string[]).includes(kind) && !ownAction;
    this.db
      .prepare('INSERT INTO events (user_id, kind, ref, created_at, wakes, how) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, kind, ref, Date.now(), wakes ? 1 : 0, how ? sealText(this.db, how) : null);
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
