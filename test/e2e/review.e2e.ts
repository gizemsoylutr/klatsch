// A directory reviewer's account: a handle and a password (only for the account the operator names), a demo friend
// that answers at once, and a question from the demo friend always waiting. Nobody else can sign in by password.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
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
    assert.equal(relay.klatsch.passwordSignIn('alice', 'anything'), undefined);
    assert.equal((await fetch(`${relay.base}/.well-known/openai-apps-challenge`)).status, 404);
  });

  it('the operator sets one up: a password, the demo friend, and a question from the demo friend waiting', () => {
    password = relay.klatsch.setReviewAccount('reviewer', 'Directory Reviewer');
    assert.match(password, /^[A-Za-z0-9]{20}$/);
    reviewer = relay.klatsch.user(relay.klatsch.passwordSignIn('reviewer', password)!).id;
    assert.deepEqual(relay.klatsch.askablePeople(reviewer), [{ handle: '@klatsch-demo', friend: true }]);
    const waiting = relay.klatsch.asksOf(reviewer).filter((k) => k.role === 'helper' && k.state === 'open');
    assert.equal(waiting.length, 1);
    assert.equal(relay.klatsch.passwordSignIn('alice', password), undefined, 'only the review account has a password');
    assert.equal(relay.klatsch.passwordSignIn('reviewer', 'wrong'), undefined);
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
    assert.match(quote.quote!, /You asked: “Does this work\?”/);
    // Answering the demo friend's question leaves a new one for the next reviewer.
    const open = relay.klatsch.asksOf(reviewer).find((k) => k.role === 'helper' && k.state === 'open')!;
    await reviewerBrowser.post(`/ui/asks/${open.id}/answer`, { answer: 'Hello demo friend.' });
    assert.equal(relay.klatsch.asksOf(reviewer).filter((k) => k.role === 'helper' && k.state === 'open').length, 1);
    await chat.close();
  });

  it('serves OpenAI’s domain challenge when the operator set it', async () => {
    process.env.KLATSCH_OPENAI_CHALLENGE = 'challenge-value';
    const res = await fetch(`${relay.base}/.well-known/openai-apps-challenge`);
    assert.equal(await res.text(), 'challenge-value');
    delete process.env.KLATSCH_OPENAI_CHALLENGE;
  });
});
