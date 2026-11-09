// A software passkey for tests: a real P-256 key, the attestation object ('none') and assertions a browser would
// pass on, built by hand, so the relay's checks run on the same bytes as with a real authenticator.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

type Cbor = number | string | Uint8Array | Map<number | string, Cbor> | { [key: string]: Cbor };

function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  if (length < 65536) return Buffer.from([(major << 5) | 25, length >> 8, length & 255]);
  const out = Buffer.alloc(5);
  out[0] = (major << 5) | 26;
  out.writeUInt32BE(length, 1);
  return out;
}

/** Just the CBOR WebAuthn needs: integers, byte and text strings, maps. */
export function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest();

/** Flags: user present, user verified, attested credential data; backup eligible and backed up when synced. */
const UP = 0x01;
const UV = 0x04;
const BE = 0x08;
const BS = 0x10;
const AT = 0x40;

export class SoftPasskey {
  readonly id = randomBytes(32);
  readonly privateKey: KeyObject;
  private readonly publicJwk: { x: string; y: string };
  counter = 0;
  userHandle: string | undefined;

  readonly options: { verified?: boolean; synced?: boolean };

  constructor(options: { verified?: boolean; synced?: boolean } = {}) {
    this.options = options;
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = pair.privateKey;
    const jwk = pair.publicKey.export({ format: 'jwk' });
    this.publicJwk = { x: jwk.x!, y: jwk.y! };
  }

  private flags(extra: number) {
    return UP | (this.options.verified === false ? 0 : UV) | (this.options.synced ? BE | BS : 0) | extra;
  }

  private authData(rpID: string, flags: number, attested?: Buffer) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    return Buffer.concat([sha256(rpID), Buffer.from([flags]), count, ...(attested ? [attested] : [])]);
  }

  /** What `navigator.credentials.create` resolves to, as the passkey script posts it. */
  register(options: { challenge: string; rp: { id?: string }; user: { id: string } }, origin: string, rpID = options.rp.id ?? new URL(origin).hostname) {
    this.userHandle = options.user.id;
    const key = new Map<number, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(this.publicJwk.x, 'base64url')],
      [-3, Buffer.from(this.publicJwk.y, 'base64url')],
    ]);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(this.id.length);
    const attested = Buffer.concat([Buffer.alloc(16), length, this.id, cbor(key)]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }));
    const attestationObject = cbor({ fmt: 'none', attStmt: new Map(), authData: this.authData(rpID, this.flags(AT), attested) });
    return {
      id: b64(this.id),
      rawId: b64(this.id),
      type: 'public-key',
      clientExtensionResults: {},
      response: { clientDataJSON: b64(clientDataJSON), attestationObject: b64(attestationObject), transports: ['internal'] },
    };
  }

  /** What `navigator.credentials.get` resolves to; the counter goes up by one unless `counter` is given. */
  assert(options: { challenge: string; rpId?: string }, origin: string, at: { counter?: number; rpID?: string } = {}) {
    this.counter = at.counter ?? this.counter + 1;
    const authenticatorData = this.authData(at.rpID ?? options.rpId ?? new URL(origin).hostname, this.flags(0));
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }));
    const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.privateKey);
    return {
      id: b64(this.id),
      rawId: b64(this.id),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64(clientDataJSON),
        authenticatorData: b64(authenticatorData),
        signature: b64(signature),
        ...(this.userHandle ? { userHandle: this.userHandle } : {}),
      },
    };
  }
}
