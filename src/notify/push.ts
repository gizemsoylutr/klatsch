import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/**
 * Web Push without a library: message encryption (RFC 8291, aes128gcm) and VAPID (RFC 8292), on node:crypto.
 * A notification carries no shared text and no name: only a fixed line such as "Something new in your circle".
 */

const b64u = (buf: Buffer) => buf.toString('base64url');

/**
 * The push services browsers use, with the paths their subscriptions have. The relay posts only there, so a
 * subscription cannot point it at any other service or any other API of these hosts.
 */
const PUSH_SERVICES: [RegExp, RegExp][] = [
  [/^fcm\.googleapis\.com$/, /^\/(fcm\/send|wp)\/[\w:-]+$/],
  [/^updates\.push\.services\.mozilla\.com$/, /^\/wpush\/v[12]\/[\w-]+$/],
  [/^web\.push\.apple\.com$/, /^\/[\w-]+$/],
  [/^[a-z0-9-]+\.notify\.windows\.com$/, /^\/w\/$/],
];

/** The endpoint as the relay stores and calls it, or undefined when it is not a known push service's. */
export function pushEndpoint(endpoint: string): string | undefined {
  if (endpoint.length > 1024 || /[^\x21-\x7e]/.test(endpoint)) return undefined;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) return undefined;
  return PUSH_SERVICES.some(([host, path]) => host.test(url.hostname) && path.test(url.pathname)) ? url.href : undefined;
}

export function pushEndpointAllowed(endpoint: string): boolean {
  return pushEndpoint(endpoint) === endpoint;
}

/** Whether a browser's key is a point on P-256: a key that is not would fail every message. */
export function pushKeyValid(p256dh: string): boolean {
  try {
    const key = Buffer.from(p256dh, 'base64url');
    if (key.length !== 65 || key[0] !== 4) return false;
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    ecdh.computeSecret(key);
    return true;
  } catch {
    return false;
  }
}

export interface Vapid {
  /** The public key as browsers want it for `applicationServerKey`: the uncompressed point, base64url. */
  publicKey: string;
  key: KeyObject;
  raw: Buffer;
}

/** The relay's VAPID key, derived from the server secret, so it needs no file of its own and survives a restore. */
export function vapidFromSecret(secret: Buffer): Vapid {
  // A P-256 scalar from HKDF; the chance it falls outside the curve's order is about 2^-32, and then the next counter is tried.
  for (let counter = 0; ; counter++) {
    const d = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), `klatsch-vapid ${counter}`, 32));
    try {
      const ecdh = createECDH('prime256v1');
      ecdh.setPrivateKey(d);
      const raw = ecdh.getPublicKey();
      const key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: b64u(d), x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)) }, format: 'jwk' });
      return { publicKey: b64u(raw), key, raw };
    } catch {
      // Not a valid scalar: try the next one.
    }
  }
}

/** The `Authorization` header for one push service (RFC 8292): a JWT for its origin, valid twelve hours. */
export function vapidHeader(vapid: Vapid, endpoint: string, subject: string, now = Date.now()): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: vapid.key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${vapid.publicKey}`;
}

/**
 * Encrypts one message for one subscription (RFC 8291). `local` and `salt` are only for the RFC's test vector;
 * every real message gets a new key pair and salt.
 */
export function encryptPush(
  payload: Buffer,
  subscription: { p256dh: string; auth: string },
  local?: { privateKey: Buffer },
  salt: Buffer = randomBytes(16),
): Buffer {
  const uaPublic = Buffer.from(subscription.p256dh, 'base64url');
  const authSecret = Buffer.from(subscription.auth, 'base64url');
  const ecdh = createECDH('prime256v1');
  if (local) ecdh.setPrivateKey(local.privateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // One record: the payload, then the last-record delimiter 0x02.
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Sends one notification. True when the push service took it; `gone` when it says the subscription no longer
 * exists (404, 410), so the relay forgets it. Never throws; failures are logged by status only.
 */
export async function sendPush(
  vapid: Vapid,
  subject: string,
  subscription: PushSubscriptionRow,
  message: { title: string; body: string; url: string },
  fetcher: typeof fetch = fetch,
): Promise<'sent' | 'gone' | 'failed'> {
  if (!pushEndpointAllowed(subscription.endpoint)) return 'gone';
  try {
    const response = await fetcher(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidHeader(vapid, subscription.endpoint, subject),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(24 * 3600),
        Urgency: 'normal',
      },
      body: new Uint8Array(encryptPush(Buffer.from(JSON.stringify(message)), subscription)),
      signal: AbortSignal.timeout(10_000),
      // A push service never needs to send the message elsewhere.
      redirect: 'error',
    });
    await response.body?.cancel();
    if (response.status === 404 || response.status === 410) return 'gone';
    if (!response.ok) console.error(`klatsch: push service answered ${response.status}`);
    return response.ok ? 'sent' : 'failed';
  } catch {
    console.error('klatsch: push service unreachable');
    return 'failed';
  }
}
