import { execFileSync } from 'node:child_process';
import { detect, type Flag } from './detect/detectors.ts';
import { vocabularyEntries } from './match/vocabulary.ts';

/**
 * `klatsch harvest`: candidates for solved sips from the commits a person made themselves in one repository
 * they named. It runs on their machine and has no network code: nothing leaves until they approve a sip one
 * by one on the approval page. It only reads `git log`, so it gives an agent nothing it could not already read.
 */

export interface Candidate {
  commit: string;
  date: string;
  /** The person's own commit subject. Raw material for a summary, not one: it can name a customer. */
  subject: string;
  /** Vocabulary tags seen in the subject and in the changed files' names. May be empty. */
  tags: string[];
  /** Possible identifiers in the subject, as on the approval page. */
  flags: Flag[];
}

export const HARVEST_NOTE =
  'Nothing has left this machine. These are your own commits, unfiltered: a subject can name a customer or a system that no detector knows. Pick with your human, rewrite each pick in plain words, and share it with update_card, one at a time; each needs their approval. Do not run this in a repository your human has not named.';

const SOLVED = /\b(fix(es|ed)?|bug(fix)?|hotfix|workaround|regression|resolved?|resolves|solved?|solves|root[ -]cause)\b/i;
const MAX_TAGS = 5;
export const HARVEST_LIMIT = 20;
export const HARVEST_SINCE = '180 days ago';

/** What a changed file says about its topic, beyond the words in the subject. */
const FILE_TAGS: [RegExp, string][] = [
  [/\.tsx?$/, 'typescript'],
  [/\.[cm]?js$|\.jsx$/, 'javascript'],
  [/\.py$/, 'python'],
  [/\.go$/, 'go'],
  [/\.rs$/, 'rust'],
  [/\.java$/, 'java'],
  [/\.kts?$/, 'kotlin'],
  [/\.cs$/, 'csharp'],
  [/\.(cc|cpp|hpp)$/, 'cpp'],
  [/\.rb$/, 'ruby'],
  [/\.php$/, 'php'],
  [/\.swift$/, 'swift'],
  [/\.sql$/, 'sql'],
  [/\.(sh|bash|zsh)$/, 'shell'],
  [/\.(css|scss)$/, 'css'],
  [/\.tf$/, 'terraform'],
  [/(^|\/)Dockerfile$|(^|\/)(docker-)?compose\.ya?ml$/, 'docker'],
  [/(^|\/)\.github\/workflows\//, 'github-actions'],
];

/** Vocabulary names as single words or hyphenated runs in a subject; one match per tag. */
function tagsOf(subject: string, files: string[]): string[] {
  const words = subject.toLowerCase().split(/[^a-z0-9#+.-]+/).map((word) => word.replace(/^[.-]+|[.-]+$/g, '')).filter(Boolean);
  const runs = new Set(words);
  for (let i = 0; i + 1 < words.length; i++) runs.add(`${words[i]}-${words[i + 1]}`);
  const found = new Set<string>();
  for (const { slug, name } of vocabularyEntries()) if (runs.has(name)) found.add(slug);
  for (const file of files) for (const [pattern, slug] of FILE_TAGS) if (pattern.test(file)) found.add(slug);
  return [...found].slice(0, MAX_TAGS);
}

const SINCE = /^\d{1,4} (day|week|month|year)s?( ago)?$/;

/**
 * The person's own likely fixes in `repo`, newest first, one per subject. Refuses without a git user email:
 * "mine" is what the filter rests on, and another person's commit is never a candidate.
 */
export function harvest(repo: string, options: { since?: string; limit?: number } = {}): Candidate[] {
  const since = options.since ?? HARVEST_SINCE;
  if (!SINCE.test(since)) throw new Error('--since is a span like "90 days" or "6 months".');
  const limit = options.limit ?? HARVEST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit is a number from 1 to 100.');
  const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  let email: string;
  try {
    git(['rev-parse', '--git-dir']);
  } catch {
    throw new Error('--repo must be a git repository.');
  }
  try {
    email = git(['config', 'user.email']).trim();
  } catch {
    email = '';
  }
  if (!email) throw new Error('This repository has no git user.email, so Klatsch cannot tell your commits from others.');
  const log = git(['log', '--no-merges', '--no-color', '--no-show-signature', '--fixed-strings', `--author=<${email}>`, `--since=${since}`, '--name-only', '--format=%x00%h%x1f%as%x1f%s']);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const entry of log.split('\0').slice(1)) {
    const [head = '', ...rest] = entry.split('\n');
    const [commit = '', date = '', subject = ''] = head.split('\x1f');
    if (!SOLVED.test(subject) || seen.has(subject)) continue;
    seen.add(subject);
    candidates.push({ commit, date, subject, tags: tagsOf(subject, rest.filter(Boolean)), flags: detect(subject) });
    if (candidates.length === limit) break;
  }
  return candidates;
}
