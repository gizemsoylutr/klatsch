/**
 * Files sent with a direct question or its answer: a voice note, a photo, a PDF. What a file is, Klatsch reads from
 * its first bytes and never from the name or the browser's word for it; anything else is refused. Small, few, and
 * gone with the question after 14 days.
 */

export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const ATTACHMENTS_PER_SIDE = 3;
export const ATTACHMENT_BYTES_PER_DAY = 25 * 1024 * 1024;

export interface AttachmentKind {
  mime: string;
  kind: 'image' | 'audio' | 'pdf';
}

const at = (bytes: Uint8Array, offset: number, text: string) => [...text].every((ch, i) => bytes[offset + i] === ch.charCodeAt(0));

/** The file's real type from its first bytes, or undefined when it is not one Klatsch takes. */
export function sniff(bytes: Uint8Array): AttachmentKind | undefined {
  if (bytes.length < 12) return undefined;
  if (bytes[0] === 0x89 && at(bytes, 1, 'PNG')) return { mime: 'image/png', kind: 'image' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: 'image/jpeg', kind: 'image' };
  if (at(bytes, 0, 'GIF8')) return { mime: 'image/gif', kind: 'image' };
  if (at(bytes, 0, 'RIFF') && at(bytes, 8, 'WEBP')) return { mime: 'image/webp', kind: 'image' };
  if (at(bytes, 0, '%PDF-')) return { mime: 'application/pdf', kind: 'pdf' };
  if (at(bytes, 0, 'ID3') || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) return { mime: 'audio/mpeg', kind: 'audio' };
  if (at(bytes, 0, 'OggS')) return { mime: 'audio/ogg', kind: 'audio' };
  if (at(bytes, 0, 'RIFF') && at(bytes, 8, 'WAVE')) return { mime: 'audio/wav', kind: 'audio' };
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return { mime: 'audio/webm', kind: 'audio' };
  // ISO media (m4a, a phone's voice memo): "ftyp" at 4; audio brands only, never video.
  if (at(bytes, 4, 'ftyp')) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    if (['M4A ', 'M4B ', 'mp42', 'isom', 'dash'].includes(brand)) return { mime: 'audio/mp4', kind: 'audio' };
  }
  return undefined;
}

/** A file name to show: printable, short, no path; the type's own extension when it had none. */
export function cleanName(name: string, kind: AttachmentKind): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const printable = [...base.normalize('NFC').replace(/[\p{C}\p{Zl}\p{Zp}"]/gu, '').trim()].slice(0, 80).join('');
  const fallback = { image: 'image', audio: 'voice note', pdf: 'document' }[kind.kind];
  return printable || fallback;
}
