// Circles as communities: anyone starts a circle; it has rooms (general, and announcements only hosts write in);
// hosts set house rules (accepted once before writing) and slow mode, add rooms, pause someone, and see reports;
// the owner makes hosts. A new member shares no links on their first day. Nobody outside a circle sees into it.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { browser, startRelay, type Browser, type Relay } from './harness.ts';

describe('circles: rooms, hosts, rules and reports', () => {
  let relay: Relay;
  let gizem = '', bob = '', carol = '', frank = '';
  let gizemB: Browser, bobB: Browser, carolB: Browser, frankB: Browser;
  let circle = '', general = '', news = '';

  before(async () => {
    relay = await startRelay({ guest: true });
    gizem = relay.klatsch.ensureUser('gizem', 'Gizem');
    bob = relay.klatsch.ensureUser('bob', 'Bob');
    carol = relay.klatsch.ensureUser('carol', 'Carol');
    frank = relay.klatsch.ensureUser('frank', 'Frank');
    relay.klatsch.ensureCircle('frank-own', frank);
    gizemB = await browser(relay, relay.loginLink(gizem));
    frankB = await browser(relay, relay.loginLink(frank));
  });
  after(async () => relay.close());

  it('anyone starts a circle from the Circles tab; it opens with general and announcements', async () => {
    assert.match((await gizemB.get('/ui/circles')).html, /<form class="newcircle" method="post" action="\/ui\/circles\/new">/);
    const made = await gizemB.post('/ui/circles/new', { name: 'SAP crowd' });
    assert.equal(made.status, 303);
    circle = relay.db.prepare(`SELECT id FROM circles WHERE name = 'SAP crowd'`).get()!.id as string;
    const space = relay.klatsch.space(gizem, circle);
    assert.deepEqual(space.rooms.map((r) => [r.name, r.announce]), [['general', false], ['announcements', true]]);
    [general, news] = space.rooms.map((r) => r.id) as [string, string];
    assert.equal(space.owner, true);
    assert.equal(space.host, true);
    relay.klatsch.addMember(circle, bob, gizem);
    relay.klatsch.addMember(circle, carol, gizem);
    bobB = await browser(relay, relay.loginLink(bob));
    carolB = await browser(relay, relay.loginLink(carol));
    assert.match((await bobB.get('/ui/circles')).html, /SAP crowd/);
    // A circle's own address opens its first room.
    const opened = await bobB.get(`/ui/c/${circle}`);
    assert.equal(opened.status, 302);
  });

  it('members write in general; only hosts in announcements; the room shows who wrote', async () => {
    assert.equal((await bobB.post(`/ui/c/${circle}/r/${general}`, { text: 'Anyone seen MMPUR_CONF/026?' })).status, 303);
    const page = (await carolB.get(`/ui/c/${circle}/r/${general}`)).html;
    assert.match(page, /<span class="m from">Bob<\/span>[\s\S]*?Anyone seen MMPUR_CONF\/026\?/);
    assert.ok((await bobB.post(`/ui/c/${circle}/r/${news}`, { text: 'Hi all' })).status >= 400, 'only hosts announce');
    assert.match((await bobB.get(`/ui/c/${circle}/r/${news}`)).html, /Only hosts write in an announcements room\./);
    assert.equal((await gizemB.post(`/ui/c/${circle}/r/${news}`, { text: 'Welcome!' })).status, 303);
    // Unread: Carol has not opened announcements yet.
    assert.equal(relay.klatsch.space(carol, circle).rooms.find((r) => r.id === news)!.unread, 1);
  });

  it('house rules are accepted once before writing; new rules are accepted again', async () => {
    assert.equal((await gizemB.post(`/ui/c/${circle}/settings`, { rules: 'Be kind. No sales.', slow: '0' })).status, 303);
    const gate = (await bobB.get(`/ui/c/${circle}/r/${general}`)).html;
    assert.match(gate, /<form class="rulesgate"[\s\S]*Be kind\. No sales\./);
    assert.ok((await bobB.post(`/ui/c/${circle}/r/${general}`, { text: 'Hi' })).status >= 400);
    assert.equal((await bobB.post(`/ui/c/${circle}/rules`, { back: general })).status, 303);
    assert.equal((await bobB.post(`/ui/c/${circle}/r/${general}`, { text: 'Read them.' })).status, 303);
    await carolB.post(`/ui/c/${circle}/rules`, { back: general });
  });

  it('slow mode; a new member shares no links on their first day; a host pauses someone', async () => {
    await gizemB.post(`/ui/c/${circle}/settings`, { rules: 'Be kind. No sales.', slow: '30' });
    assert.equal((await carolB.post(`/ui/c/${circle}/r/${general}`, { text: 'One' })).status, 303);
    assert.match((await carolB.post(`/ui/c/${circle}/r/${general}`, { text: 'Two' })).html, /Slow mode: one message every 30 seconds/);
    await gizemB.post(`/ui/c/${circle}/settings`, { rules: 'Be kind. No sales.', slow: '0' });
    assert.match((await carolB.post(`/ui/c/${circle}/r/${general}`, { text: 'See https://example.org' })).html, /links can be shared after your first day/);
    relay.db.prepare('UPDATE memberships SET created_at = ? WHERE circle_id = ? AND user_id = ?').run(Date.now() - 2 * 24 * 60 * 60 * 1000, circle, carol);
    assert.equal((await carolB.post(`/ui/c/${circle}/r/${general}`, { text: 'See https://example.org' })).status, 303);
    assert.equal((await gizemB.post(`/ui/c/${circle}/members/${carol}/timeout`, { minutes: '10' })).status, 303);
    assert.match((await carolB.get(`/ui/c/${circle}/r/${general}`)).html, /A host paused your writing here until/);
    await gizemB.post(`/ui/c/${circle}/members/${carol}/timeout`, { minutes: '0' });
    assert.equal((await carolB.post(`/ui/c/${circle}/r/${general}`, { text: 'Back.' })).status, 303);
  });

  it('the owner makes Bob a host; hosts add rooms; a member cannot', async () => {
    assert.ok((await bobB.post(`/ui/c/${circle}/rooms`, { name: 'abap' })).status >= 400);
    assert.equal((await gizemB.post(`/ui/c/${circle}/members/${bob}/host`)).status, 303);
    assert.equal(relay.klatsch.isHost(bob, circle), true);
    assert.equal((await bobB.post(`/ui/c/${circle}/rooms`, { name: 'ABAP & RAP!' })).status, 303);
    assert.ok(relay.klatsch.space(gizem, circle).rooms.some((r) => r.name === 'abap-rap'));
    assert.ok((await bobB.post(`/ui/c/${circle}/members/${carol}/host`)).status >= 400, 'only the owner makes hosts');
    assert.match((await bobB.get(`/ui/c/${circle}/settings`)).html, /Circle settings/);
    assert.match((await carolB.get(`/ui/c/${circle}/settings`)).html, /About this circle[\s\S]*Be kind\. No sales\./);
  });

  it('a report reaches the hosts; they delete it for everyone or keep it', async () => {
    const id = relay.klatsch.postRoomMessage(carol, general, 'Buy my course!');
    assert.equal((await bobB.post(`/ui/rm/${id}/report`, { reason: 'sales' })).status, 200);
    const reports = (await gizemB.get(`/ui/c/${circle}/reports`)).html;
    assert.match(reports, /Buy my course![\s\S]*Reported by Bob · sales/);
    assert.match((await gizemB.get(`/ui/c/${circle}/r/${general}`)).html, /1 report/);
    assert.ok((await carolB.get(`/ui/c/${circle}/reports`)).status >= 400, 'reports are for hosts');
    assert.equal((await gizemB.post(`/ui/rm/${id}/delete`)).status, 303);
    assert.match((await carolB.get(`/ui/c/${circle}/r/${general}`)).html, /This message was deleted/);
    const other = relay.klatsch.postRoomMessage(carol, general, 'Fine message');
    await bobB.post(`/ui/rm/${other}/report`, { reason: '' });
    const report = relay.klatsch.roomReports(gizem, circle)[0]!.id;
    assert.equal((await gizemB.post(`/ui/reports/${report}/dismiss`)).status, 303);
    assert.equal(relay.klatsch.roomReports(gizem, circle).length, 0);
    assert.ok((await carolB.post(`/ui/rm/${relay.klatsch.postRoomMessage(bob, general, 'mine')}/delete`)).status >= 400, 'not hers to delete');
  });

  it('nobody outside a circle sees into it; guests start none; friendships stay in Chats', async () => {
    assert.equal((await frankB.get(`/ui/c/${circle}/r/${general}`)).status, 404);
    assert.ok((await frankB.post(`/ui/c/${circle}/r/${general}`, { text: 'Hi' })).status >= 400);
    assert.doesNotMatch((await frankB.get('/ui/circles')).html, /SAP crowd/);
    const guest = relay.klatsch.startGuest();
    assert.throws(() => relay.klatsch.createCircle(guest, 'Mine'), /only be friends with another guest/);
    const friendship = relay.klatsch.friendCircle(gizem);
    relay.klatsch.addMember(friendship, frank, gizem);
    assert.ok(!relay.klatsch.spacesOf(gizem).some((s) => s.id === friendship));
    for (let i = 0; i < 4; i++) relay.klatsch.createCircle(gizem, `Extra ${i}`);
    assert.throws(() => relay.klatsch.createCircle(gizem, 'One too many'), /5 circles/);
  });
});
