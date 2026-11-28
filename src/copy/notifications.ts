/**
 * What notifications and mails say: plain strings with no dependency, so the service and the mailer
 * need nothing from the web layer. Content-free on purpose: no names, tags or summaries ever go into
 * a notification. The one ☕ in the whole UI lives here.
 */
export const notifications = {
  match: '☕ Someone in your circle has solved this before.',
  other: '☕ Something new in your circle.',
  message: '☕ A friend sent you a message.',
  mention: '☕ Someone mentioned you in a circle.',
  room: '☕ Something new in one of your circles.',
  test: '☕ Test from Klatsch: notifications reach this device.',
  githubLinked: 'A GitHub account can now sign in to your Klatsch account. Not you? Disconnect it in Settings.',
  githubUnlinked: 'GitHub sign-in was disconnected from your Klatsch account.',
  googleLinked: 'A Google account can now sign in to your Klatsch account. Not you? Disconnect it in Settings.',
  googleUnlinked: 'Google sign-in was disconnected from your Klatsch account.',
  passkeyAdded: 'A passkey can now sign in to your Klatsch account. Not you? Remove it in Settings and sign out everywhere else.',
  passkeyRemoved: 'A passkey was removed from your Klatsch account.',
  agentConnected: 'A new agent was connected to your Klatsch account. It can ask, never approve. Not you? Revoke it on the Agents page.',
  desktopTitle: 'Klatsch',
  emailSubject: 'Klatsch: something new',
  confirmSubject: 'Klatsch: confirm your email address',
  confirmText: 'To get Klatsch notifications at this address, open this link while signed in to Klatsch; if you did not ask for this, ignore this mail.',
  // The code in six digits in a row, never split, so mail apps can offer to copy it; it is useless without the asking browser.
  signInSubject: (code: string) => `Your Klatsch sign-in code: ${code}`,
  signInCode: 'Your sign-in code:',
  signInLead: 'It works once, for 10 minutes, in the browser where you asked for it. Or open this link:',
  signInExpiry: "If you didn't ask for it, ignore this mail.",
  emailSignIn: 'Someone signed in to your Klatsch account by email. Not you? Change or remove your address in Settings.',
  signedInSubject: 'Klatsch: new sign-in',
  signedInText: "Someone signed in to Klatsch with this address. If it wasn't you, open Settings and change or remove your address, so it no longer signs in, and tell the relay's operator.",
} as const;
