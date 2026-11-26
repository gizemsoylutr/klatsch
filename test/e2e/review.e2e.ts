// A directory reviewer's account: a handle and a password (only for the account the operator names), a demo friend
// that writes back like a friend would, a conversation to start from, and a question from the demo friend
// waiting until it is answered (review-reset brings it back). Nobody else can sign in by password.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createInvite, findInvite } from '../../src/auth/invites.ts';
import { agent, browser, signedOutBrowser, startRelay, type Relay } from './harness.ts';

describe('review account: a password for one account, and a demo friend for the whole round trip', () => {
  let relay: Relay;
  let password = '';
  let reviewer = '';

  before(async () => {
    relay = await startRelay();
    relay.klatsch.ensureCircle('home', relay.klatsch.ensureUser('alice', 'Alice'));
  });
  after(async () => relay.close());

  it('without a review account there is no password page, and nobody signs in by password', async () => {
    assert.equal((await fetch(`${relay.base}/ui/review-login`)).status, 404);
    assert.equal(await relay.klatsch.passwordSignIn('alice', 'anything'), undefined);
    assert.equal((await fetch(`${relay.base}/.well-known/openai-apps-challenge`)).status, 404);
  });

  it('the operator sets one up: a password, the demo friend, and a question from the demo friend waiting', async () => {
    assert.throws(() => relay.klatsch.setReviewAccount('alice', 'Alice'), /existing account without a password/, 'never a real person by a typo');
    password = relay.klatsch.setReviewAccount('reviewer', 'Directory Reviewer');
    assert.match(password, /^[A-Za-z0-9]{20}$/);
    reviewer = relay.klatsch.user((await relay.klatsch.passwordSignIn('reviewer', password))!).id;
    assert.deepEqual(relay.klatsch.askablePeople(reviewer), [{ handle: '@klatsch-demo', friend: true }]);
    const waiting = relay.klatsch.asksOf(reviewer).filter((k) => k.role === 'helper' && k.state === 'open');
    assert.equal(waiting.length, 1);
    assert.match(waiting[0]!.question, /hike on Sunday/);
    // A conversation to start from, its last line (the demo friend's) unread.
    const thread = relay.klatsch.conversation(reviewer, '@klatsch-demo').messages;
    assert.equal(thread.length, 3);
    assert.match(thread.at(-1)!.text, /^Hey! Free on Saturday\?.*museum/);
    assert.equal(relay.klatsch.conversation(reviewer, '@klatsch-demo').unread, 1);
    assert.equal(await relay.klatsch.passwordSignIn('alice', password), undefined, 'only the review account has a password');
    assert.equal(await relay.klatsch.passwordSignIn('reviewer', 'wrong'), undefined);
    // Outsiders hold its password: it reaches no real people by itself. It can make a friend link, to see how
    // that works, but nobody can join by it.
    const aliceId = relay.klatsch.ensureUser('alice', 'Alice');
    const own = createInvite(relay.db, relay.secret, relay.klatsch.friendCircle(reviewer), reviewer, relay.base);
    assert.throws(() => relay.klatsch.acceptInvite(aliceId, findInvite(relay.db, relay.secret, new URL(own.link).pathname.split('/').at(-1)!)!), /demo account\. It adds nobody/);
    // Nor by someone else's link: a review account accepts no invites.
    const link = createInvite(relay.db, relay.secret, relay.klatsch.friendCircle(aliceId), aliceId, relay.base);
    assert.throws(() => relay.klatsch.acceptInvite(reviewer, findInvite(relay.db, relay.secret, new URL(link.link).pathname.split('/').at(-1)!)!), /demo friend only/);
    // Six reviewers in a row still each get a demo question (the demo friend's seeds have no daily limit).
    for (let i = 0; i < 6; i++) relay.klatsch.setReviewAccount(`reviewer${i}`, 'Reviewer');
  });

  it('nobody can take the demo friend’s handle, and a real person who has it is never made the demo', async () => {
    const other = await startRelay();
    other.klatsch.ensureUser('klatsch-demo', 'Someone Real');
    assert.throws(() => other.klatsch.setReviewAccount('reviewer', 'Reviewer'), /belongs to a real person/);
    await other.close();
  });

  it('the reviewer signs in with the form; a wrong password is refused; the sign-in page links to it', async () => {
    const visitor = signedOutBrowser(relay);
    assert.match((await visitor.go('/ui')).html, /href="\/ui\/review-login"/);
    const page = await visitor.go('/ui/review-login');
    assert.equal(page.status, 200);
    assert.equal((await visitor.post('/ui/review-login', { handle: 'reviewer', password: 'wrong' })).status, 401);
    const inside = await visitor.post('/ui/review-login', { handle: '@Reviewer', password });
    assert.match(inside.html, /Hi, Directory Reviewer/);
  });

  it('asking the demo friend answers at once, back to the agent that asked', async () => {
    const reviewerBrowser = await browser(relay, relay.loginLink(reviewer));
    const chat = await agent(relay, relay.chatAppToken(reviewer), { dialogs: false, cards: true });
    const asked = await chat.call('ask_person', { handle: '@klatsch-demo', question: 'Does this work?' });
    await chat.call('klatsch_card', { key: asked.meta['dev.klatsch/card'].key, decision: 'approved' });
    const quote = ((await chat.call('inbox')).data.events as { type?: string; quote?: string }[]).find((e) => e.type === 'quote')!;
    assert.match(quote.quote!, /go for it/, 'an answer as a friend gives one, not an echo');
    // Answered, the demo friend's question is done: no new one appears (review-reset brings it back).
    const open = relay.klatsch.asksOf(reviewer).find((k) => k.role === 'helper' && k.state === 'open')!;
    await reviewerBrowser.post(`/ui/asks/${open.id}/answer`, { answer: 'Hello demo friend.' });
    assert.equal(relay.klatsch.asksOf(reviewer).filter((k) => k.role === 'helper' && k.state === 'open').length, 0);
    await chat.close();
  });

  it('the demo friend writes back about what it was sent: a booking, a hike, a question', () => {
    const last = () => relay.klatsch.conversation(reviewer, '@klatsch-demo').messages.at(-1)!.text;
    relay.klatsch.sendMessage(reviewer, '@klatsch-demo', 'I booked Trattoria Lucia for Friday at 19:30, does that work?');
    assert.match(last(), /half an hour later/);
    relay.klatsch.sendMessage(reviewer, '@klatsch-demo', 'I booked two tickets for the dinosaur exhibition on Saturday at 14:00. Does that work?');
    assert.match(last(), /meet half an hour later/);
    relay.klatsch.sendMessage(reviewer, '@klatsch-demo', 'Yes for the hike! Can you drive?');
    assert.match(last(), /pick you up at 9:00/);
    relay.klatsch.sendMessage(reviewer, '@klatsch-demo', 'Which flat should I take, the one in Neukölln or the one in Mitte?');
    assert.match(last(), /U-Bahn/);
    assert.doesNotMatch(last(), /You wrote/);
  });

  it('with its delay, the reply arrives later as a new, unread message', async () => {
    relay.klatsch.demoDelayMs = 50;
    try {
      const before = relay.klatsch.conversation(reviewer, '@klatsch-demo').messages.length;
      relay.klatsch.sendMessage(reviewer, '@klatsch-demo', 'Dinner on Friday?');
      assert.equal(relay.klatsch.conversation(reviewer, '@klatsch-demo').messages.length, before + 1, 'not at once');
      await new Promise((r) => setTimeout(r, 150));
      assert.ok(relay.klatsch.conversation(reviewer, '@klatsch-demo').unread >= 1, 'it waits unread');
      assert.equal(relay.klatsch.conversation(reviewer, '@klatsch-demo').messages.length, before + 2);
    } finally {
      relay.klatsch.demoDelayMs = 0;
    }
  });

  it('review-reset puts the demo back as new and keeps the password', async () => {
    relay.klatsch.resetReviewDemo('@reviewer');
    assert.equal((relay.db.prepare("SELECT COUNT(*) n FROM events WHERE user_id = ? AND read_at IS NULL").get(reviewer) as { n: number }).n, 2, 'one message, one question');
    assert.equal(relay.klatsch.conversation(reviewer, '@klatsch-demo').messages.length, 3);
    assert.equal(relay.klatsch.asksOf(reviewer).filter((k) => k.state === 'open').length, 1);
    assert.equal(relay.klatsch.asksOf(reviewer).length, 1, 'closed questions are gone, so none opens in a chat again');
    assert.ok(await relay.klatsch.passwordSignIn('reviewer', password));
    assert.throws(() => relay.klatsch.resetReviewDemo('alice'), /not a review account/);
  });

  it('answering the demo friend’s question from the card turns it into the conversation, where the friend writes back', async () => {
    const chat = await agent(relay, relay.chatAppToken(reviewer), { dialogs: false, cards: true });
    const open = relay.klatsch.asksOf(reviewer).find((k) => k.role === 'helper' && k.state === 'open')!;
    const drafted = await chat.call('answer_ask', { ask_id: open.id, answer: 'Yes, still on! Pick me up at 9?' });
    const sent = await chat.call('klatsch_card', { key: drafted.meta['dev.klatsch/card'].key, decision: 'approved' });
    const card = sent.data.card as { chat: { with: { handle: string }; messages: { mine: boolean; text: string }[] } };
    assert.equal(card.chat.with.handle, 'klatsch-demo');
    assert.match(card.chat.messages.at(-1)!.text, /pick you up at 9:00/, 'the demo friend wrote back');
    await chat.close();
  });

  it('serves OpenAI’s domain challenge when the operator set it', async () => {
    process.env.KLATSCH_OPENAI_CHALLENGE = 'challenge-value';
    const res = await fetch(`${relay.base}/.well-known/openai-apps-challenge`);
    assert.equal(await res.text(), 'challenge-value');
    delete process.env.KLATSCH_OPENAI_CHALLENGE;
  });
});
