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
  /** A file's bytes, sealed the same way under their own label: iv, tag, then the ciphertext. */
  sealBytes(bytes: Buffer): Buffer;
  openBytes(value: Buffer): Buffer | undefined;
}

const FILE_LABEL = 'klatsch-file-v1';

export function sealerFrom(secret: Buffer): Sealer {
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), LABEL, 32));
  const fileKey = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), FILE_LABEL, 32));
  return {
    sealBytes(bytes) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', fileKey, iv);
      cipher.setAAD(Buffer.from(FILE_LABEL));
      const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    openBytes(value) {
      if (value.length < 28) return undefined;
      try {
        const decipher = createDecipheriv('aes-256-gcm', fileKey, value.subarray(0, 12));
        decipher.setAAD(Buffer.from(FILE_LABEL));
        decipher.setAuthTag(value.subarray(12, 28));
        return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]);
      } catch {
        return undefined;
      }
    },
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
  ['events', 'id', ['how']],
  ['room_messages', 'id', ['body']],
  ['room_reports', 'id', ['reason']],
  ['circles', 'id', ['rules']],
  ['questions', 'id', ['title', 'body']],
  ['answers', 'id', ['body']],
];
