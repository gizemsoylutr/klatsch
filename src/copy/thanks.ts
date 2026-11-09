/**
 * "Thanks, this helped": a person tells the author of a note that reached them, or the other side of an
 * intro, that it helped. The author sees only a count of people, no names. The words a person reads
 * around it, and the badge's one line; no dependency, so the service's refusals and the pages say the same.
 */
const people = (count: number) => (count === 1 ? '1 person' : `${count} people`);

export const thanks = {
  /** Next to a note or a connected intro. */
  thank: 'Thanks',
  /** The same click on the page right after an intro was accepted. */
  thankLong: 'Thanks, this helped',
  thanked: 'Thanked',
  hint: 'Thanks tells the author it helped; they see a count, not names.',
  connectedNote: (name: string) => `${name} sees a thanks count with no names and no message. After an intro, they can often tell it was you.`,
  notReceived: 'You can thank someone only for a note that reached you, or an intro you are part of, while you share a circle.',
  self: 'You cannot thank yourself.',

  /** Home, under the summary chips, and Settings: the person's own counts. Only they see them. */
  helpedMonth: (count: number) => (count === 0 ? 'No new thanks this month.' : `Your notes helped ${people(count)} this month.`),
  helpedTotal: (count: number) => `${count} since you joined · only you see this`,
  showBadge: 'Show badge',
  heading: 'Thanks',
  total: (count: number) => `Your notes helped ${people(count)}`,
  month: (count: number) => `${count} this month · only you see this`,

  /** The opt-in badge, off by default. */
  badge: 'Show a badge',
  badgeOff: 'Off. When on, a public image for your README: “Helped N people on Klatsch”. Shows a number only.',
  badgeOn: 'On. Anyone with the link sees the number, never your name or who thanked you. Turning it off removes the image; turning it on again makes a new link.',
  badgeUrl: 'Image link:',
  badgeMarkdown: 'Markdown:',
  badgeAlt: 'Helped people on Klatsch',
  /** The badge's own line: a number only. */
  badgeText: (count: number) => `Helped ${people(count)} on Klatsch`,
  noCircle: 'You are in no circle, so there is nothing to show.',

  /** Thanks the person's agent gave for them: on Home with an Undo, and the switch in Settings. */
  agentThanked: (name: string) => `Your agent thanked ${name}`,
  undo: 'Undo',
  agentHint: 'Your agent thanks an author only when their note fixed the problem. Undo takes it back, and your agent will not thank for that note again.',
  agentSwitch: 'Let my agent say thanks when a note fixed the problem',
  agentOn: (perDay: number) =>
    `On. When a note your agent got from Klatsch fixed the problem, it can thank the author for you, at most ${perDay} a day. You see each one on Home and can undo it.`,
  agentOff: 'Off. Only you can say thanks, with the button next to a note.',
  notUndoable: 'There is no thanks from your agent to undo here.',
} as const;
