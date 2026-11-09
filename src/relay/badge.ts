import type { Context } from 'hono';
import { html } from 'hono/html';
import { thanks } from '../copy/thanks.ts';
import type { Klatsch } from '../service.ts';

/**
 * The opt-in public badge: one line, "Helped N people on Klatsch", a number only (no name, no handle). An
 * image for READMEs, so it is served to anyone with its random link, while its owner shows it; any other id
 * gets the same plain 404. No script, no style, no link inside it, and its own strict headers.
 */
export function badgeRoute(klatsch: Klatsch) {
  return (c: Context) => {
    // A script or style in the image could run if someone opened it directly; the sandbox and `default-src 'none'` stop that.
    c.header('Content-Security-Policy', "default-src 'none'; sandbox");
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cross-Origin-Resource-Policy', 'cross-origin');
    const id = c.req.param('file')?.match(/^(.+)\.svg$/)?.[1];
    const count = id ? klatsch.badgeCount(id) : undefined;
    if (count === undefined) {
      c.header('Cache-Control', 'no-store');
      return c.text('Not found.', 404);
    }
    // Short, so a badge turned off disappears soon from caches that respect it.
    c.header('Cache-Control', 'public, max-age=300');
    c.header('Content-Type', 'image/svg+xml; charset=utf-8');
    return c.body(badgeSvg(count));
  };
}

/** Every value is escaped by `html`; the width follows the text, about 7 px a character at 11 px Verdana. */
export function badgeSvg(count: number): string {
  const text = thanks.badgeText(count);
  const width = 16 + Math.ceil(text.length * 6.6);
  return String(
    html`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" viewBox="0 0 ${width} 20" role="img" aria-label="${text}"><title>${text}</title><rect width="${width}" height="20" rx="4" fill="#0071E3"/><text x="${width / 2}" y="14" fill="#FFFFFF" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">${text}</text></svg>`,
  );
}
