import { hasHiddenCharacters } from './quote.ts';

/**
 * A link card: the one public source a solved sip may point to. Klatsch stores the link, a title and an
 * author as the sharer wrote them and never fetches the page (no preview, no request to that host at all).
 * The rules keep the link to something a reader can judge from its host name: https only, no credentials,
 * no port, no address or local name a browser would resolve inside someone's network.
 */
export const SOURCE_URL_MAX = 1024;
export const SOURCE_TITLE_MAX = 120;
export const SOURCE_AUTHOR_MAX = 80;

export interface Source {
  url: string;
  title: string;
  author?: string;
}

/** Names that never point to a public page: loopback, local networks and the reserved test names. */
const LOCAL_SUFFIXES = ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'intra', 'lan', 'corp', 'home', 'home.arpa', 'svc', 'onion', 'test', 'example', 'invalid'];

// One sentence per rule, never the input: a refused link may hold a customer's host name.
export const SOURCE_REFUSED = {
  url: 'The source must be a public https:// link of at most 1,024 characters, without spaces, invisible characters, a user name, a password or a port.',
  host: 'The source link must name a public host: no IP address, localhost or local network name.',
  title: `The source title must be 1–${SOURCE_TITLE_MAX} characters of plain visible text on one line.`,
  author: `The source author must be 1–${SOURCE_AUTHOR_MAX} characters of plain visible text on one line.`,
  notSolved: 'A source goes only with a solved sip.',
} as const;

/**
 * One line a reader can see in full: no hidden or control characters, no line or paragraph break or tab, no
 * combining mark without a letter before it, no combining grapheme joiner (U+034F, a mark that shows nothing).
 */
function plainLine(text: string, max: number): string | undefined {
  const line = text.trim();
  // Counted in UTF-16 units, as the wire schema counts them.
  if (!line || line.length > max || hasHiddenCharacters(line) || /[\n\t\u2028\u2029\u034F]|^\p{M}|\s\p{M}/u.test(line)) return undefined;
  return line;
}

/** The checked link in its normalised form (lower-case scheme and host, IDN hosts as punycode), or a refusal. */
function checkUrl(raw: string): string | { refused: string } {
  if (raw.length > SOURCE_URL_MAX || /[\s\\]/.test(raw) || hasHiddenCharacters(raw) || !/^https:\/\//i.test(raw)) return { refused: SOURCE_REFUSED.url };
  // Anything before an @ in the authority is a user name (or a host dressed up as one): refused, not dropped.
  if (raw.slice(8).split(/[/?#]/, 1)[0]!.includes('@')) return { refused: SOURCE_REFUSED.url };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { refused: SOURCE_REFUSED.url };
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return { refused: SOURCE_REFUSED.url };
  const host = url.hostname;
  // The parser turns every IPv4 spelling (0x7f.1, 2130706433) into dotted decimal, and IPv6 is bracketed.
  if (host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host) || !host.includes('.') || host.endsWith('.')) return { refused: SOURCE_REFUSED.host };
  if (LOCAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return { refused: SOURCE_REFUSED.host };
  return url.href.length > SOURCE_URL_MAX ? { refused: SOURCE_REFUSED.url } : url.href;
}

/** The source as stored, or the one sentence saying which rule it broke. */
export function checkSource(input: { url: string; title: string; author?: string | undefined }): Source | { refused: string } {
  const url = checkUrl(input.url);
  if (typeof url !== 'string') return url;
  const title = plainLine(input.title, SOURCE_TITLE_MAX);
  if (!title) return { refused: SOURCE_REFUSED.title };
  if (input.author === undefined) return { url, title };
  const author = plainLine(input.author, SOURCE_AUTHOR_MAX);
  if (!author) return { refused: SOURCE_REFUSED.author };
  return { url, title, author };
}

/** At most `max` UTF-16 units, never splitting a character: cleaning (NFKC) can make a title longer than it was. */
export function clip(text: string, max: number): string {
  let out = '';
  for (const char of text) {
    if (out.length + char.length > max) break;
    out += char;
  }
  return out;
}

/**
 * The host a reader judges the link by, shown next to the title so a title cannot pass for another site:
 * the full host name (IDN as punycode, so a look-alike shows as `xn--…`), only a leading `www.` dropped.
 * Never shortened to a guessed registrable domain: without the public suffix list that guess would show
 * `github.io` for `evil.github.io`.
 */
export const sourceHost = (url: string): string => new URL(url).hostname.replace(/^www\./, '');
