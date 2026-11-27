// Voice notes in a real browser, like a messenger: Alice holds the microphone on her conversation with Eve, talks,
// lets go, and the note is in the conversation with a player. Chromium only: it has a fake microphone for tests
// (WebKit has none), so a real recording runs through MediaRecorder, the form token and the upload.
import { chromium, expect, test } from '@playwright/test';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { person } from './people.ts';

test('Alice holds the microphone, talks, lets go, and Eve hears the voice note', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'Only Chromium has a fake microphone for tests.');
  const relay: Relay = await startRelay();
  const alice = relay.klatsch.ensureUser('alice', 'Alice');
  const eve = relay.klatsch.ensureUser('eve', 'Eve');
  relay.klatsch.addMember(relay.klatsch.friendCircle(alice), eve, alice);
  const withMic = await chromium.launch({
    ...(process.env.CI ? {} : { channel: 'chrome' }),
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const a = await person(withMic, relay, 'Alice', import.meta.filename, relay.loginLink(alice), { permissions: ['microphone'] });
  await a.open(`${relay.base}/ui/chat/eve`);
  const mic = a.page.getByRole('button', { name: 'Hold to record a voice note' });
  await expect(mic).toBeVisible();
  await expect(a.page.getByText('Hold the microphone to record, let go to send.')).toBeVisible();

  const box = (await mic.boundingBox())!;
  await a.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await a.page.mouse.down();
  await expect(a.page.getByText(/Recording 0:0\d/)).toBeVisible();
  await a.shot('voice-recording.png');
  await a.page.waitForTimeout(1500);
  await Promise.all([a.page.waitForEvent('load'), a.page.mouse.up()]);
  await expect(a.page.locator('.msg.mine audio')).toHaveCount(1);
  await a.shot('voice-sent.png');

  // A slip off the button cancels: nothing more is sent. (The page reloaded, so the button moved.)
  const again = (await mic.boundingBox())!;
  await a.page.mouse.move(again.x + again.width / 2, again.y + again.height / 2);
  await a.page.mouse.down();
  await expect(a.page.getByText(/Recording/)).toBeVisible();
  await a.page.mouse.move(again.x - 200, again.y - 200);
  await expect(a.page.getByText('Cancelled.')).toBeVisible();
  await a.page.mouse.up();
  await expect(a.page.locator('.msg.mine audio')).toHaveCount(1);

  const sent = relay.klatsch.conversation(eve, '@alice').messages.at(-1)!;
  expect(sent.text).toBe('🎤 Voice note');
  expect(sent.files[0]!.mime).toMatch(/^audio\//);
  expect(sent.files[0]!.size).toBeGreaterThan(1000);
  await a.expectCleanBrowser();
  await a.context.close();
  await withMic.close();
  await relay.close();
});
