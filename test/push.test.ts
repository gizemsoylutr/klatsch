// Web Push on node:crypto: the RFC 8291 test vector, a VAPID token a push service would accept, and the list of
// push services the relay will post to.
import assert from 'node:assert/strict';
import { createECDH, createPublicKey, verify } from 'node:crypto';
import { describe, it } from 'node:test';
import { encryptPush, pushEndpointAllowed, pushKeyValid, sendPush, vapidFromSecret, vapidHeader } from '../src/notify/push.ts';

describe('web push', () => {
  it('encrypts exactly as RFC 8291, Appendix A', () => {
    const plaintext = Buffer.from('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24', 'base64url');
    const out = encryptPush(
      plaintext,
      { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
      { privateKey: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url') },
      Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
    );
    assert.equal(
      out.toString('base64url'),
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('derives one VAPID key from the server secret and signs a token for the push service’s origin', () => {
    const secret = Buffer.alloc(32, 7);
    const vapid = vapidFromSecret(secret);
    assert.equal(vapidFromSecret(secret).publicKey, vapid.publicKey, 'the same secret, the same key');
    assert.notEqual(vapidFromSecret(Buffer.alloc(32, 8)).publicKey, vapid.publicKey);
    assert.equal(Buffer.from(vapid.publicKey, 'base64url').length, 65);
    const header = vapidHeader(vapid, 'https://fcm.googleapis.com/fcm/send/abc', 'mailto:privacy@klatsch.dev', 1_800_000_000_000);
    const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    assert.equal(k, vapid.publicKey);
    const [h, c, s] = token!.split('.');
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
    assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp: 1_800_000_000 + 12 * 3600, sub: 'mailto:privacy@klatsch.dev' });
    const raw = Buffer.from(vapid.publicKey, 'base64url');
    const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url')));
  });

  it('posts only to the push services browsers use', () => {
    for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://fcm.googleapis.com/wp/abc:def', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/QX', 'https://wns2-db5p.notify.windows.com/w/?token=x']) {
      assert.ok(pushEndpointAllowed(ok), ok);
    }
    for (const bad of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com:444/x', 'https://evil.example/x', 'https://127.0.0.1/x', 'https://user@fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.example/x', 'not a url', 'https://fcm.googleapis.com/v1/projects/p/messages:send', 'https://FCM.googleapis.com/fcm/send/x', 'https://fcm.googleapis.com./fcm/send/x', 'https://fcm.googleapis.com:443/fcm/send/x', 'https://fcm.googleapis.com/fcm/send/x\r\nHost: evil', 'https://evil.example\\@fcm.googleapis.com/fcm/send/x', 'https://ｆcm.googleapis.com/fcm/send/x']) {
      assert.ok(!pushEndpointAllowed(bad), bad);
    }
  });

  it('sends one encrypted request, forgets a subscription the service says is gone, and never throws', async () => {
    const vapid = vapidFromSecret(Buffer.alloc(32, 7));
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const sub = { id: 'p1', endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') };
    const seen: { url: string; init: RequestInit }[] = [];
    const answer = (status: number) => (async (url: string, init: RequestInit) => (seen.push({ url, init }), new Response(null, { status }))) as unknown as typeof fetch;
    assert.equal(await sendPush(vapid, 'mailto:x@example.org', sub, { title: 'Klatsch', body: '☕ Something new in your circle.', url: '/ui' }, answer(201)), 'sent');
    const headers = seen[0]!.init.headers as Record<string, string>;
    assert.equal(headers['Content-Encoding'], 'aes128gcm');
    assert.match(headers.Authorization!, /^vapid t=/);
    assert.ok(!Buffer.from(seen[0]!.init.body as Uint8Array).toString().includes('Something new'), 'encrypted');
    assert.equal(seen[0]!.init.redirect, 'error', 'never follows a redirect');
    assert.equal(await sendPush(vapid, 'mailto:x@example.org', sub, { title: 'K', body: 'b', url: '/ui' }, answer(410)), 'gone');
    const broken = (async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    assert.equal(await sendPush(vapid, 'mailto:x@example.org', sub, { title: 'K', body: 'b', url: '/ui' }, broken, sleep), 'failed');
    assert.deepEqual(waits, [2_000, 8_000], 'two more tries when the service cannot be reached');
    assert.equal(headers.Urgency, 'high', 'a person wrote: phones in power saving must not hold it back');
    // Busy (429, 5xx): tried again, after Retry-After when it says one; refused (400, 403): final at once.
    let calls = 0;
    const busyThenOk = (async () => (++calls === 1 ? new Response(null, { status: 429, headers: { 'Retry-After': '5' } }) : new Response(null, { status: 201 }))) as unknown as typeof fetch;
    waits.length = 0;
    assert.equal(await sendPush(vapid, 'mailto:x@example.org', sub, { title: 'K', body: 'b', url: '/ui' }, busyThenOk, sleep), 'sent');
    assert.deepEqual(waits, [5_000]);
    seen.length = 0;
    assert.equal(await sendPush(vapid, 'mailto:x@example.org', sub, { title: 'K', body: 'b', url: '/ui' }, answer(403), sleep), 'failed');
    assert.equal(seen.length, 1);
    assert.equal(await sendPush(vapid, 'mailto:x@example.org', { ...sub, endpoint: 'https://evil.example/x' }, { title: 'K', body: 'b', url: '/ui' }, answer(201)), 'gone');
  });

  it('accepts only a browser key that is a point on P-256', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    assert.ok(pushKeyValid(ua.getPublicKey().toString('base64url')));
    assert.ok(!pushKeyValid(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url')));
    assert.ok(!pushKeyValid('short'));
  });
});
