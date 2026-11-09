// A hosted relay's privacy and terms pages: public, from the landing page, naming who runs it, and absent on a relay
// whose operator has not said who they are, so a self-hoster never publishes someone else's promises.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { envConfig } from '../../src/config.ts';
import { startRelay, type Relay } from './harness.ts';

const OPERATOR = { name: 'Ada <Lovelace>', email: 'ada@example.org', processors: 'Hosting: Example Cloud, in France.' };
const page = async (relay: Relay, path: string) => {
  const response = await fetch(new URL(path, relay.base), { headers: { Accept: 'text/html' } });
  return { status: response.status, html: await response.text(), csp: response.headers.get('content-security-policy') ?? '' };
};

describe('privacy and terms pages', () => {
  let relay: Relay;
  let bare: Relay;
  before(async () => {
    relay = await startRelay({ operator: OPERATOR });
    bare = await startRelay();
  });
  after(async () => {
    await relay.close();
    await bare.close();
  });

  it('the landing page links to both, without signing in', async () => {
    const home = (await page(relay, '/')).html;
    assert.ok(home.includes('href="/privacy"') && home.includes('href="/terms"'));
  });

  it('the privacy page names the operator, escaped, and what it must say plainly', async () => {
    const { status, html, csp } = await page(relay, '/privacy');
    assert.equal(status, 200);
    assert.ok(html.includes('Ada &lt;Lovelace&gt;') && !html.includes('Ada <Lovelace>'));
    assert.ok(html.includes('ada@example.org') && html.includes('Hosting: Example Cloud'));
    assert.match(html, /Whoever runs a relay can read everything on it/);
    assert.match(html, /Settings has Delete account, which removes your account and everything you shared at once\./);
    assert.match(csp, /default-src 'none'/);
  });

  it('the terms page says it is free and as it is', async () => {
    const { status, html } = await page(relay, '/terms');
    assert.equal(status, 200);
    assert.match(html, /provided as it is/);
    assert.match(html, /Read what you approve/);
  });

  it('a relay that has not named its operator has no such pages and no such links', async () => {
    assert.equal((await page(bare, '/privacy')).status, 404);
    assert.equal((await page(bare, '/terms')).status, 404);
    assert.ok(!(await page(bare, '/')).html.includes('href="/privacy"'));
  });

  it('all three settings or none', () => {
    assert.deepEqual(envConfig({ KLATSCH_OPERATOR_NAME: 'A', KLATSCH_OPERATOR_EMAIL: 'a@b.c', KLATSCH_OPERATOR_PROCESSORS: 'P' }).operator, { name: 'A', email: 'a@b.c', processors: 'P' });
    assert.throws(() => envConfig({ KLATSCH_OPERATOR_NAME: 'A' }), /or none/);
    assert.equal(envConfig({}).operator, undefined);
  });
});
