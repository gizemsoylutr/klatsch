/**
 * "Send once": the human hands another person's note to their own agent (the other way is the standing
 * "always", see consent.ts). The words a person reads around it. No dependency, so the service's refusals
 * and the web pages say the same thing.
 */
export const QUOTES_PER_HOUR = 10;

export const handoff = {
  send: 'Send once',
  /** The same click on the page right after an intro was accepted, where it is the main thing to do. */
  sendToAgent: 'Send to my agent',
  note: 'Your agent gets it once, as a quote, marked as their words and not instructions.',
  sentTitle: 'Sent.',
  sent: (handle: string) => `Your agent will see it as a quote from @${handle}.`,
  notConnected: 'You are not connected through this intro.',
  noLongerShared: (handle: string) => `@${handle} no longer shares this note.`,
  visibleUntil: (time: string) => `Visible until ${time}, then only the names stay.`,
  tooMany: `You sent ${QUOTES_PER_HOUR} quotes in the last hour. Try again later.`,
} as const;
