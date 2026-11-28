// Ask around: a circle's questions of any kind ("brunch where?" as much as a stuck transport). Members ask; others
// answer (the asker hears an answer came, never the words); the asker marks the one that solved it; others say it
// helped them too. Open and answered filters and a search. Askers and hosts delete. Nobody outside the circle sees it.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { browser, startRelay, type Browser, type Relay } from './harness.ts';

describe('ask around: questions and answers in a circle', () => {
  let relay: Relay;
  let gizem = '', bob = '', carol = '', frank = '';
  let gizemB: Browser, bobB: Browser, carolB: Browser, frankB: Browser;
  let circle = '', question = '', answer = '';

  before(async () => {
    relay = await startRelay();
    gizem = relay.klatsch.ensureUser('gizem', 'Gizem');
    bob = relay.klatsch.ensureUser('bob', 'Bob');
    carol = relay.klatsch.ensureUser('carol', 'Carol');
    frank = relay.klatsch.ensureUser('frank', 'Frank');
    relay.klatsch.ensureCircle('frank-own', frank);
    circle = relay.klatsch.createCircle(gizem, 'Weekend crew');
    relay.klatsch.addMember(circle, bob, gizem);
    relay.klatsch.addMember(circle, carol, gizem);
    gizemB = await browser(relay, relay.loginLink(gizem));
    bobB = await browser(relay, relay.loginLink(bob));
    carolB = await browser(relay, relay.loginLink(carol));
    frankB = await browser(relay, relay.loginLink(frank));
  });
  after(async () => relay.close());

  it('a member asks anything; it opens on its own page and lists under Ask around', async () => {
    const page = (await bobB.get(`/ui/c/${circle}/ask`)).html;
    assert.match(page, /<form class="askform" method="post" action="\/ui\/c\/[^"]+\/ask">/);
    assert.match(page, /Nothing asked yet\. Ask the first question\./);
    const asked = await bobB.post(`/ui/c/${circle}/ask`, { title: 'Brunch on Sunday, where?', body: 'Four of us, near the park.' });
    assert.equal(asked.status, 303);
    question = relay.klatsch.questionsOf(bob, circle)[0]!.id;
    const q = (await carolB.get(`/ui/q/${question}`)).html;
    assert.match(q, /<h2>Brunch on Sunday, where\?<\/h2>[\s\S]*Four of us, near the park\./);
    assert.match((await carolB.get(`/ui/c/${circle}/ask`)).html, /Brunch on Sunday, where\?[\s\S]*Bob · 0 answers/);
  });

  it('answers come; the asker hears of it (not the words), marks what solved it; others say it helped', async () => {
    const before = relay.notifications.length;
    assert.equal((await carolB.post(`/ui/q/${question}/answer`, { body: 'Café Lotte, book ahead.' })).status, 303);
    assert.deepEqual(relay.notifications.slice(before), ['@bob: ☕ Someone answered your question.']);
    await gizemB.post(`/ui/q/${question}/answer`, { body: 'The bakery on the corner.' });
    answer = relay.klatsch.question(bob, question).answerList.find((a) => a.text.startsWith('Café Lotte'))!.id;
    assert.ok((await carolB.post(`/ui/a/${answer}/solve`)).status >= 400, 'only the asker marks it');
    assert.equal((await bobB.post(`/ui/a/${answer}/solve`)).status, 303);
    assert.ok((await carolB.post(`/ui/a/${answer}/helped`)).status >= 400, 'not on one’s own answer');
    assert.equal((await gizemB.post(`/ui/a/${answer}/helped`)).status, 303);
    const view = relay.klatsch.question(gizem, question);
    assert.equal(view.solved, true);
    assert.equal(view.answerList[0]!.id, answer, 'what solved it comes first');
    assert.equal(view.answerList[0]!.helped, 1);
    assert.match((await gizemB.get(`/ui/q/${question}`)).html, /Solved it[\s\S]*Café Lotte, book ahead\.[\s\S]*helped 1 more/);
  });

  it('filters and search; the words are searched after unsealing, never in the database', async () => {
    relay.klatsch.askAround(carol, circle, 'Who has a ladder?');
    assert.match((await gizemB.get(`/ui/c/${circle}/ask?state=open`)).html, /Who has a ladder\?/);
    assert.doesNotMatch((await gizemB.get(`/ui/c/${circle}/ask?state=open`)).html, /Brunch on Sunday/);
    assert.match((await gizemB.get(`/ui/c/${circle}/ask?state=answered`)).html, /Brunch on Sunday/);
    const found = (await gizemB.get(`/ui/c/${circle}/ask?q=ladder`)).html;
    assert.match(found, /Who has a ladder\?/);
    assert.doesNotMatch(found, /Brunch on Sunday/);
    const stored = relay.db.prepare(`SELECT count(*) AS n FROM questions WHERE title LIKE '%ladder%'`).get() as { n: number };
    assert.equal(stored.n, 0, 'sealed at rest');
  });

  it('askers and hosts delete; nobody outside the circle sees in', async () => {
    assert.equal((await frankB.get(`/ui/q/${question}`)).status, 404);
    assert.equal((await frankB.get(`/ui/c/${circle}/ask`)).status, 404);
    assert.ok((await frankB.post(`/ui/q/${question}/answer`, { body: 'Hi' })).status >= 400);
    const other = relay.klatsch.question(bob, question).answerList.find((a) => a.text.startsWith('The bakery'))!.id;
    assert.ok((await carolB.post(`/ui/a/${other}/delete`)).status >= 400, 'not hers');
    assert.equal((await gizemB.post(`/ui/a/${other}/delete`)).status, 303);
    assert.equal(relay.klatsch.question(bob, question).answers, 1);
    assert.ok((await carolB.post(`/ui/q/${question}/delete`)).status >= 400, 'not hers either');
    assert.equal((await bobB.post(`/ui/q/${question}/delete`)).status, 303);
    assert.equal((await carolB.get(`/ui/q/${question}`)).status, 404);
  });
});
