/**
 * Standing consent, on both sides: who reads a solved note without being asked, and whose notes reach
 * your agent without a click. The words a person reads around it; no dependency, so the service's
 * refusals and the web pages say the same thing. Every "always" comes with a plain line saying what it means.
 */
export const consent = {
  /** The sharer's choice for a solved sip, on its approval page. */
  visibility: 'Who reads it',
  open: 'Open to my circle',
  openNote: 'People in your circle who are stuck on this read it at once, with your name. Nobody asks you, and you are not disturbed.',
  ask: 'Ask me first',
  askNote: 'They see that someone solved it and can ask you for an intro; you decide each time.',
  askNoteTried: 'They see that someone tried something on it and can ask you for an intro; you decide each time.',
  feedChoice: 'Also on the Notes page: everyone in your private circles can read it any time, with your name, even if they are not stuck on this. Public circles never.',
  /** Where a sip is shared and matched: the person's circles, private ones ticked, public ones not by default. */
  matchIn: 'Match in',
  /** Under a public circle: what ticking it means, for a looking sip, an open note and an ask-first one. */
  matchInPublic: (name: string, people: number, kind: 'looking' | 'open' | 'ask') => {
    const who = `${name} (${people === 1 ? '1 person' : `${people} people`})`;
    if (kind === 'open') return `Ticked: everyone in ${who} who is stuck on this reads it at once, with your name. Most of them you don't know.`;
    if (kind === 'ask') return `Ticked: someone in ${who} you don't know may ask you for an intro.`;
    return `Ticked: whoever solved it may be someone in ${who} you don't know, and reads this sip with an intro request.`;
  },
  pickCircle: 'Pick at least one circle to share it in.',
  /** A form that carried no circle choice although the person has one to make: an old tab. */
  stale: 'This page is out of date: you are in more circles than it shows. Reload it and choose again.',
  /** On your own card. */
  openTag: 'open to my circle',
  askTag: 'ask me first',

  /** The sharer's "always", where an intro is decided. */
  allowOnce: 'Allow once',
  allowAlways: 'Allow always',
  allowAlwaysNote: 'They also see the notes you share from now on with these tags in the circle where they asked, without asking you. Revoke any time in Settings.',
  allowAlwaysIn: (circle: string) => `They also see the notes you share from now on with these tags in ${circle}, without asking you. Revoke any time in Settings.`,

  /** The receiver's "always", next to another person's note. */
  sendAlways: (handle: string) => `Always send @${handle}'s notes to my agent`,
  /** The same choice named once in a section's explanation. */
  sendAlwaysShort: 'Always send',
  sendAlwaysNote: 'From now on, their notes that match what you are looking for reach your agent without asking you. Revoke any time in Settings.',
  sendsAlways: (handle: string) => `@${handle}'s notes that match what you are looking for reach your agent without asking you. Revoke any time in Settings.`,
  sentAlways: (handle: string) =>
    `Your agent will see it as a quote from @${handle}, and from now on @${handle}'s notes that match what you are looking for, without asking you.`,
  /** The hourly cap refused the send: one click, one outcome, so "always" was not turned on either. */
  tooManyAlways: 'You sent 10 quotes in the last hour. Nothing was sent, and "always" was not turned on. Try again later.',

  /** Notes open to you, on the dashboard. */
  notesHeading: 'Notes from your circle',
  notesHint: 'What people in your circle solved or found does not work, on what you are looking for (your shared looking sips), open to you without an intro.',
  who: (name: string, handle: string) => `${name} (@${handle})`,
  onTags: (tags: string[], circle: string | null) => `notes with ${tags.join(', ')}${circle ? ` in ${circle}` : ''}`,

  /** Settings. */
  heading: 'Allowed always',
  hint: 'Each one is for one person. Revoking it stops it at once.',
  showHeading: 'Who reads your notes without asking',
  deliverHeading: 'Whose notes go to your agent',
  none: 'Nobody.',
  since: (date: string) => `since ${date}`,
  revoke: 'Revoke',
  notGranted: 'No such permission.',
  notVisible: 'This note is not open to you.',
  noIntroNeeded: 'This note is already open to you on your Klatsch page, so no intro is needed.',
} as const;
