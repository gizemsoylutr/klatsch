import type { Db } from '../store/db.ts';

interface SeedTag {
  slug: string;
  label: string;
  parent?: string;
  aliases?: string[];
}

// The controlled vocabulary. Free-form tags are refused so that customer or
// project names cannot become tags. New tags are added here (or, later, by
// moderation), never by an agent.
const SEED: SeedTag[] = [
  // Languages.
  { slug: 'typescript', label: 'TypeScript', aliases: ['ts'] },
  { slug: 'javascript', label: 'JavaScript', aliases: ['js', 'ecmascript'] },
  { slug: 'python', label: 'Python', aliases: ['py'] },
  { slug: 'go', label: 'Go', aliases: ['golang'] },
  { slug: 'rust', label: 'Rust' },
  { slug: 'java', label: 'Java' },
  { slug: 'kotlin', label: 'Kotlin' },
  { slug: 'csharp', label: 'C#', aliases: ['c-sharp'] },
  { slug: 'cpp', label: 'C++', aliases: ['c-plus-plus'] },
  { slug: 'ruby', label: 'Ruby' },
  { slug: 'php', label: 'PHP' },
  { slug: 'swift', label: 'Swift' },
  { slug: 'shell', label: 'Shell scripting', aliases: ['bash', 'zsh', 'powershell'] },
  { slug: 'sql', label: 'SQL' },

  // Runtimes and frameworks.
  { slug: 'nodejs', label: 'Node.js', aliases: ['node', 'node-js'] },
  { slug: 'deno', label: 'Deno' },
  { slug: 'bun', label: 'Bun' },
  { slug: 'express', label: 'Express', aliases: ['expressjs'] },
  { slug: 'nestjs', label: 'NestJS', aliases: ['nest'] },
  { slug: 'nextjs', label: 'Next.js', aliases: ['next', 'next-js'] },
  { slug: 'react', label: 'React', aliases: ['reactjs'] },
  { slug: 'vue', label: 'Vue', aliases: ['vuejs', 'nuxt'] },
  { slug: 'angular', label: 'Angular' },
  { slug: 'svelte', label: 'Svelte', aliases: ['sveltekit'] },
  { slug: 'django', label: 'Django' },
  { slug: 'flask', label: 'Flask' },
  { slug: 'fastapi', label: 'FastAPI' },
  { slug: 'rails', label: 'Ruby on Rails', aliases: ['ruby-on-rails'] },
  { slug: 'spring', label: 'Spring', aliases: ['spring-boot'] },
  { slug: 'dotnet', label: '.NET', aliases: ['asp-net', 'aspnet'] },
  { slug: 'react-native', label: 'React Native' },
  { slug: 'flutter', label: 'Flutter', aliases: ['dart'] },
  { slug: 'ios', label: 'iOS', aliases: ['swiftui'] },
  { slug: 'android', label: 'Android', aliases: ['jetpack-compose'] },
  { slug: 'css', label: 'CSS', aliases: ['tailwind', 'tailwindcss', 'styling'] },
  { slug: 'build-tools', label: 'Build tools', aliases: ['bundler', 'vite', 'webpack', 'esbuild'] },
  { slug: 'dependencies', label: 'Dependencies', aliases: ['npm', 'pip', 'package-management'] },

  // Data stores.
  { slug: 'postgres', label: 'PostgreSQL', parent: 'sql', aliases: ['postgresql', 'pg'] },
  { slug: 'mysql', label: 'MySQL', parent: 'sql', aliases: ['mariadb'] },
  { slug: 'sqlite', label: 'SQLite', parent: 'sql' },
  { slug: 'mongodb', label: 'MongoDB', aliases: ['mongo'] },
  { slug: 'redis', label: 'Redis', aliases: ['valkey'] },
  { slug: 'elasticsearch', label: 'Elasticsearch', aliases: ['opensearch'] },
  { slug: 'dynamodb', label: 'DynamoDB' },
  { slug: 'kafka', label: 'Kafka', aliases: ['event-streaming'] },
  { slug: 'orm', label: 'ORMs', aliases: ['prisma', 'drizzle', 'sqlalchemy', 'typeorm', 'hibernate'] },

  // Infrastructure and delivery.
  { slug: 'docker', label: 'Docker', aliases: ['containers'] },
  { slug: 'kubernetes', label: 'Kubernetes', aliases: ['k8s', 'helm'] },
  { slug: 'terraform', label: 'Terraform', aliases: ['opentofu', 'infrastructure-as-code', 'iac'] },
  { slug: 'aws', label: 'AWS', aliases: ['amazon-web-services'] },
  { slug: 'azure', label: 'Azure' },
  { slug: 'gcp', label: 'Google Cloud', aliases: ['google-cloud'] },
  { slug: 'serverless', label: 'Serverless', aliases: ['lambda', 'cloud-functions'] },
  { slug: 'linux', label: 'Linux' },
  { slug: 'networking', label: 'Networking', aliases: ['dns', 'tls', 'proxy', 'nginx'] },
  { slug: 'git', label: 'Git', aliases: ['version-control'] },
  { slug: 'monorepo', label: 'Monorepos', aliases: ['workspaces'] },
  { slug: 'github-actions', label: 'GitHub Actions', aliases: ['gha'] },
  { slug: 'ci-cd', label: 'CI/CD', aliases: ['ci', 'cd', 'cicd'] },

  // APIs and protocols.
  { slug: 'api-design', label: 'API design', aliases: ['rest', 'api', 'openapi'] },
  { slug: 'graphql', label: 'GraphQL' },
  { slug: 'grpc', label: 'gRPC', aliases: ['protobuf'] },
  { slug: 'websockets', label: 'WebSockets', aliases: ['websocket', 'server-sent-events', 'sse'] },
  { slug: 'webhooks', label: 'Webhooks' },

  // AI and agent tooling.
  { slug: 'llm', label: 'LLMs', aliases: ['large-language-models'] },
  { slug: 'rag', label: 'RAG', parent: 'llm', aliases: ['retrieval-augmented-generation'] },
  { slug: 'embeddings', label: 'Embeddings', parent: 'llm', aliases: ['vector-search', 'vector-database'] },
  { slug: 'prompt-engineering', label: 'Prompt engineering', parent: 'llm', aliases: ['prompts', 'prompting'] },
  { slug: 'prompt-injection', label: 'Prompt injection', parent: 'llm' },
  { slug: 'evals', label: 'Evals', parent: 'llm', aliases: ['llm-evaluation'] },
  { slug: 'fine-tuning', label: 'Fine-tuning', parent: 'llm', aliases: ['finetuning'] },
  { slug: 'mcp', label: 'Model Context Protocol', aliases: ['model-context-protocol', 'mcp-server'] },
  { slug: 'coding-agents', label: 'AI coding agents', aliases: ['ai-coding', 'claude-code', 'codex', 'copilot', 'github-copilot'] },
  { slug: 'agent-workflows', label: 'Agent workflows', aliases: ['tool-use', 'subagents', 'multi-agent'] },

  // Topics: what the problem is about, across technologies.
  { slug: 'performance', label: 'Performance', aliases: ['perf'] },
  { slug: 'security', label: 'Security', aliases: ['appsec'] },
  { slug: 'testing', label: 'Testing', aliases: ['tests', 'unit-tests'] },
  { slug: 'e2e-testing', label: 'End-to-end testing', parent: 'testing', aliases: ['end-to-end', 'playwright', 'cypress'] },
  { slug: 'oauth', label: 'OAuth', aliases: ['oauth2', 'oauth-2', 'oidc', 'openid-connect'] },
  { slug: 'pagination', label: 'Pagination', aliases: ['paging', 'server-side-paging', 'cursor-pagination', 'keyset-pagination', 'next-link'] },
  { slug: 'caching', label: 'Caching', parent: 'performance', aliases: ['cache'] },
  { slug: 'indexing', label: 'Database indexing', parent: 'performance', aliases: ['indexes', 'query-plans'] },
  { slug: 'memory-leaks', label: 'Memory leaks', parent: 'performance', aliases: ['memory'] },
  { slug: 'authentication', label: 'Authentication', parent: 'security', aliases: ['auth', 'login', 'sso'] },
  { slug: 'authorization', label: 'Authorization', parent: 'security', aliases: ['authz', 'permissions', 'roles'] },
  { slug: 'credentials', label: 'Secrets and credentials', parent: 'security', aliases: ['vault', 'api-keys', 'key-management'] },
  { slug: 'cors', label: 'CORS', parent: 'security' },
  { slug: 'deployment', label: 'Deployment', aliases: ['deploy', 'release'] },
  { slug: 'migration', label: 'Migration', aliases: ['upgrade', 'migrations'] },
  { slug: 'error-handling', label: 'Error handling', aliases: ['errors', 'exceptions'] },
  { slug: 'observability', label: 'Observability', aliases: ['logging', 'monitoring', 'tracing', 'opentelemetry'] },
  { slug: 'debugging', label: 'Debugging', aliases: ['debugger'] },
  { slug: 'concurrency', label: 'Concurrency', aliases: ['locking', 'race-condition', 'async'] },
  { slug: 'data-modeling', label: 'Data modeling', aliases: ['schema-design', 'data-model'] },
  { slug: 'rate-limiting', label: 'Rate limiting', parent: 'performance', aliases: ['throttling'] },
  { slug: 'file-upload', label: 'File upload', aliases: ['upload', 'attachments'] },
  { slug: 'background-jobs', label: 'Background jobs', aliases: ['jobs', 'queues', 'scheduling', 'cron'] },
  { slug: 'i18n', label: 'Internationalization', aliases: ['translation', 'localization', 'l10n'] },
  { slug: 'accessibility', label: 'Accessibility', aliases: ['a11y'] },
  { slug: 'refactoring', label: 'Refactoring', aliases: ['legacy-code', 'tech-debt'] },
  { slug: 'code-review', label: 'Code review', aliases: ['pull-requests'] },
  { slug: 'documentation', label: 'Documentation', aliases: ['docs'] },
  { slug: 'integration', label: 'Integration', aliases: ['interfaces', 'edi', 'etl'] },
];

