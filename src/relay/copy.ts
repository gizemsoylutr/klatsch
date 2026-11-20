import { html } from 'hono/html';
import { consent } from '../copy/consent.ts';
import { handoff } from '../copy/handoff.ts';
import { notifications } from '../copy/notifications.ts';
import { thanks } from '../copy/thanks.ts';

/**
 * Every word a person reads in the web UI, in notifications and in mails, grouped by screen.
 * Agent-facing text (tool descriptions, inbox templates, errors returned to agents) lives with its code.
 *
 * Voice: English, lightly playful. Metaphor only in headings; buttons are plain verbs; every approval
 * says plainly what will happen; sign-in, tokens, member removal and errors stay plain. No emoji
 * except the one ☕ in notifications. Values are escaped by `html` wherever they are interpolated.
 */
export const copy = {
  layout: {
    brand: 'Klatsch',
    /** The top bar's tabs. */
    nav: { label: 'Main', home: 'Home', notes: 'Notes', circle: 'Circle', tokens: 'Tokens', settings: 'Settings' },
    settings: 'Settings',
    home: 'Go to Home',
    back: 'Back',
    notPossible: 'Not possible',
    crossOrigin: 'Cross-origin request refused.',
    badFormToken: 'Invalid form token.',
    /** Shown next to any summary with possible identifiers in it. */
    flagged: 'Check before sharing:',
  },

  /**
   * The bare relay address in a browser: what Klatsch is, before anyone signs in. The example in the hero
   * is made up and generic: no real hostnames, people or customers.
   */
  landing: {
    title: 'Ask your friends from any chat',
    nav: { label: 'Sections', how: 'How it works', privacy: 'Privacy', tools: 'Works with', selfHost: 'Self-host' },
    signIn: 'Sign in',
    signInGitHub: 'Sign in with GitHub',
    eyebrow: ['Open source', 'Works in ChatGPT, Claude and your coding agent'],
    headline: ['Ask your friends.', 'From any chat.'],
    name: 'Klatsch',
    lead: 'Write to a friend from the chat you are in: your AI drafts it, you send it, only your friend reads it. Their reply shows up in your chat.',
    howLink: 'See how it works',
    demo: ['npx klatsch up --demo', 'try it locally in a minute'],
    /** The relay's own MCP address, for chat apps that add a server by its URL. */
    connector: (url: string) => [url, 'add it as a connector in ChatGPT or Claude, then sign in here'] as const,
    example: {
      caption: 'Example: an agent asks in the terminal, and the person decides on the page Klatsch opens.',
      terminalTitle: 'claude · ~/shop-api',
      terminal: html`<span class="d">›</span> the payment webhook test keeps timing out on CI, no idea why

<span class="a">●</span> Ran the suite 3 times. Fails only on CI, after 30 s.
  Let me check whether someone in your circle hit this.

<span class="a">●</span> <b>klatsch</b> · update_card
  <span class="d">looking · tags: webhooks, ci, testing</span>
  <span class="d">"Payment webhook test hangs on CI only"</span>

  Waiting for you to approve it in the browser…
  <span class="ok">✓ Shared.</span> 1 match: a solved note, open to your circle.

<span class="a">●</span> <b>Bob</b> solved this in March:
  <span class="d">"CI has no outbound network. Run a mock of the payment</span>
  <span class="d"> API in a service container and point the base URL at it."</span>
  Applying that now.`,
      pageTitle: 'Klatsch',
      pageKicker: 'Your agent wants to share',
      summary: 'Payment webhook test hangs on CI only',
      tags: ['webhooks', 'ci', 'testing'],
      pageNote: 'Only these words and tags go to your circle. Nothing from your code or chat.',
      share: 'Share',
      notNow: 'Not now',
      circle: 'Circle: beta · 6 people',
    },
    how: {
      kicker: 'How it works',
      heading: ['Your agent asks.', 'People decide.'],
      sub: 'Each step that shares something is yours to approve. Nothing moves without a click in your own browser.',
      steps: [
        {
          title: 'Your agent drafts a sip',
          line: 'Stuck, or just learned something? Your agent writes one line and a few tags. That is all that ever leaves your machine.',
          window: 'Your card',
          example: html`<div class="person"><span class="av">S</span><span class="who"><b>Payment webhook test hangs on CI only</b><small>looking · webhooks, ci, testing</small></span><span class="state quiet">Draft</span></div>`,
        },
        {
          title: 'You share it, or not',
          line: 'Klatsch opens a page with the exact words. Share, or close the tab. Your agent can’t press the button for you.',
          window: 'Klatsch',
          example: html`<div class="row2"><span class="btn primary">Share</span><span class="btn quiet">Not now</span></div><p class="small">Or type the code your terminal shows: <b>KQTM-RZPW</b></p>`,
        },
        {
          title: 'Klatsch matches tags',
          line: '“Looking” meets “solved” on shared tags, inside your circles only. Notes you tick also show on your circle’s Notes page. Agents see ids and tags, never another person’s words.',
          window: 'Matches',
          example: html`<div class="person"><span class="av">B</span><span class="who"><b>Bob</b><small>solved · webhooks, ci</small></span><span class="state">Open note</span></div>
            <div class="person"><span class="av">?</span><span class="who"><b>Someone in beta</b><small>solved · testing</small></span><span class="state quiet">Asks first</span></div>`,
        },
        {
          title: 'People decide',
          line: 'A note left open to the circle you read at once. Otherwise the person who solved it reads your question and decides. Names appear only when both accept.',
          window: 'Intro',
          example: html`<div class="person"><span class="av">?</span><span class="who"><b>Someone would like to compare notes</b><small>webhooks · ci</small></span></div>
            <div class="row2"><span class="btn primary">Allow once</span><span class="btn quiet">Decline</span></div>`,
        },
        {
          title: 'Or ask one person',
          line: '“Ask Ayşe about this.” Your agent drafts the question, you approve it, and only Ayşe reads it, with your name. Their agent can help write the answer; they approve it, and only you read it.',
          window: 'Asked directly',
          example: html`<div class="person"><span class="av">S</span><span class="who"><b>Sam asks you</b><small>“How did you get the webhook test to pass on CI?” · webhooks, ci</small></span></div>
            <div class="row2"><span class="btn primary">Send to my agent</span><span class="btn quiet">Decline</span></div>`,
        },
      ],
    },
    privacy: {
      kicker: 'Privacy',
      heading: ['Built so agents', 'can’t overshare.'],
      tiles: [
        { title: 'People approve, in the browser', line: 'Every share, intro, question and answer waits for a click on a page your agent can’t reach.' },
        { title: 'Agents never read each other', line: 'They get ids, tags and states. Words reach your agent only when a person hands them over.' },
        { title: 'Circles you choose', line: 'Private circles grow by invite. A public commons shows no list of names, and your open notes reach it only when you tick it.' },
      ],
    },
    tools: {
      kicker: 'Works with',
      heading: 'The agent you already use.',
      tiles: [
        {
          state: 'Tried live',
          title: 'ChatGPT',
          line: 'Add Klatsch as a connector by its address. You sign in here and approve the connection; every share still waits for you.',
        },
        {
          state: 'Ready, not yet run live',
          part: true,
          title: 'Claude',
          line: 'On claude.ai, the desktop app and the phone: add Klatsch as a custom connector and ask a friend from any chat.',
        },
        { state: 'Tested end to end', title: 'Claude Code', line: 'Approval pages open from the chat. Idle sessions wake up when news arrives.' },
        { state: 'Ready, not yet run live', part: true, title: 'Codex', line: 'One command writes the project config. Approvals fall back to a short code.' },
        {
          state: 'Ready, not yet run live',
          part: true,
          title: 'GitHub Copilot',
          line: 'VS Code and the Copilot CLI, through a small local proxy. Your token stays in a file only you can read.',
        },
        {
          state: 'Ready, not yet run live',
          part: true,
          title: 'Any MCP client',
          line: 'Clients that speak OAuth connect by the address alone; the rest through the local proxy.',
        },
      ],
    },
    selfHost: {
      heading: ['Use a relay you trust,', 'or run your own.'],
      sub: 'One small server, Docker Compose, automatic HTTPS and continuous backups. Apache-2.0.',
      guide: 'Read the self-hosting guide',
    },
    footer: { line: 'Klatsch · Apache-2.0 · by Gizem Soylu', github: 'GitHub', security: 'Security', docs: 'Docs' },
    links: {
      github: 'https://github.com/gizemsoylutr/klatsch',
      security: 'https://github.com/gizemsoylutr/klatsch/blob/main/SECURITY.md',
      docs: 'https://github.com/gizemsoylutr/klatsch/tree/main/docs',
      selfHosting: 'https://github.com/gizemsoylutr/klatsch/blob/main/docs/self-hosting.md',
    },
  },

  signIn: {
    expiredTitle: 'Link expired',
    expired: 'This login link was already used or has expired (links last 10 minutes and work once).',
    notSignedInTitle: 'Not signed in',
    notSignedIn: html`Open the full login link (it ends in <code>/ui/login?t=…</code>), not this page.`,
    // No command here: this page is also what an agent sees, and it should not get a recipe for a session.
    help: 'Ask for a new login link in the terminal where Klatsch runs.',
    signedOutTitle: 'Signed out',
    signedOut: 'Signed out.',
    // The page a visitor without a session gets: what Klatsch is on the left, how to get in on the right.
    headline: ['Ask your friends.', 'From any chat.'],
    tagline: 'Your AI drafts it, you approve it, only your friend reads it. Nothing goes without your click.',
    title: 'Sign in',
    github: 'Sign in with GitHub',
    githubNote: 'Klatsch keeps your GitHub user id and login, your name and your verified primary email address; it gets no access to your repositories.',
    google: 'Sign in with Google',
    googleNote: 'Klatsch keeps your Google account id, your name and your verified email address; it gets no access to your mail or files.',
    googleFailed: 'Google sign-in did not finish. Start it again. It needs an address Google has verified.',
    googleInUseTitle: 'Google account in use',
    googleInUse: 'This Google account already signs in as someone else here.',
    googleAddressTitle: 'This address is already here',
    googleAddress: 'Someone here already uses this address. Sign in the way you did before, then connect Google in Settings. If that is not you, ask the person who invited you.',
    or: 'or',
    loginLink: 'Got a login link? Open it in this browser.',
    inviteNeeded: 'Joining a circle takes an invite.',
    failedTitle: 'Sign-in did not work',
    failed: 'GitHub sign-in did not finish. Start it again.',
    busyTitle: 'Try again later',
    busy: 'Too many sign-in attempts from your network. Try again in a few minutes.',
    inUseTitle: 'GitHub account in use',
    inUse: 'This GitHub account already signs in as someone else here.',
    pickLead: (handle: string) => `The handle @${handle} is taken here, or is not one Klatsch accepts. Pick another.`,
    pickRefused: 'That handle is taken or not valid. Pick another.',
    pickNote: '1–39 lowercase letters, digits or hyphens, starting with a letter or digit. People in your circles see it next to your name.',
    handleLabel: 'Handle',
    email: 'Email me a sign-in link',
    emailLabel: 'Your email address',
    emailPlaceholder: 'you@example.com',
    emailNote: 'Works for an address confirmed on your Klatsch account. New here? Open the invite link someone sent you first, then ask from there.',
    pickEmail: (address: string) => html`You join as <strong>${address}</strong>. Pick your handle.`,
  },

  /** Signing in by a link mailed to a confirmed address, or to a new one at an invite or join link. */
  emailSignIn: {
    sentTitle: 'Check your email',
    // The same words whatever happened, so the page tells nobody whether an address is known here.
    sent: 'If that address is confirmed on a Klatsch account, we sent a sign-in code and link. Enter the code here, or open the link. Both work once, for 10 minutes.',
    codeLabel: 'Sign-in code',
    codePlaceholder: '123456',
    codeButton: 'Sign in',
    codeFailedTitle: 'That code did not work',
    codeFailed: 'Check the code in the mail and type it again here, in the browser where you asked. After five wrong codes, ask for a new one on the sign-in page.',
    openGmail: 'Open Gmail',
    openOutlook: 'Open Outlook',
    mailApps: 'Open your mail',
    // Shown only when this browser came from no invite or join link: says nothing about the address typed.
    sentNew: 'New here? Nothing is sent to a new address until you open an invite or join link from someone in a circle and ask from that page.',
    confirmTitle: 'Sign in to Klatsch',
    confirmLine: 'You opened a sign-in link. Signing in here uses it up.',
    confirm: (address: string) => `Sign in as ${address}`,
    invalidTitle: 'Link not valid',
    invalid: 'This sign-in link is not valid. Links work once, for 10 minutes. Ask for a new one on the sign-in page.',
    otherBrowser: 'You asked for this link from another browser. Continue only if you did.',
    handleTriesTitle: 'Too many tries',
    handleTries: 'Ten handles were taken or not valid. Ask for a new sign-in link to try again.',
  },

  /** Signed in, in no circle yet: someone has to invite them. */
  noCircle: {
    title: 'You need an invite',
    line: 'Klatsch grows by links. Ask a friend on Klatsch for their friend link, or someone in a circle for an invite, and open it in this browser.',
    chatApp: 'Connecting ChatGPT or Claude? Open the link first, then start the connection again in the chat app.',
    signedInGitHub: (login: string) => `You signed in with GitHub as @${login}, and are in no circle here yet.`,
    signedInGoogle: (email: string) => `You signed in with Google as ${email}, and are in no circle here yet.`,
    friend: 'Or add a friend: you get a link to send them, and once they open it you can write to each other from any AI chat.',
    selfHost: 'Or run your own:',
    selfHostLink: 'self-hosting guide',
  },

  dashboard: {
    greeting: (name: string) => `Hi, ${name}.`,
    waiting: (count: number) => (count === 0 ? 'Nothing needs you.' : count === 1 ? '1 thing needs you.' : `${count} things need you.`),
    signOut: 'Sign out',
    codeLink: 'Got a code from your agent? Enter it →',
    /** The summary chips under the greeting: a count, then what it counts. */
    summary: 'Summary',
    chips: {
      unread: (n: number) => (n === 1 ? 'new message' : 'new messages'),
      intros: (count: number) => (count === 1 ? 'intro request' : 'intro requests'),
      drafts: (count: number) => (count === 1 ? 'draft' : 'drafts'),
      notes: (count: number) => (count === 1 ? 'note for you' : 'notes for you'),
      card: () => 'on your card',
      connected: () => 'connected',
      friends: (count: number) => (count === 1 ? 'friend' : 'friends'),
      asked: () => 'waiting for your answer',
    },
    friendsNone: 'Nothing yet. Ask a friend from ChatGPT or Claude, and the questions and answers show up here.',
    /** Intro requests and drafts in one list, each kind explained once under it. */
    needsHeading: 'Needs you',
    needsNone: 'Nothing waits for you. Intro requests and drafts from your agent show up here.',
    draftTitle: 'Draft from your agent',
    draftsNote: 'Drafts: your agent wrote them, and nobody else sees them until you share them.',
    share: 'Share',
    notNow: 'Not now',
    notesSub: 'solved, open to you',
    cardHeading: 'Your card',
    acceptedHeading: 'Connected',
    acceptedSub: (hours: number) => `visible ${hours} h, then names only`,
    theirSip: 'Their sip',
    yourSip: 'Yours',
    sendsAlready: 'already goes to your agent',
    didNotWork: 'did not work for them',
    asOf: (date: string) => `as of ${date}`,
    stillHolds: (date: string) => `Last looked at ${date}. Does it still hold? If not, retire it.`,
    confirm: 'Still holds',
    retire: 'Retire',
  },

  /** The same words on the dashboard and on the approval page. */
  incomingIntro: {
    heading: 'Someone would like to compare notes.',
    lead: "They're stuck on:",
    note: 'Allowing shares your names.',
    accept: consent.allowOnce,
    decline: 'Decline',
  },

  connected: {
    heading: "You're connected.",
    headingWith: (name: string) => `You're connected with ${name}`,
    who: (name: string, handle: string) => html`<strong>${name}</strong> (@${handle})`,
    theirSip: 'Their sip',
    yourSip: 'Yours',
  },

  /** Sending the other person's note to your own agent, once: the human's click. */
  handoff,

  /** Standing consent: open notes, and "always" on both sides, with what each one means. */
  consent,

  /** "Thanks, this helped", the author's private count and the opt-in badge. */
  thanks,


  chat: {
    heading: 'Messages',
    title: (name: string) => `${name}`,
    empty: (name: string) => `No messages yet. Write to ${name} here, or ask your AI in any chat: “Write to my friend …”.`,
    you: 'You',
    unread: (n: number) => `${n} new`,
    write: 'Your message',
    placeholder: 'Write a message',
    send: 'Send',
    attachLabel: 'Add a photo, PDF or voice note (up to 3, 5 MB each)',
    toAgent: 'Draft a reply with my AI',
    toAgentNote: 'Your AI reads the last messages from them once, the next time it checks Klatsch, labelled as their words.',
    sentToAgentTitle: 'Sent to your AI',
    sentToAgent: (from: string) => `Your AI gets your conversation with ${from} the next time it checks Klatsch, once, labelled as their words. Ask it in your chat to draft a reply.`,
    note: (name: string) => `Only you and ${name} read this conversation. It is kept 90 days, files 14 days, and goes when either of you removes the other as a friend.`,
    none: 'Your conversations with friends show here. Add a friend, then write from here or from any AI chat.',
    open: 'Open',
    noText: 'File',
  },

  asks: {
    heading: 'Asked directly',
    toYou: (name: string) => `${name} asks you`,
    fromYou: (name: string) => `You asked ${name}`,
    waiting: 'Waiting for an answer',
    declined: 'They won’t answer this one.',
    answerLabel: 'Their answer',
    send: 'Send to my agent',
    draft: 'Draft with my AI',
    yourAnswer: 'Your answer',
    sendAnswer: 'Send answer',
    answerGoes: (handle: string) => `Only @${handle} reads it, and it goes straight to the AI they asked with.`,
    answerSent: 'Sent to your AI',
    youAnswered: 'You answered',
    noFile: 'Choose a file first.',
    attachLabel: 'Add a photo, PDF or voice note (up to 3, 5 MB each)',
    attach: 'Attach',
    files: 'Files',
    yourAnswerLabel: 'Your answer',
    youDeclined: 'You declined',
    answeredTitle: 'Answer sent',
    answered: 'Only they read it. It went to the AI they asked with.',
    decline: 'Decline',
    withdraw: 'Withdraw',
    note: 'Only the two of you read these. Answer here, or let your AI draft it; nothing goes until you send it.',
    sentTitle: 'Sent to your agent',
    sent: (from: string) => `Your agent gets this from ${from} the next time it checks Klatsch, once, labelled as their words.`,
  },

  approval: {
    sendMessage: {
      heading: (name: string) => `Send this to ${name}?`,
      lead: (name: string, handle: string) => html`Only <strong>${name}</strong> (@${handle}) reads it, with your name.`,
      yes: 'Send',
      no: 'Not now',
    },
    askPerson: {
      heading: (name: string) => `Ask ${name} directly?`,
      lead: (name: string, handle: string) => html`Only <strong>${name}</strong> (@${handle}) reads this, with your name. They decide whether to answer.`,
      yes: 'Ask',
      no: 'Not now',
    },
    answerAsk: {
      heading: (name: string) => `Answer ${name}?`,
      question: 'They asked',
      answer: 'Your answer',
      tried: 'Sent as what did not work, not as a fix.',
      lead: 'Only they read it, with your name.',
      yes: 'Send',
      no: 'Not now',
    },
    share: {
      heading: 'Share this sip?',
      solvedHeading: 'Share what you solved?',
      triedHeading: 'Share what did not work?',
      semantic: 'This relay also compares your words with what people in your private circles shared, using a model that runs on the relay itself. Nobody reads the comparison: it can only make a match.',
      line: (status: string) => html`Adds to your card as <strong>${status}</strong>`,
      askForIntro: 'Whoever solved this gets an intro request and reads this sip.',
      askForIntroIn: 'Whoever solved this in the circles you tick below gets an intro request and reads this sip.',
      yes: 'Share',
      no: 'Not now',
    },
    sendIntro: {
      heading: 'Ask for an intro?',
      lead: "They'll read your sip:",
      note: 'Names are shared only if they accept.',
      yes: 'Ask',
      no: 'Not now',
    },
    /** Unknown, used, expired and other people's requests and codes all get these words. */
    expiredTitle: 'This request has expired.',
    expired: 'Ask your agent for a new one.',
    closeNote: 'Your agent sees the outcome; you can close this page.',
    sharedTitle: 'Shared.',
    shared: "It's on your card now.",
    messageSentTitle: 'Sent.',
    messageSent: 'Only they read it. Your conversation is on Home.',
    askSentTitle: 'Asked.',
    askSent: 'Only they read it. You see their answer on Home.',
    answerSentTitle: 'Sent.',
    answerSent: 'Only they read it.',
    askedTitle: 'Asked.',
    asked: 'They decide; names are shared only if they accept.',
    declinedTitle: 'Not this time.',
    declined: 'Nothing was shared.',
  },

  device: {
    title: 'Enter a code',
    wrongCode: 'No open request with this code. Check it in your terminal; codes last 10 minutes.',
    prompt: 'Enter the code your agent showed in the terminal.',
    placeholder: 'XXXX-XXXX',
    continue: 'Continue',
    fine: 'Codes work once and last 10 minutes.',
    tooManyTitle: 'Too many tries',
    tooMany: 'Too many wrong codes. Wait ten minutes.',
  },

  notesPage: {
    title: 'Notes',
    heading: 'Notes from your circles',
    sub: 'What people in your private circles chose to show here. Reading it tells nobody you did.',
    none: 'Nothing here yet. A note shows here when its author ticks that as they share it.',
    newest: 'The newest 100.',
    onPage: 'on Notes',
  },

  connect: {
    title: 'Connect an agent',
    prompt: 'Type the code that klatsch connect shows in your terminal.',
    wrongCode: 'No open request with this code. Check it in your terminal; codes last 10 minutes.',
    sure: (client: string) => `Connect ${client} to your Klatsch account?`,
    what: 'It can draft sips, search your circles and ask for intros in your name. It can never approve anything: that stays here, with you.',
    warning: 'Only continue if you ran klatsch connect yourself, just now, and this code is the one in your terminal. If someone sent you this code or asked you to type it, decline: they would get an agent token for your account.',
    allow: 'Connect',
    decline: 'Decline',
    doneTitle: 'Connected',
    done: 'Go back to your terminal: the command finishes by itself. You can revoke this agent on the Agents page.',
    declinedTitle: 'Not connected',
    declined: 'Nothing was connected.',
    fine: 'Codes work once and last 10 minutes.',
  },

  settings: {
    title: 'Settings',
    account: 'Account',
    handle: (handle: string) => `@${handle}`,
    signedInAs: (name: string, handle: string) => html`Signed in as <strong>${name}</strong> (@${handle}).`,
    github: 'GitHub',
    githubLinked: (login: string) => `Connected to @${login}: you can sign in with GitHub.`,
    githubNotLinked: 'Connect your GitHub account to sign in with it.',
    githubLink: 'Connect GitHub',
    githubUnlink: 'Disconnect',
    google: 'Google',
    googleLinked: (email: string) => `Connected to ${email}: you can sign in with Google.`,
    googleNotLinked: 'Connect your Google account to sign in with it.',
    googleLink: 'Connect Google',
    googleConnectTitle: 'Connect Google',
    googleConnectLead: 'Google asks you to sign in there and sends you back. Klatsch then asks you once more before it connects anything.',
    continueToGoogle: 'Continue to Google',
    googleConnectQuestion: (email: string) => `Connect the Google account ${email} to your Klatsch account? It can then sign in as you.`,
    sessions: 'Signed in',
    sessionsLine: (others: number) =>
      `${others === 0 ? 'Only this browser.' : others === 1 ? 'This browser and 1 other.' : `This browser and ${others} others.`} A sign-in lasts 30 days from its last use, 90 at most.`,
    endOthers: 'Sign out everywhere else',
    connectTitle: 'Connect GitHub',
    connectLead: 'GitHub asks you to sign in there and sends you back. Klatsch then asks you once more before it connects anything.',
    continueToGitHub: 'Continue to GitHub',
    connectQuestion: (login: string) => `Connect the GitHub account @${login} to your Klatsch account? It can then sign in as you.`,
    connect: 'Connect',
    cancel: 'Cancel',
    deleteHeading: 'Delete account',
    deleteLine: 'Removes your account and everything you shared, at once. It cannot be undone.',
    deleteOpen: 'Delete account…',
    deleteTitle: 'Delete your account?',
    deleteGoes: [
      'Your account, sign-ins, passkeys and agent tokens. Connected agents stop working at once.',
      'Every sip you shared or drafted, your questions and answers, notes you sent or received, intros, thanks and grants. People who saw them no longer can.',
      'Your lines in the security log. Only a line saying an account was deleted stays, without a name.',
    ],
    deleteCircles: (names: string[]) => `Circles you own pass to their longest-standing member: ${names.join(', ')}. A circle with nobody else in it goes.`,
    deleteBackups: 'Backups keep it for up to seven days more, then it is gone there too.',
    deleteConfirmLabel: (handle: string) => `Type ${handle} to confirm`,
    deleteConfirm: 'Delete my account',
    deleteMismatch: 'That is not your handle, so nothing was deleted.',
    deletedTitle: 'Your account is deleted',
    deletedLine: 'Everything you shared is gone from this relay. Backups keep it for up to seven days more. To remove what connect added on your machine, run npx klatsch disconnect there.',
  },

  /** The OAuth consent page: an app such as ChatGPT asks to act as the person's agent. */
  oauth: {
    title: (name: string) => `Connect ${name}?`,
    lead: (name: string, host: string) => `${name}, at ${host}, asks to connect to your Klatsch account.`,
    points: [
      'It can see who your friends are, open a conversation for you, and draft messages, questions and answers.',
      'It does not read what your friends write. It learns only that a message arrived and from whom, unless you choose "Draft with my AI" in a conversation.',
      'It can never send or share anything by itself: every message, question, answer and intro waits for your click.',
      'It stays connected until you revoke it on the Tokens page.',
    ],
    warn: (host: string) => `Connect only if you started this in the app at ${host} just now.`,
    allow: 'Connect',
    deny: 'Cancel',
    badTitle: 'Cannot connect this app',
    unknownClient: 'Klatsch does not know this app. Start connecting again from the app.',
    badRedirect: 'This app asked to send you to an address it did not register. Nothing was connected.',
  },

  /** Signing in with a passkey, and Settings' list of them. */
  passkeys: {
    signIn: 'Sign in with a passkey',
    failed: 'That passkey did not work here. Try again, or sign in another way.',
    error: 'The passkey did not go through. Try again.',
    heading: 'Passkeys',
    lead: 'Sign in with Face ID, Touch ID or your phone. Klatsch stores only a public key.',
    add: 'Add a passkey',
    none: 'No passkeys yet.',
    synced: 'Synced passkey',
    device: 'Passkey on one device',
    used: (added: string, used: string | undefined) => `Added ${added} · ${used ? `last used ${used}` : 'not used yet'}`,
    remove: 'Remove',
    elsewhere: 'Passkeys can be added on the relay’s own address.',
    offerTitle: 'Sign in faster next time',
    offerLine: 'Save a passkey and sign in with Face ID, Touch ID or your phone. Klatsch stores only a public key.',
    offerSave: 'Save a passkey',
    offerLater: 'Not now',
  },

  email: {
    heading: 'Email notifications',
    addressHeading: 'Address',
    state: (on: boolean, hasAddress: boolean) =>
      `${on ? 'On' : 'Off'}${hasAddress ? '' : ' (no email address on file yet)'}. They say only that something is new, with a link here.`,
    addressLabel: 'Your email address',
    placeholder: 'you@example.com',
    save: 'Save address',
    removeNote: 'Leave it empty and save to remove your address.',
    confirmed: 'Your address is confirmed. It is also a sign-in: anyone who can read its mail can sign in as you.',
    unconfirmed: 'Your address is not confirmed yet: open the link we mailed to it (it works for 24 hours). Save the address again for a new link.',
    tooManyLinks: 'Address saved, but no new confirmation link was sent: at most three a day. Use the last link you got for this address, or try again tomorrow.',
    confirmTitle: 'Confirm your address',
    confirmQuestion: (address: string) => html`Send Klatsch notifications to <strong>${address}</strong>?`,
    confirm: 'Confirm',
    confirmedTitle: 'Address confirmed',
    confirmedLine: (address: string) => html`Confirmed. Notifications go to <strong>${address}</strong>.`,
    invalidTitle: 'Link not valid',
    invalid: 'This confirmation link is not valid. Links work once, for 24 hours, for the address you entered last, while you are signed in.',
  },

  circle: {
    title: 'Your circles',
    none: 'You are not in a circle yet.',
    people: (count: number) => (count === 1 ? '· 1 person' : `· ${count} people`),
    owner: 'owner',
    you: 'you',
    remove: 'Remove',
    invite: 'Invite someone',
    addFriend: 'Add a friend',
    friendsHeading: 'Friends',
    friendsNote: 'A friend is a circle of two: you write to each other from any AI chat or from here, and only the two of you read it.',
    message: 'Message',
    friendWaiting: 'Waiting for your friend to open the link.',
    friendInviteTitle: 'Add a friend',
    friendInviteNote: 'Send this link to your friend, by any messenger. It works once, for seven days, and is shown only now. When they open it and sign in, you are friends on Klatsch.',
    endFriendship: 'Remove friend',
    notMember: 'You are not in this circle.',
    inviteTitle: 'Invite someone',
    inviteNote: 'Send this link to the person you invite. It works once, for seven days, and is shown only now.',
    backToCircles: 'Back to your circles',
  },

  invite: {
    friendHeading: 'Add as a friend?',
    friendLine: (inviter: string, handle: string) => html`<strong>${inviter}</strong> (@${handle}) wants to add you as a friend on Klatsch.`,
    friendNote: 'Friends write to each other from any AI chat or from here. Only the two of you read the conversation, and nothing is sent until you send it.',
    friendJoin: 'Add friend',
    alreadyFriends: (handle: string) => `You and @${handle} are already friends. Nothing changed.`,
    heading: 'Join the klatsch?',
    line: (inviter: string, handle: string, circle: string) => html`<strong>${inviter}</strong> (@${handle}) invites you to <strong>${circle}</strong>.`,
    note: "Members of a circle see each other's names here. A note someone opens to the circle shows their name to those it matches; anything else stays anonymous until both allow an intro.",
    join: 'Join',
    title: 'Invite',
    alreadyMember: (circle: string) => html`You are already in <strong>${circle}</strong>.`,
    joined: (circle: string) => html`You joined <strong>${circle}</strong>.`,
    chatAppAgain: 'Using ChatGPT or Claude? Connect Klatsch there now: in the chat app, open Klatsch and choose Connect.',
    yourCircles: 'Your circles',
    invalidTitle: 'Invite not valid',
    invalid: 'This invite is not valid. Invites work once and last seven days.',
  },

  /** The sign-in page for a directory reviewer's account. */
  review: {
    title: 'Review account',
    lead: 'For reviewers of a chat app directory, with the handle and password they were given.',
    handle: 'Handle',
    password: 'Password',
    signIn: 'Sign in',
    failed: 'That handle and password do not match a review account.',
    note: 'Everyone else signs in with a link, GitHub, Google or a passkey.',
    link: 'Reviewing Klatsch for a directory? Sign in with the review account',
  },

  /** Notifications on a phone or browser (Web Push): a line, never what anyone wrote. */
  push: {
    heading: 'Notifications on this device',
    line: 'A notification when a friend writes to you, asks you something or answers you. It never shows what they wrote.',
    devices: (n: number) => (n === 0 ? 'Off on every device.' : n === 1 ? 'On for 1 device.' : `On for ${n} devices.`),
    turnOn: 'Turn on here',
    turnOff: 'Turn off everywhere',
    here: 'On for this device: it gets Klatsch notifications.',
    turnOffHere: 'Turn off here',
    other: 'This browser gets notifications for another Klatsch account. To change that, sign in here as that account.',
    failed: 'That did not work. Try again, or use email notifications.',
    denied: 'Notifications are blocked for Klatsch in this browser. Allow them in its settings, then try again.',
    unsupported: 'This browser cannot get notifications from a web page. On an iPhone, add Klatsch to the Home Screen first.',
    iphone: 'On an iPhone: tap Share, then Add to Home Screen, open Klatsch from there and turn notifications on.',
    test: 'Send a test notification',
    testLine: 'Not sure they arrive? Send one to every device that has them on.',
    testTitle: 'Test notification',
    testNone: 'No device gets notifications yet. Turn them on here first.',
    testSent: (sent: number, failed: number, gone: number) =>
      `Sent to ${sent === 1 ? '1 device' : `${sent} devices`}${failed ? `; ${failed} could not be reached` : ''}${gone ? `; ${gone} no longer exist and were removed` : ''}. It should show within a minute.`,
    testMissing: 'Nothing showed up? The browser took it, so the device is holding it back. Check:',
    checks: [
      'Mac: System Settings › Notifications › your browser (Chrome or Safari): Allow notifications, style Banners or Alerts.',
      'Mac and iPhone: Focus or Do Not Disturb is off, or lets your browser through.',
      'Chrome: it has to be running (it can stay in the Dock without windows). In Chrome settings, Privacy › Site settings › Notifications allows klatsch.dev.',
      'iPhone and iPad: notifications work only from the Home Screen app. Share › Add to Home Screen, open Klatsch there, turn them on again in Settings.',
      'Android: Settings › Apps › Chrome › Notifications is on.',
    ],
    offerTitle: 'Know when a friend asks you',
    offerLine: 'Chat apps cannot tell you when something arrives. Turn on notifications on this device: they say only that something is new, never what anyone wrote.',
    offerLater: 'Not now',
    hint: 'Chat apps cannot tell you when your friend asks or answers.',
    hintLink: 'Turn on notifications',
  },

  /** A circle with a public join link: who joins, what members see, what turning the link on means. */
  commons: {
    heading: (name: string) => `Join ${name}`,
    line: (people: number) => `A public circle: ${people === 1 ? '1 person' : `${people} people`} and their link cards. Start here, invite your own people later.`,
    note: 'Anyone with the link can join. Notes you share open in a public circle are readable by everyone in it, so sharing asks which circles each time. Names appear only through intros and open notes.',
    join: 'Join',
    joined: (circle: string) => html`You joined <strong>${circle}</strong>.`,
    signIn: 'Sign in to join. A GitHub account is enough.',
    invalidTitle: 'Join link not valid',
    invalid: 'This join link is not valid. Its owner may have turned it off.',
    full: 'This circle is full.',
    tag: 'public',
    linkHeading: 'Public join link',
    linkOn: (cap: number | null) => `Anyone with the link can join.${cap ? ` At most ${cap} people.` : ''}`,
    linkOffPublic: 'Off: nobody new can join by link. Everyone who joined stays. Only the relay\'s operator can turn it on again.',
    turnOff: 'Turn off',
    hint: 'Notes reach this circle only when their author ticks it. Your other circles stay private.',
    ownerInvites: 'In a public circle only its owner invites people.',
    others: (count: number) => (count === 1 ? '1 other' : `${count} others`),
    othersNote: 'Names appear through intros and open notes.',
  },

  /** A link card: a solved note's public source, never fetched by Klatsch. */
  source: {
    kicker: 'Source',
    by: (author: string) => `by ${author}`,
    fine: 'Klatsch stores the link and title only. It never fetches or copies the page.',
    hint: 'A link card is someone you know vouching for a public post. Check the address before you open it. Send once gives your agent the link and their words.',
  },

  tokens: {
    title: 'Agent tokens',
    heading: 'Agents',
    connectedCount: (count: number) => `· ${count} connected`,
    note: 'Each token lets one agent use Klatsch as you. It can ask, never approve.',
    connect: 'Connect an agent',
    revoke: 'Revoke',
    notLive: 'No such live token.',
    live: 'live',
    revoked: 'revoked',
    expired: 'expired',
    fallbackLabel: 'token',
    dates: (created: string, expires: string) => `created ${created} · expires ${expires}`,
    /** Per-client setup: plain links, one per client, and the command for the one picked. */
    setupHeading: 'Connect',
    listHeading: 'Your tokens',
    none: 'No tokens yet.',
    pickerLabel: 'Agent client',
    pick: { claude: 'Claude Code', codex: 'Codex', copilot: 'Copilot' },
    /** What a token serves, as `klatsch connect` recorded it: the client, never more than the folder's name. */
    clientNames: { claude: 'Claude Code', codex: 'Codex', 'copilot-vscode': 'Copilot in VS Code', 'copilot-cli': 'Copilot CLI' } as Record<string, string>,
    copilotVscode: 'VS Code:',
    copilotCli: 'Copilot CLI:',
    setupHosted: 'In the project folder, run this, then click Connect an agent and paste the token when it asks:',
    setupBrowser: (command: string) => `Or without a token: run ${command} in the project folder and type the code it shows.`,
    setupLocal: 'In the project folder, run this. It makes its own token, so there is nothing to paste:',
    createdTitle: 'Connect an agent',
    createdNote: (days: number) => `Run this in the directory where you use Claude Code. The token is shown only now and works for ${days} days.`,
    hostedNote: (days: number, client: string) =>
      `Run this in the directory where you use ${client} (it needs the Klatsch CLI) and paste the token below when it asks. The token is shown only now and works for ${days} days.`,
    tokenLine: 'The token:',
    withoutCli: "Without the Klatsch CLI, this command connects too, but leaves the token in Claude Code's settings and adds no reminder hook:",
    backToTokens: 'Back to your agent tokens',
    noCircle: 'You are in no circle, so an agent would have nothing to do.',
  },

  notifications,
} as const;
