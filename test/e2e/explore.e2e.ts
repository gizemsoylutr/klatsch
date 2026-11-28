// Explore: an owner lists a circle with a line about it; anyone else (not a guest, not someone removed) finds it, asks
// to join, and the circle's hosts let them in or not; the hosts hear of a request, the asker of the answer, never more.
// Picks: hosts add a circle's best questions to its Picks, a filter in Ask around.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { browser, startRelay, type Browser, type Relay } from './harness.ts';

describe('explore and picks', () => {
  let relay: Relay;
  let gizem = '', bob = '', dana = '', erin = '';
  let gizemB: Browser, bobB: Browser, danaB: Browser, erinB: Browser;
  let circle = '';

  before(async () => {
    relay = await startRelay({ guest: true });
    gizem = relay.klatsch.ensureUser('gizem', 'Gizem');
    bob = relay.klatsch.ensureUser('bob', 'Bob');
    dana = relay.klatsch.ensureUser('dana', 'Dana');
    erin = relay.klatsch.ensureUser('erin', 'Erin');
    for (const u of [dana, erin]) relay.klatsch.ensureCircle(`own-${u}`, u);
    circle = relay.klatsch.createCircle(gizem, 'SAP crowd');
    relay.klatsch.addMember(circle, bob, gizem);
    gizemB = await browser(relay, relay.loginLink(gizem));
    bobB = await browser(relay, relay.loginLink(bob));
    danaB = await browser(relay, relay.loginLink(dana));
    erinB = await browser(relay, relay.loginLink(erin));
  });
  after(async () => relay.close());

  it('only the owner lists a circle, and only with a line about it', async () => {
    assert.match((await danaB.get('/ui/explore')).html, /No circles listed yet\./);
    assert.ok((await bobB.post(`/ui/c/${circle}/listing`, { listed: '1', about: 'Fixes' })).status >= 400, 'Bob is not the owner');
    assert.ok((await gizemB.post(`/ui/c/${circle}/listing`, { listed: '1', about: '' })).status >= 400, 'a line is needed');
    assert.equal((await gizemB.post(`/ui/c/${circle}/listing`, { listed: '1', about: 'SAP fixes, shared over coffee' })).status, 303);
    const page = (await danaB.get('/ui/explore')).html;
    assert.match(page, /SAP crowd[\s\S]*SAP fixes, shared over coffee[\s\S]*2 people/);
    assert.match((await danaB.get('/ui/explore?q=coffee')).html, /SAP crowd/);
    assert.doesNotMatch((await danaB.get('/ui/explore?q=react')).html, /SAP crowd/);
    assert.ok(!(await bobB.get('/ui/explore')).html.includes(`/ui/explore/${circle}/join`), 'not offered to its members');
  });

  it('asking to join: the hosts hear of it and decide; the asker hears the answer', async () => {
    const before = relay.notifications.length;
    assert.equal((await danaB.post(`/ui/explore/${circle}/join`)).status, 303);
    assert.deepEqual(relay.notifications.slice(before), ['@gizem: ☕ Someone asked to join your circle.']);
    assert.match((await danaB.get('/ui/explore')).html, /Asked: the hosts decide/);
    assert.match((await gizemB.get(`/ui/c/${circle}/r/${relay.klatsch.space(gizem, circle).rooms[0]!.id}`)).html, /1 wants to join/);
    assert.match((await gizemB.get(`/ui/c/${circle}/settings`)).html, /Dana <span class="m">@dana<\/span>/);
    assert.ok((await bobB.post(`/ui/c/${circle}/requests/${dana}/accept`)).status >= 400, 'Bob is no host');
    assert.equal((await gizemB.post(`/ui/c/${circle}/requests/${dana}/accept`)).status, 303);
    assert.equal(relay.klatsch.memberRole(dana, circle), 'member');
    assert.equal(relay.notifications.at(-1), '@dana: ☕ You are in: a circle let you join.');
    await erinB.post(`/ui/explore/${circle}/join`);
    assert.equal((await gizemB.post(`/ui/c/${circle}/requests/${erin}/decline`)).status, 303);
    assert.equal(relay.klatsch.memberRole(erin, circle), undefined);
  });

  it('nobody removed asks again; guests do not see Explore', async () => {
    relay.klatsch.removeMember(gizem, circle, dana);
    assert.ok(!(await danaB.get('/ui/explore')).html.includes(`/ui/explore/${circle}/join`));
    assert.ok((await danaB.post(`/ui/explore/${circle}/join`)).status >= 400);
    const guest = relay.klatsch.startGuest();
    const guestB = await browser(relay, relay.loginLink(guest));
    assert.equal((await guestB.get('/ui/explore')).status, 403);
    assert.throws(() => relay.klatsch.requestToJoin(guest, circle), /only be friends with another guest/);
    // Unlisted: gone from Explore.
    await gizemB.post(`/ui/c/${circle}/listing`, { about: 'SAP fixes, shared over coffee' });
    assert.ok(!(await erinB.get('/ui/explore')).html.includes(`/ui/explore/${circle}/join`));
  });

  it('hosts add a question to Picks; Picks is a filter in Ask around', async () => {
    const q = relay.klatsch.askAround(bob, circle, 'MMPUR_CONF/026 on a PO confirmation?');
    relay.klatsch.askAround(bob, circle, 'Lunch today?');
    assert.ok((await bobB.post(`/ui/q/${q}/pick`)).status >= 400, 'Bob is no host');
    assert.equal((await gizemB.post(`/ui/q/${q}/pick`)).status, 303);
    const picks = (await bobB.get(`/ui/c/${circle}/ask?state=picks`)).html;
    assert.match(picks, /MMPUR_CONF\/026/);
    assert.doesNotMatch(picks, /Lunch today/);
    assert.equal((await gizemB.post(`/ui/q/${q}/unpick`)).status, 303);
    assert.doesNotMatch((await bobB.get(`/ui/c/${circle}/ask?state=picks`)).html, /MMPUR_CONF\/026/);
  });
});
