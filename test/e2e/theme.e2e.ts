// Night or day: the ⋯ menu has Day, Night and "Same as this device". The choice is a cookie for this browser, and
// every page then marks its <html> with it, so the colours follow without any script. Auto removes the choice.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { signedOutBrowser, startRelay, type Relay } from './harness.ts';

describe('theme: day, night, or the device decides', () => {
  let relay: Relay;
  let alice = '';
  before(async () => {
    relay = await startRelay();
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    relay.klatsch.addMember(relay.klatsch.friendCircle(alice), relay.klatsch.ensureUser('eve', 'Eve'), alice);
  });
  after(async () => relay.close());

  it('the menu offers the three; Night marks every page, Auto takes it back', async () => {
    const b = signedOutBrowser(relay);
    const home = await b.go(relay.loginLink(alice));
    assert.match(home.html, /<form class="theme" method="post" action="\/ui\/theme"/);
    assert.match(home.html, /<html lang="en">/, 'no choice yet: the device decides');
    assert.match(home.html, /value="auto" aria-pressed="true"/);
    const night = await b.post('/ui/theme', { theme: 'dark' });
    assert.match(night.html, /<html lang="en" data-theme="dark">/);
    assert.match(night.html, /value="dark" aria-pressed="true"/);
    assert.match((await b.go('/ui/settings')).html, /data-theme="dark"/, 'on other pages too');
    assert.match((await b.go('/ui/chat/eve')).html, /data-theme="dark"/);
    const day = await b.post('/ui/theme', { theme: 'light' });
    assert.match(day.html, /data-theme="light"/);
    const auto = await b.post('/ui/theme', { theme: 'auto' });
    assert.match(auto.html, /<html lang="en">/);
    // Anything else is no choice either.
    assert.match((await b.post('/ui/theme', { theme: 'pink"><script>' })).html, /<html lang="en">/);
  });

  it('only a signed-in browser posts it, with its form token', async () => {
    const response = await fetch(`${relay.base}/ui/theme`, { method: 'POST', headers: { Origin: relay.base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'theme=dark' });
    assert.notEqual(response.status, 303);
    assert.equal(response.headers.get('set-cookie'), null);
  });
});
