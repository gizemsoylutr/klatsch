import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * What people wrote, sealed in the database with a key from the server secret (AES-256-GCM). The secret is a file
 * next to the database and is not replicated, so a backup, or a copy of the database file alone, shows no shared
 * text. It does not hide anything from whoever runs the relay: the relay holds the key and opens the text to show it.
 */
export const SEALED_PREFIX = 'klatsch-sealed:v1:';
const LABEL = 'klatsch-text-v1';

export interface Sealer {
  seal(text: string): string;
  /** The text, or undefined when this key did not seal it. */
  open(value: string): string | undefined;
}

export function sealerFrom(secret: Buffer): Sealer {
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), LABEL, 32));
  return {
    seal(text) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(LABEL));
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return SEALED_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
    },
    open(value) {
      if (!value.startsWith(SEALED_PREFIX)) return undefined;
      const raw = Buffer.from(value.slice(SEALED_PREFIX.length), 'base64url');
      if (raw.length < 28) return undefined;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
        decipher.setAAD(Buffer.from(LABEL));
        decipher.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
      } catch {
        return undefined;
      }
    },
  };
}

/** Every column that holds someone's words, or something taken from them. Account data is not among them. */
export const SEALED_COLUMNS: [table: string, id: string, columns: string[]][] = [
  ['sips', 'id', ['summary', 'flags', 'source_url', 'source_title', 'source_author']],
  ['handoffs', 'id', ['text', 'source_url', 'source_title', 'source_author']],
  ['approvals', 'id', ['payload']],
  ['sip_vectors', 'sip_id', ['vector']],
  ['asks', 'id', ['question', 'answer']],
];
