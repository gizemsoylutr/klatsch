// Web sign-ins: a session lasts 30 days from its last use, 90 at most, and Settings signs out every other browser.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { browser, startRelay, type Browser, type Relay } from './harness.ts';

describe('sessions: Alice signs in on two browsers and signs out the other one from Settings', () => {
  let relay: Relay;
  let laptop: Browser;
  let phone: Browser;

  before(async () => {
    relay = await startRelay();
    const alice = relay.klatsch.ensureUser('alice', 'Alice');
    relay.klatsch.ensureCircle('demo', alice);
    laptop = await browser(relay, relay.loginLink(alice));
    phone = await browser(relay, relay.loginLink(alice));
  });
  after(async () => {
    await relay.close();
  });

  it('Settings says one other browser is signed in, and how long a sign-in lasts', async () => {
    const page = (await laptop.get('/ui/settings')).html;
    assert.match(page, /This browser and 1 other\. A sign-in lasts 30 days from its last use, 90 at most\./);
    assert.match(page, /action="\/ui\/settings\/sessions\/end-others"/);
  });

  it('"Sign out everywhere else" ends the phone, not the laptop', async () => {
    assert.equal((await laptop.post('/ui/settings/sessions/end-others')).status, 303);
    assert.equal((await phone.get('/ui')).status, 401);
    const page = (await laptop.get('/ui/settings')).html;
    assert.match(page, /Only this browser\./);
    assert.doesNotMatch(page, /end-others/, 'no button with nobody else signed in');
  });
});
