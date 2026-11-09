// A person at a real browser: their own context (their own cookie jar), signed in through a one-time
// login link. Each context watches what only a browser shows: Content-Security-Policy violations,
// the Origin it sends on form posts, and which pages it opened (for the UI coverage check).
import { appendFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { expect, type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page, type Response } from '@playwright/test';
import type { Relay } from '../e2e/harness.ts';

export const SCREENSHOTS = join(import.meta.dirname, 'screenshots');
/** One line per page a browser opened, read by global-teardown.ts. */
export const VISITED = join(import.meta.dirname, '..', '..', 'test-results', 'ui-visited.jsonl');

const REDIRECT = new Set([301, 302, 303, 307, 308]);

export interface Person {
  name: string;
  context: BrowserContext;
  page: Page;
  /** CSP violations seen by the page (the DOM event) or reported on the console. */
  violations: string[];
  /** Every form post sent: its Origin header and the status it got. */
  posts: Promise<{ path: string; origin: string | undefined; status: number }>[];
  /** Clicks a button or link and returns the response that ends the navigation (after any redirect). */
  click(target: Locator): Promise<Response>;
  /** Opens a URL in this person's browser and returns the final response. */
  open(url: string): Promise<Response>;
  /** A full-page screenshot to test/ui/screenshots/<engine>/<flow>-<step>.png. */
  shot(file: string): Promise<void>;
  /** No CSP violation, and every form post carried this relay's Origin and was not refused for it. */
  expectCleanBrowser(): Promise<void>;
}

export async function person(
  browser: Browser,
  relay: Relay,
  name: string,
  spec: string,
  loginLink?: string,
  { member = true, at = relay.base, ...options }: BrowserContextOptions & { member?: boolean; at?: string } = {},
): Promise<Person> {
  const context = await browser.newContext(options);
  const screenshots = join(SCREENSHOTS, browser.browserType().name());
  mkdirSync(screenshots, { recursive: true });
  const page = await context.newPage();
  const violations: string[] = [];
  const posts: Person['posts'] = [];

  // Bindings and init scripts are injected by the browser itself, outside the page's CSP.
  await context.exposeBinding('__klatschCsp', (_source, text: string) => void violations.push(text));
  await context.addInitScript(
    `document.addEventListener('securitypolicyviolation', (e) => window.__klatschCsp(e.violatedDirective + ' blocked ' + e.blockedURI + ' on ' + location.pathname));`,
  );
  context.on('console', (message) => {
    if (message.type() === 'error' && /content.security.policy/i.test(message.text())) violations.push(message.text());
  });
  context.on('weberror', (error) => violations.push(`page error: ${error.error().message}`));

  mkdirSync(join(VISITED, '..'), { recursive: true });
  // Pages, and what a page's own script asks for (the passkey script and its posts), at `at`.
  context.on('request', (request) => {
    if (!request.url().startsWith(at) || !(request.isNavigationRequest() || ['fetch', 'script'].includes(request.resourceType()))) return;
    const path = new URL(request.url()).pathname;
    appendFileSync(VISITED, `${JSON.stringify({ spec: basename(spec), route: `${request.method()} ${path}` })}\n`);
    if (request.method() === 'POST' && request.isNavigationRequest()) {
      posts.push(
        (async () => {
          const response = await request.response();
          return { path, origin: (await request.allHeaders()).origin, status: response?.status() ?? 0 };
        })(),
      );
    }
  });

  const finalResponse = () =>
    page.waitForResponse((r) => r.request().isNavigationRequest() && r.frame() === page.mainFrame() && !REDIRECT.has(r.status()));

  const click = async (target: Locator) => {
    const [response] = await Promise.all([finalResponse(), target.click()]);
    await page.waitForLoadState('load');
    return response;
  };
  const open = async (url: string) => {
    const [response] = await Promise.all([finalResponse(), page.goto(url)]);
    return response;
  };

  const self: Person = {
    name,
    context,
    page,
    violations,
    posts,
    click,
    open,
    shot: async (file) => void (await page.screenshot({ path: join(screenshots, file), fullPage: true })),
    async expectCleanBrowser() {
      expect(violations, `${name}: Content-Security-Policy violations`).toEqual([]);
      const sent = await Promise.all(posts);
      for (const post of sent) {
        expect(post.origin, `${name}: Origin of POST ${post.path}`).toBe(at);
        expect(post.status, `${name}: POST ${post.path} was refused`).not.toBe(403);
      }
    },
  };
  if (loginLink) {
    const signedIn = await open(loginLink);
    expect(signedIn.status()).toBe(200);
    expect(page.url()).toBe(`${at}/ui`);
    // Home greets a member; someone in no circle (`member: false`) is told they need an invite instead.
    const greeting = new RegExp(`^Hi, ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. `);
    await expect(page.getByRole('heading', { level: 1, name: member ? greeting : 'You need an invite', exact: !member })).toBeVisible();
    if (!member) await expect(page.locator('.me .name')).toHaveText(name);
  }
  return self;
}
