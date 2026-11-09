export type FlagKind = 'email' | 'url' | 'ip' | 'hostname' | 'system-id' | 'secret';

export interface Flag {
  kind: FlagKind;
  text: string;
}

// Detectors only flag. Nothing is "stripped": a regex cannot know a customer
// name, so the human decides in the preview.
const DETECTORS: [FlagKind, RegExp][] = [
  ['email', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi],
  ['url', /\b(?:https?|ftp):\/\/[^\s)]+[^\s).,;:!?'"]/gi],
  ['ip', /\b(?:\d{1,3}\.){3}\d{1,3}\b/g],
  ['ip', /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi],
  ['hostname', /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z][a-z0-9-]*\b/gi],
  ['hostname', /\b[a-z0-9-]+\.(?:internal|local|corp|lan|intra)\b/gi],
  ['system-id', /\b[A-Z][A-Z0-9]{2}\s*(?:\/|client\s*|mandant\s*)\d{3}\b/gi],
  ['system-id', /\b(?:client|mandant|sid)\s*[:=]?\s*[A-Z0-9]{3}\b/gi],
  ['secret', /\b[A-Za-z0-9+/_-]{32,}={0,2}/g],
];

export function detect(text: string): Flag[] {
  const seen = new Set<string>();
  const flags: Flag[] = [];
  for (const [kind, pattern] of DETECTORS) {
    for (const match of text.matchAll(pattern)) {
      const key = `${kind}:${match[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      flags.push({ kind, text: match[0] });
    }
  }
  // Drop a flag already covered by a longer one of the same kind (acme.internal inside db.acme.internal).
  return flags.filter((f) => !flags.some((g) => g !== f && g.kind === f.kind && g.text.length > f.text.length && g.text.includes(f.text)));
}