/** Every name a tag answers to, without a database: for a command that runs on a person's own machine. */
export function vocabularyEntries(): { slug: string; name: string }[] {
  return SEED.flatMap((tag) => [{ slug: tag.slug, name: tag.slug }, ...(tag.aliases ?? []).map((name) => ({ slug: tag.slug, name }))]);
}

export function seedVocabulary(db: Db): void {
  const insertTag = db.prepare('INSERT OR IGNORE INTO tags (slug, label, parent) VALUES (?, ?, ?)');
  const insertAlias = db.prepare('INSERT OR IGNORE INTO tag_aliases (alias, slug) VALUES (?, ?)');
  // Parents first, so the foreign key holds.
  for (const tag of [...SEED].sort((a, b) => Number(Boolean(a.parent)) - Number(Boolean(b.parent)))) {
    insertTag.run(tag.slug, tag.label, tag.parent ?? null);
    for (const alias of tag.aliases ?? []) insertAlias.run(alias, tag.slug);
  }
}

export interface UnknownTag {
  input: string;
  suggestions: string[];
}

export function normalizeTag(input: string): string {
  return input.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

export function resolveTags(db: Db, inputs: string[]): { resolved: string[]; unknown: UnknownTag[] } {
  const bySlug = db.prepare('SELECT slug FROM tags WHERE slug = ?');
  const byAlias = db.prepare('SELECT slug FROM tag_aliases WHERE alias = ?');
  const candidates = vocabulary(db);
  const resolved = new Set<string>();
  const unknown: UnknownTag[] = [];
  for (const input of inputs) {
    const tag = normalizeTag(input);
    const hit = (bySlug.get(tag) ?? byAlias.get(tag)) as { slug: string } | undefined;
    if (hit) {
      resolved.add(hit.slug);
      continue;
    }
    // Never echo the input back: it may be a customer name.
    unknown.push({ input: `#${unknown.length + 1}`, suggestions: suggest(tag, candidates) });
  }
  return { resolved: [...resolved], unknown };
}

function vocabulary(db: Db): { slug: string; name: string }[] {
  return db.prepare('SELECT slug, slug AS name FROM tags UNION ALL SELECT slug, alias AS name FROM tag_aliases').all() as {
    slug: string;
    name: string;
  }[];
}

/** Scores vocabulary entries by shared words and spelling distance; best five slugs. */
export function suggest(tag: string, candidates: { slug: string; name: string }[]): string[] {
  const words = tag.split('-').filter((w) => w.length >= 3);
  const scores = new Map<string, number>();
  for (const { slug, name } of candidates) {
    const nameWords = name.split('-');
    let score = 0;
    for (const word of words) {
      if (nameWords.includes(word)) score += 3;
      else if (nameWords.some((n) => n.length >= 3 && (n.startsWith(word) || word.startsWith(n)))) score += 2;
    }
    const d = distance(tag, name);
    if (d <= 2) score += 4 - d;
    if (score > (scores.get(slug) ?? 0)) scores.set(slug, score);
  }
  return [...scores.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([slug]) => slug);
}

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** A tag matches itself, its parent and its children. */
export function relatedTags(db: Db, slug: string): string[] {
  const rows = db
    .prepare(
      `SELECT slug FROM tags WHERE slug = ?
       UNION SELECT parent FROM tags WHERE slug = ? AND parent IS NOT NULL
       UNION SELECT slug FROM tags WHERE parent = ?`,
    )
    .all(slug, slug, slug) as { slug: string }[];
  return rows.map((r) => r.slug);
}
