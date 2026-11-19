import { html } from 'hono/html';

/**
 * The privacy notice and terms a hosted relay shows, in plain words. Only statements the code and the deployment
 * make true: docs/security-model.md is the long form. Whoever runs a relay is named by `KLATSCH_OPERATOR_*`, and
 * without those the pages do not exist, so a self-hoster never publishes another operator's promises by accident.
 */
export interface Operator {
  name: string;
  email: string;
  /** Who handles data for this relay, one sentence per service, as the operator wrote it. */
  processors: string;
}

export const legal = {
  footerPrivacy: 'Privacy',
  footerTerms: 'Terms',
  footerSupport: 'Support',
  updated: 'Last updated: 19 November 2026',

  privacyTitle: 'Privacy',
  privacy: (o: Operator) => html`
    <p>This relay is run by ${o.name}, who decides what happens to the data on it. Questions and requests: <a href="mailto:${o.email}">${o.email}</a>.</p>

    <h2>What is kept</h2>
    <ul>
      <li><strong>Your account:</strong> your handle, your name, your email address if you give one, your GitHub user id and login or your Google account id and address if you sign in that way, and the public key of any passkey.</li>
      <li><strong>Messages:</strong> what you and your friends write to each other, with any photos, PDFs or voice notes, and when each was read.</li>
      <li><strong>What you share:</strong> the sips you approve, with their tags and link cards, questions you ask one person and their answers, with any photos, PDFs or voice notes you send with them, drafts and requests waiting for you, and notes on their way to your agent. Your agent sends a draft here before you decide on it.</li>
      <li><strong>Who is connected:</strong> your circles and invites, matches, intros and your choices about them, and thanks.</li>
      <li><strong>Security records:</strong> a log of actions (who, what, when, never the text you wrote), and sign-in sessions and agent tokens, kept only as keyed hashes. Network addresses are used only to limit abuse, and are kept for a day at most.</li>
    </ul>

    <h2>What is not done</h2>
    <p>No advertising, no analytics, no tracking, and nothing is sold. The only cookies are the ones sign-in and form safety need.</p>

    <h2>Who can read it</h2>
    <p>People see what you share as the approval page tells you before you decide. Agents never get another person’s words unless a person hands them over. <strong>Whoever runs a relay can read everything on it.</strong> If that is not acceptable for your work, run your own relay.</p>

    <h2>Who handles it</h2>
    <p>${o.processors}</p>
    <p>What you wrote is encrypted in the database, and its key is not in the backup, so the backup provider cannot read it. Account data and who is connected to whom are not encrypted there.</p>

    <h2>Why</h2>
    <p>To provide the service you signed up for, and, for the security records, the legitimate interest in keeping it safe.</p>

    <h2>How long</h2>
    <ul>
      <li>Your account and what you shared stay until you delete your account in Settings, or ask for it. Retiring a note stops anyone reading it; the record stays until then. Files sent with a question, an answer or a message are deleted after 14 days. Messages between friends are deleted after 90 days, or at once when either friend removes the other.</li>
      <li>A looking sip stops matching after 14 days. A note sent to an agent that never read it is cleared after seven days.</li>
      <li>A sign-in lasts 30 days from its last use, 90 at most.</li>
      <li>Security records are kept while the account exists.</li>
      <li>Backups keep deleted data for up to seven days more.</li>
    </ul>

    <h2>Your rights</h2>
    <p>You can ask to see, correct, export or delete your data, or object to how it is used. Settings has Delete account, which removes your account and everything you shared at once. For anything else, write to the address above; it is done within a month. You can also complain to your data protection authority.</p>
    <p>Klatsch is not meant for anyone under 16.</p>`,

  supportTitle: 'Support',
  support: (o: Operator, issues: string) => html`
    <p>Write to ${o.name} at <a href="mailto:${o.email}">${o.email}</a> for help with your account, your data, or someone misusing Klatsch. Say your handle, and never send a password or a sign-in code.</p>
    <p>Found a bug, or want something changed? Open an issue on <a href="${issues}">GitHub</a>. Security problems go privately, as SECURITY.md describes, never in a public issue.</p>

    <h2>Notifications do not show up</h2>
    <p>Open Klatsch, then Settings › Notifications on this device › <strong>Send a test notification</strong>. If it says it was sent but nothing shows, the device is holding it back:</p>
    <ul>
      <li>Mac: System Settings › Notifications › your browser: allow notifications, as Banners or Alerts. Focus and Do Not Disturb must be off, or let the browser through.</li>
      <li>Chrome has to be running. In its settings, Privacy › Site settings › Notifications must allow klatsch.dev.</li>
      <li>iPhone and iPad: notifications work only from the Home Screen. In Safari, Share › Add to Home Screen, open Klatsch from there, and turn notifications on again in Settings.</li>
      <li>Android: Settings › Apps › Chrome › Notifications is on.</li>
    </ul>
    <p>Email notifications are in Settings too, if you would rather have those.</p>

    <h2>I cannot message someone</h2>
    <p>You can write only to friends. Make a friend link (in your chat, say “add a friend”, or open Circle on klatsch.dev) and send it to them. Once they open it and accept, you are friends.</p>

    <h2>Using Klatsch in ChatGPT or Claude</h2>
    <p>Say “write to &lt;friend&gt;: …” and check the card that appears: nothing goes until you click Send there. Say “what did &lt;friend&gt; write?” to open the conversation in the chat. Your AI reads your friend’s words only when you click “Draft with my AI”.</p>
    <p>To disconnect a chat app or an agent, open Tokens on klatsch.dev and revoke it.</p>

    <h2>Removing things</h2>
    <ul>
      <li>Removing a friend deletes your conversation with them, for both of you, at once.</li>
      <li>Settings › Delete account removes your account and everything you shared, at once.</li>
    </ul>`,

  termsTitle: 'Terms',
  terms: (o: Operator) => html`
    <p>This relay is run by ${o.name}, as a free service. Using it means agreeing to this. Contact: <a href="mailto:${o.email}">${o.email}</a>.</p>

    <h2>The service</h2>
    <p>It is free, and provided as it is: no guarantee that it is available, correct or kept running. It can change or stop at any time. Keep your own copy of anything that matters. The software is open source under the Apache-2.0 license, and you can run your own.</p>

    <h2>What you share</h2>
    <p>What you write stays yours. You let this relay store it and show it to the people you chose on the approval page. <strong>Read what you approve.</strong> Share only what you may share: no customer or employer information you are not allowed to pass on, no secrets, no personal data about others. Detectors can miss these, and that remains your responsibility.</p>

    <h2>What others share</h2>
    <p>Notes and links come from other people and are not checked. Treat them as advice from someone you may not know, and test before you rely on them. A link can lead anywhere.</p>

    <h2>Fair use</h2>
    <p>No spam, harassment, illegal content or attempts to break the service or reach other people’s data. Security research is welcome through private reporting, as SECURITY.md describes. Access can be removed from anyone who breaks this.</p>

    <h2>Liability</h2>
    <p>The service is free, so to the extent the law allows, its operator is not liable for loss or damage from using it. Nothing here limits rights you have by law that cannot be limited.</p>`,
} as const;
