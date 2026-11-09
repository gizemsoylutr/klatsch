/** How long a quote handed to an agent may be. Sips are shorter today; the cap holds if that changes. */
export const QUOTE_MAX = 2000;

// ANSI escape sequences (CSI and OSC).
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g;
// Control characters except newline and tab.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
/**
 * Characters a reader cannot see but a model reads: format characters (zero-width, bidi, tag characters),
 * private-use, surrogates and unassigned code points, variation selectors, and the Hangul fillers that
 * render as blanks.
 */
const HIDDEN = /[\p{Cf}\p{Co}\p{Cs}\p{Cn}\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u3164\u115F\u1160\uFFA0]/gu;

/**
 * True when `text` holds anything a person would not see on the page: hidden characters, escape
 * sequences or control characters other than newline and tab. Such text is refused before any human
 * approves it, so nobody approves words they cannot read.
 */
export function hasHiddenCharacters(text: string): boolean {
  return new RegExp(HIDDEN.source, 'u').test(text) || /\x1b/.test(text) || new RegExp(CONTROL.source).test(text);
}

/**
 * Another person's text, made safe to print where an agent reads it: line breaks normalised (also the
 * Unicode line and paragraph separators), escape sequences removed, NFKC-normalised, then everything
 * hidden or controlling dropped, at most `QUOTE_MAX` characters. It is still their words: this removes
 * what a reader could not see, not instructions; the label around it says so.
 */
export function cleanQuote(text: string): string {
  const clean = text
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(ANSI, '')
    .normalize('NFKC')
    .replace(CONTROL, '')
    .replace(HIDDEN, '')
    .trim();
  return [...clean].slice(0, QUOTE_MAX).join('');
}
