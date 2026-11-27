# Klatsch flows

Generated from the end-to-end scenarios in `test/e2e/` by `npm run flows`; do not edit by hand. Open a `.drawio` file in draw.io (desktop or app.diagrams.net). Lanes show who acts; red boxes are steps that prove something cannot happen.

| Flow | Steps | Diagram |
|---|---|---|
| account deletion: everything of the person goes, others keep working | 7 | [account-deletion.drawio](account-deletion.drawio) |
| agent limits: an agent can ask, never approve, and never reach the human side | 5 | [agent-limits.drawio](agent-limits.drawio) |
| agent thanks: Bob's agent thanks Alice for the note that fixed his problem; Bob sees it on Home and takes it back | 9 | [agent-thanks.drawio](agent-thanks.drawio) |
| ask me first: Bob allows one intro once and another always, per person | 7 | [allow-always.drawio](allow-always.drawio) |
| approval by code: no dialog, the human types the code in their browser | 9 | [approval-by-code.drawio](approval-by-code.drawio) |
| attachments: a photo with the question, a voice note with the answer, for the two of them only | 5 | [attachments.drawio](attachments.drawio) |
| browser connect: a code from the command, typed in the signed-in browser | 12 | [browser-connect.drawio](browser-connect.drawio) |
| cards in the chat: decide and answer without leaving the conversation | 10 | [chat-cards.drawio](chat-cards.drawio) |
| dashboard: drafts, intros and the card, decided in the browser | 7 | [dashboard.drawio](dashboard.drawio) |
| decline: the solvers say no, the seeker hears so, no names are exchanged | 6 | [decline.drawio](decline.drawio) |
| direct ask: one person, both humans approve, agents get text only by a click or "always" | 10 | [direct-ask.drawio](direct-ask.drawio) |
| draft directions: a word on what to say goes to your own AI with the question or conversation | 4 | [draft-directions.drawio](draft-directions.drawio) |
| sign in by email: a new person joins by invite with a mailed link, and signs in by email again later | 13 | [email-sign-in.drawio](email-sign-in.drawio) |
| email: confirm an address in the browser, then content-free notifications | 7 | [email.drawio](email.drawio) |
| friends: a link, a question about anything, an answer typed by hand that reaches the agent that asked | 8 | [friends.drawio](friends.drawio) |
| sign in with GitHub: a new person is made only when they join by invite, connecting GitHub needs a confirmation, and the callback refuses what it should | 21 | [github-sign-in.drawio](github-sign-in.drawio) |
| sign in with Google: made only by joining, found by id only, verified addresses only | 14 | [google-sign-in.drawio](google-sign-in.drawio) |
| guest mode is off unless the operator turns it on | 9 | [guest.drawio](guest.drawio) |
| hosted connect: token from the Tokens page, connect with the CLI, agent calls the relay | 5 | [hosted-connect.drawio](hosted-connect.drawio) |
| invites and removal: the owner invites Carol, then removes her | 13 | [invites-and-removal.drawio](invites-and-removal.drawio) |
| a 2025-06-18 client without dialogs or tasks (Codex by default) | 5 | [legacy-client.drawio](legacy-client.drawio) |
| privacy and terms pages | 6 | [legal-pages.drawio](legal-pages.drawio) |
| link cards and the commons: a stranger in a public circle reads a link card its author ticked for it, and hands it to her agent as data | 10 | [link-cards-and-commons.drawio](link-cards-and-commons.drawio) |
| messages: a conversation with a friend, from any chat or the Klatsch page | 7 | [messages.drawio](messages.drawio) |
| note check: an old note shows its age and asks its author | 6 | [note-check.drawio](note-check.drawio) |
| notes page: what authors tick reaches their private circles, and never an agent | 12 | [notes-page.drawio](notes-page.drawio) |
| OAuth: an app connects as the person’s agent after they approve it, and nothing more | 7 | [oauth.drawio](oauth.drawio) |
| open notes: Alice reads what Bob opened to the circle at once; Bob is not disturbed | 9 | [open-notes.drawio](open-notes.drawio) |
| passkeys: add on Settings, sign in from another browser, remove | 5 | [passkeys.drawio](passkeys.drawio) |
| push notifications: offered in Settings, one subscription per device, off in one click | 11 | [push.drawio](push.drawio) |
| quote hand-off: Alice sends Bob's sip to her own agent | 7 | [quote-handoff.drawio](quote-handoff.drawio) |
| request intro: find matches first, then ask for an intro to one | 6 | [request-intro.drawio](request-intro.drawio) |
| return after sign-in: an approval opened signed out is decided after the login link | 3 | [return-after-sign-in.drawio](return-after-sign-in.drawio) |
| review account: a password for one account, and a demo friend for the whole round trip | 10 | [review.drawio](review.drawio) |
| semantic matching: different tags, the same problem | 7 | [semantic-matching.drawio](semantic-matching.drawio) |
| sessions: Alice signs in on two browsers and signs out the other one from Settings | 2 | [sessions.drawio](sessions.drawio) |
| share and intro: Alice asks, Bob accepts, names are exchanged in the browsers only | 8 | [share-and-intro.drawio](share-and-intro.drawio) |
| the stdio proxy for clients without a header helper (Copilot) | 3 | [stdio-proxy.drawio](stdio-proxy.drawio) |
| thanks: Bob thanks Alice for the note that helped him; only Alice sees a count, and a badge only if she turns it on | 10 | [thanks.drawio](thanks.drawio) |
| tokens: create in the web UI, use from an agent, revoke in the web UI | 5 | [tokens.drawio](tokens.drawio) |
| tried notes: what did not work reaches others as a warning, never as a fix | 8 | [tried-notes.drawio](tried-notes.drawio) |
| watch: an idle session hears back when Bob accepts | 13 | [watch.drawio](watch.drawio) |
