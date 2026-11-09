import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detect, type Flag } from './detect/detectors.ts';

/**
 * `klatsch issue`: a link that opens a filled-in "new issue" page on the GitHub repository of the package a fix was
 * about. Klatsch posts nothing and holds no GitHub credential: the page opens in the person's own browser, where
 * they read it and click Submit themselves, because an issue is public and cannot be taken back quietly.
 */

export interface IssueLinks {
  repo: string;
  /** Look here first: maintainers should not get the same report twice. */
  search_url: string;
  new_issue_url: string;
  flags: Flag[];
  note: string;
}

export const ISSUE_NOTE =
  "Nothing was posted. An issue is public: read the page before you click Submit, and keep out customer names, internal hosts, logs and code you may not share; no detector knows them all. Search first and comment on an existing issue if there is one. Once it is filed, its link can be the source of a solved sip.";

const NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const PACKAGE = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]{0,213}$/;
/** GitHub turns very long links away; leave room for the encoding to grow. */
const MAX_URL = 8000;
const HIDDEN = /[\p{Cf}\p{Co}\p{Cs}\p{Cn}]|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;

/** `owner/name` when both parts are plain; anything else is refused, since it ends up in a link. */
export function checkRepo(value: string): string | undefined {
  const [owner, name, extra] = value.split('/');
  return owner && name && extra === undefined && NAME.test(owner) && REPO.test(name) && name !== '.' && name !== '..' ? `${owner}/${name}` : undefined;
}

/**
 * The GitHub repository in a package's `repository` field, in the forms npm accepts. A package's metadata is written
 * by whoever published it, so only a repository on github.com itself counts, never a look-alike host.
 */
export function repoFromPackage(repository: unknown): string | undefined {
  const raw = typeof repository === 'string' ? repository : repository && typeof repository === 'object' ? (repository as { url?: unknown }).url : undefined;
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  const shorthand = text.match(/^(?:github:)?([^/:@\s]+\/[^/:@\s]+)$/)?.[1];
  const ssh = text.match(/^(?:git\+ssh:\/\/)?git@github\.com[:/]([^\s]+)$/)?.[1];
  let path = shorthand ?? ssh;
  if (!path) {
    try {
      const url = new URL(text.replace(/^git\+/, '').replace(/^git:\/\//, 'https://'));
      if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return undefined;
      path = url.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
    } catch {
      return undefined;
    }
  }
  return checkRepo(path.replace(/\.git$/, ''));
}

/** The installed copy first, so nothing is asked of anyone; else the npm registry, which learns the package's name only. */
export async function repoOfNpmPackage(name: string, dir: string, fetcher: typeof fetch = fetch): Promise<string | undefined> {
  if (!PACKAGE.test(name)) throw new Error('--package is an npm package name.');
  try {
    const found = repoFromPackage((JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8')) as { repository?: unknown }).repository);
    if (found) return found;
  } catch {}
  const response = await fetcher(`https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) return undefined;
  const text = await response.text();
  if (text.length > 5_000_000) return undefined;
  return repoFromPackage((JSON.parse(text) as { repository?: unknown }).repository);
}

export function issueLinks(repo: string, title: string, body: string): IssueLinks {
  const cleanTitle = title.trim();
  const cleanBody = body.trim();
  if (!cleanTitle || cleanTitle.length > 200 || /[\r\n]/.test(cleanTitle)) throw new Error('--title is one line of at most 200 characters.');
  if (!cleanBody) throw new Error('--body is what the maintainers should know.');
  // Words the person could not see on GitHub's page would be posted in their name.
  if (HIDDEN.test(cleanTitle) || HIDDEN.test(cleanBody)) throw new Error('The title or body holds invisible or control characters. Write it again in plain text.');
  const base = `https://github.com/${repo}/issues`;
  const new_issue_url = `${base}/new?${new URLSearchParams({ title: cleanTitle, body: cleanBody })}`;
  if (new_issue_url.length > MAX_URL) throw new Error('The body is too long for a link. Keep it short: the problem, how to reproduce it, the fix.');
  const search_url = `${base}?${new URLSearchParams({ q: `is:issue ${cleanTitle}` })}`;
  return { repo, search_url, new_issue_url, flags: detect(`${cleanTitle}\n${cleanBody}`), note: ISSUE_NOTE };
}
