#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { createToken, mcpAddCommand, revokeTokens, verifyToken } from './auth/tokens.ts';
import { agentTokenFor, hookReminder, readAgentToken, removeAgentToken, saveAgentToken, statusLine } from './agent-token.ts';
import { hasOtherStatusLine, readJsonObject, updateSettings, withStatusLine } from './claude-settings.ts';
import { mailboxOf } from './auth/email-logins.ts';
import { createLoginLink } from './auth/web-sessions.ts';
import { CLIENT, CLIENTS, connectedClients, isClient, notIgnored, wiring, type ClientName, type Runner } from './clients.ts';
import { harvest, HARVEST_NOTE } from './harvest.ts';
import { checkRepo, issueLinks, repoOfNpmPackage } from './issue.ts';
import { checkServing, ensureDataDir, envConfig, isHosted, loadConfig, loadSecret, personalBase, type Config } from './config.ts';
import { START_LISTENING } from './copy/agent.ts';
import { runProxy } from './mcp-proxy.ts';
import { notifications } from './copy/notifications.ts';
import { loadEmbedder } from './match/semantic.ts';
import { seedVocabulary } from './match/vocabulary.ts';
import { emailFromEnv } from './notify/email.ts';
import { sendPush, vapidFromSecret } from './notify/push.ts';
import { createRelay } from './relay/app.ts';
import { Klatsch, type Notifier } from './service.ts';
import { openDb } from './store/db.ts';
import { VERSION } from './version.ts';

const USAGE = `Usage:
  klatsch up [--demo [--keep]] [--port 7417] [--data ~/.klatsch]
                                                           start the relay on 127.0.0.1;
                                                           --keep restarts the demo without resetting it
  klatsch connect --user <handle> [--demo] [--client c]    connect an agent in this directory (MCP server,
                                                           reminder hook, tool approvals; the token is never
                                                           printed). --client: claude (default), codex,
                                                           copilot-vscode or copilot-cli
  klatsch connect --url https://<relay> [--client c]       the same for a hosted relay: it shows a code you type in
                                                           your browser, where you are signed in
  klatsch connect --url https://<relay> --token - [--client c]
                                                           the same for a hosted relay, with a token from its
                                                           Tokens page, read from stdin (or KLATSCH_TOKEN); a
                                                           token typed after --token lands in shell history and ps
                                                           Add --status-line to either form for news in Claude
                                                           Code's status line (never over one you already have)
  klatsch disconnect --user <handle> [--demo] [--client c] undo connect here: remove what it added (for one client
                                                           with --client) and, once no client is left, revoke
                                                           the token
  klatsch disconnect [--client c]                          undo a hosted connect here (revoke its token on the
                                                           relay's Tokens page)
  klatsch init --user <handle> --name <name> --circle <c>  add a person and a circle they own (a hosted relay's
                                                           first member; everyone after joins by invite)
  klatsch circle public <circle> --on [--slug <name>] [--cap <n>] [--user <owner>]
                                                           turn the circle's public join link on (a random link,
                                                           or /join/<name> with --slug; --cap: most people it
                                                           takes); with --user, make the circle for that owner
                                                           first if it does not exist
  klatsch circle public <circle> --off                     turn it off: nobody new joins, members stay
  klatsch email --user <handle> <address>                  confirm an address for that person as the operator,
                                                           so they can sign in by email (no confirmation mail)
  klatsch token --user <handle> [--demo] [--data ...]      issue a new agent token
  klatsch revoke --user <handle> [--demo] [--data ...]     revoke all of a user's agent tokens
  klatsch login --user <handle> [--demo] [--data ...]      print a new web login link (valid 10 minutes)
  klatsch delete --user <handle> --yes [--data ...]        delete that person's account and everything they
                                                           shared, at once, as the privacy page promises when
                                                           they ask by email (the same as Settings, Delete account)
  klatsch harvest --repo <dir> [--since "90 days"] [--limit 20]
                                                           list your own fix commits in that one repository as
                                                           candidates for solved sips, as JSON; runs on this
                                                           machine and shares nothing
  klatsch issue (--package <npm name> | --github <owner/name>) --title <line> --body <text>
                                                           links to search that repository's issues and to a
                                                           filled-in new issue, as JSON; posts nothing: you read
                                                           the page and click Submit`;

/**
 * Local mode: print to the relay terminal and show a desktop notification.
 * Messages are fixed templates with no names, tags or summaries; the handle
 * is reduced to safe characters before it reaches the OS.
 */
const localNotifier: Notifier = (user, message) => {
  console.log(`[klatsch] @${user.handle}: ${message}`);
  const text = `@${user.handle.replace(/[^a-z0-9-]/gi, '')}: ${message}`;
  const done = () => {};
  if (process.platform === 'darwin') execFile('osascript', ['-e', `display notification ${JSON.stringify(text)} with title ${JSON.stringify(notifications.desktopTitle)}`], done);
  else if (process.platform === 'linux') execFile('notify-send', [notifications.desktopTitle, text], done);
};

/** `demo` picks each person's own host for the links in their mail (see `personalBase`). */
function open(config: Config, demo = false): { klatsch: Klatsch; secret: Buffer } {
  ensureDataDir(config.dataDir);
  const secret = loadSecret(config.dataDir);
  const db = openDb(join(config.dataDir, 'klatsch.db'));
  seedVocabulary(db);
  const email = emailFromEnv(process.env, db, (handle) => personalBase(config, demo, handle));
  // Hosted, nobody sits at the relay's terminal or desktop.
  const hosted = isHosted(config);
  // Web Push to the person's phones and browsers: the same content-free line, sent after the answer, never awaited.
  const vapid = vapidFromSecret(secret);
  const pushSubject = config.operator ? `mailto:${config.operator.email}` : config.publicUrl;
  let pushTo: (user: { id: string }, message: string) => void = () => {};
  const notify: Notifier = (user, message) => {
    if (!hosted) localNotifier(user, message);
    email?.notify(user, message);
    pushTo(user, message);
  };
  const klatsch = new Klatsch(db, config, notify, email?.confirm, email?.signIn);
  pushTo = (user, message) => {
    for (const subscription of klatsch.pushSubscriptionsOf(user.id)) {
      void sendPush(vapid, pushSubject, subscription, { title: notifications.desktopTitle, body: message, url: '/ui' }).then((outcome) => {
        // The outcome only, never who or what: enough to tell a push service that refused from one that took it.
        console.error(`klatsch: push ${outcome} (${new URL(subscription.endpoint).hostname})`);
        if (outcome === 'gone') klatsch.forgetPushSubscription(subscription.id);
      });
    }
  };
  // Every command needs the key: what people wrote is sealed in the database.
  klatsch.useSecret(secret);
  return { klatsch, secret };
}

const script = () => resolve(process.argv[1] ?? 'src/cli.ts');

/**
 * Run by `npx klatsch`: npx keeps the package in its cache (`…/_npx/<hash>/node_modules/klatsch`), which npm
 * may clear at any time, so a path into it must not end up in a client config or a printed command.
 */
const fromNpx = (): boolean => {
  try {
    return /[\\/]_npx[\\/]/.test(realpathSync(script()));
  } catch {
    return false;
  }
};

/** How client configs run this CLI: this file with node, or, from npx's cache, this exact version through npx. */
function runner(): Runner {
  return fromNpx() ? { command: 'npx', args: ['-y', `klatsch@${VERSION}`] } : { command: 'node', args: [script()] };
}

/** The command a person types to run this CLI from any directory. */
function self(): string {
  return fromNpx() ? 'npx klatsch' : `node ${script()}`;
}

/** Starts Claude Code with a first prompt that has the agent check Klatsch and start listening (`watch`). */
const startClaude = `claude "${START_LISTENING}"`;

/** A connected directory's token carries the directory in its label (resolved, so /tmp and /private/tmp agree). */
const dirLabel = (dir: string) => `dir:${realpathSync(dir)}`;

/**
 * Every label a token for this directory may carry: the resolved path, and the path as the shell spells it
 * (older connects used that), so reconnecting and disconnecting revoke them all.
 */
function dirLabels(): string[] {
  const here = process.cwd();
  const spelled = process.env.PWD && realpathSync(process.env.PWD) === realpathSync(here) ? process.env.PWD : here;
  return [...new Set([dirLabel(here), `dir:${here}`, `dir:${spelled}`])];
}

/**
 * Registers Klatsch for `client` in `dir`: the token goes to the directory's 0600 file under the data dir
 * (never printed, never on a command line, in no client config); the client gets it through a command that
 * reads that file (see clients.ts).
 */
function connectDirectory(dataDir: string, url: string, token: string, dir: string, client: ClientName, wantStatus = false): void {
  saveAgentToken(dataDir, dir, { url, token });
  const wire = wiring(runner(), dataDir, dir, url);
  CLIENT[client].add(dir, wire);
  if (wantStatus) addStatusLine(dir, wire.statusLine);
  for (const path of notIgnored(dir, client))
    console.error(`${path} is not ignored by git. It holds paths on this machine, not the token: add it to .gitignore, or to .git/info/exclude to keep it to this checkout.`);
}

/**
 * Claude Code's status line, only when asked for, and never over one the person has: a project's setting would
 * hide their own, so this one and their user settings are both checked. Disconnecting takes it out again.
 */
function addStatusLine(dir: string, command: string): void {
  const own = [join(dir, '.claude', 'settings.local.json'), join(dir, '.claude', 'settings.json'), join(homedir(), '.claude', 'settings.json')];
  const taken = own.find((path) => {
    try {
      return hasOtherStatusLine(readJsonObject(path));
    } catch {
      return true;
    }
  });
  if (taken) {
    console.error(`${taken} already sets a status line (or could not be read), so Klatsch left it alone. To add Klatsch to yours, have it run: ${command}`);
    return;
  }
  updateSettings(dir, (settings) => withStatusLine(settings, command));
}

/** `--client`, checked; claude when absent. */
function clientFlag(value: string | undefined): ClientName {
  if (value === undefined) return 'claude';
  if (!isClient(value)) throw new Error(`--client is one of ${CLIENTS.join(', ')}.`);
  return value;
}

/**
 * Undoes connect in this directory for `only`, or for every client when absent (also leftovers of one whose
 * main file is gone). The token stays while another client here still uses it.
 */
function disconnectClients(dataDir: string, only: ClientName | undefined): { removed: ClientName[]; left: ClientName[] } {
  const dir = process.cwd();
  const removed = only ? [only] : [...new Set<ClientName>(['claude', ...connectedClients(dir)])];
  // Reading each file first: one connect could not have merged into stops this before anything changes.
  for (const name of removed) CLIENT[name].connected(dir);
  for (const name of only ? [only] : CLIENTS) for (const note of CLIENT[name].remove(dir)) console.log(note);
  const left = connectedClients(dir);
  // The token file goes once no client here uses it.
  if (!left.length) removeAgentToken(dataDir, dir);
  return { removed, left };
}

const removedText = ({ removed, left }: { removed: ClientName[]; left: ClientName[] }) =>
  `removed what connect added for ${removed.join(', ')}${left.length ? `; kept the token, still used here by ${left.join(', ')}` : ' and the token file'}`;

/** Agent tokens are `klt_` and 32 random bytes in base64url. */
const TOKEN_FORMAT = /^klt_[A-Za-z0-9_-]{43}$/;

/**
 * The relay URL a hosted connect may use: an https origin, or http on a loopback name (a local relay).
 * Never echoes what it refuses back beyond the rule.
 */
function relayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('--url must be the relay address, like https://klatsch.dev');
  }
  const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !loopback) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== ''))
    throw new Error('--url must be an https origin with no path, like https://klatsch.dev');
  return url.origin;
}

/**
 * The token for a hosted connect: `--token -` reads one line from stdin (without echo at a terminal), else
 * KLATSCH_TOKEN (removed from the environment once read, so no child process inherits it). The flag form works
 * too, but the token then sits in the shell history and, while connect runs, in `ps`.
 */
async function readConnectToken(flag: string | undefined): Promise<string> {
  if (flag !== undefined && flag !== '-') {
    console.error('The token is now in your shell history and was visible in ps; next time use --token - and paste it.');
    return flag;
  }
  if (flag === undefined) {
    const token = process.env.KLATSCH_TOKEN;
    delete process.env.KLATSCH_TOKEN;
    if (token) return token;
    throw new Error('Give the token with --token - (it is read from stdin) or in KLATSCH_TOKEN.');
  }
  const { stdin } = process;
  if (stdin.isTTY) {
    process.stderr.write('Paste the token from the Tokens page: ');
    stdin.setRawMode(true);
  }
  const line = await new Promise<string>((resolve, reject) => {
    let text = '';
    const finish = (settle: () => void) => {
      stdin.off('data', onData).off('end', onEnd);
      if (stdin.isTTY) {
        stdin.setRawMode(false);
        process.stderr.write('\n');
      }
      stdin.pause();
      settle();
    };
    const onData = (chunk: Buffer) => {
      text += String(chunk);
      // Ctrl-C or Ctrl-D at a raw terminal: stop without a token.
      if (/[\u0003\u0004]/.test(text)) return finish(() => reject(new Error('No token given.')));
      const end = text.search(/[\r\n]/);
      if (end >= 0) finish(() => resolve(text.slice(0, end)));
    };
    const onEnd = () => finish(() => resolve(text));
    stdin.on('data', onData).on('end', onEnd);
  });
  return line.trim();
}

/**
 * The device flow (RFC 8628) against a hosted relay. The relay is told the client's name and nothing about this
 * machine; the code is shown here and typed there, and the token comes back only over this connection. Follows
 * no redirects, so nothing here can be sent on to another host.
 */
async function tokenFromBrowser(url: string, client: ClientName): Promise<string> {
  const call = async (path: string, body: Record<string, string>): Promise<Record<string, unknown>> => {
    const response = await fetch(`${url}/ui/connect/${path}`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (response.status === 429) throw new Error('Too many connect requests from this address. Wait ten minutes.');
    if (!response.ok) throw new Error(`${url} refused the connect request (HTTP ${response.status}). Is it a Klatsch relay of this version?`);
    return (await response.json()) as Record<string, unknown>;
  };
  const started = await call('start', { client });
  const { device_code: device, user_code: code, verification_url: page, interval_seconds: interval, expires_at: expires } = started;
  const samePlace = typeof page === 'string' && new URL(page).origin === url;
  if (typeof device !== 'string' || typeof code !== 'string' || !/^[A-Z]{4}-[A-Z]{4}$/.test(code) || !samePlace) throw new Error(`${url} gave an answer connect cannot use.`);
  console.log(`Type this code at ${page}\n\n    ${code}\n\nSign in there if you have to. Waiting for you to decide (10 minutes)…`);
  openInBrowser(page);
  const until = Math.min(Date.parse(String(expires)) || Infinity, Date.now() + 15 * 60 * 1000);
  const waitMs = (typeof interval === 'number' && interval >= 1 && interval <= 30 ? interval : 3) * 1000;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const { state, token } = await call('poll', { device_code: device });
    if (state === 'connected' && typeof token === 'string') return token;
    if (state === 'declined') throw new Error('Declined on the relay. Nothing was connected.');
    if (state === 'expired') break;
  }
  throw new Error('The code expired. Nothing was connected; run connect again.');
}

/** Connects this directory to a hosted relay with a token made on its Tokens page; no relay database is opened here. */
function connectRemote(dataDir: string, urlFlag: string, tokenFlag: string | undefined, client: ClientName, wantStatus: boolean): void {
  const url = relayUrl(urlFlag);
  // A config file connect cannot merge into stops it before anything changes.
  CLIENT[client].check(process.cwd());
  // Neither a token nor --token -: the person signs in to the relay in their browser and types a code.
  const token = tokenFlag === undefined && !process.env.KLATSCH_TOKEN ? tokenFromBrowser(url, client) : readConnectToken(tokenFlag);
  token
    .then((token) => {
      // Refused without being shown: whatever was pasted may be another secret.
      if (!TOKEN_FORMAT.test(token)) throw new Error('That is not a Klatsch agent token (they start with klt_). Copy it again from the Tokens page.');
      connectDirectory(dataDir, url, token, process.cwd(), client, wantStatus);
      console.log(`Connected ${process.cwd()} to ${url}. ${CLIENT[client].next}\nConnecting again does not revoke the earlier token: revoke it at ${url}/ui/tokens.`);
    })
    .catch((error: Error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

/**
 * Hands a sign-in link to the default browser, for a person at a terminal only, without waiting for it:
 * the relay keeps serving. True when the opener started; if it then fails, `login` prints a new link.
 */
function openInBrowser(link: string): boolean {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : undefined;
  if (!opener || !process.stdout.isTTY) return false;
  const child = spawn(opener, [link], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return child.pid !== undefined;
}

function userId(klatsch: Klatsch, handle: string): string {
  const row = klatsch.db.prepare('SELECT id FROM users WHERE handle = ?').get(handle) as { id: string } | undefined;
  if (!row) throw new Error(`No user @${handle}.`);
  return row.id;
}

/** Someone in no circle (never joined, or removed from all) gets no agent token. */
function memberId(klatsch: Klatsch, handle: string): string {
  const id = userId(klatsch, handle);
  if (!klatsch.inAnyCircle(id)) throw new Error(`@${handle} is in no circle; an agent token needs one.`);
  return id;
}

function seedDemo(klatsch: Klatsch, secret: Buffer): void {
  const alice = klatsch.ensureUser('alice', 'Alice');
  const bob = klatsch.ensureUser('bob', 'Bob');
  const circle = klatsch.ensureCircle('demo', alice);
  klatsch.addMember(circle, bob, alice);
  const solved = klatsch.draftSip(
    bob,
    {
      status: 'solved',
      tags: ['nodejs', 'postgres', 'pagination'],
      summary: 'Cursor paging in a Node.js API on Postgres: use a keyset cursor on (created_at, id) and return next_cursor instead of OFFSET.',
      visibility: 'open',
    },
    'cli',
  );
  klatsch.approveSip(bob, solved.sipId, 'cli');
  const { config } = klatsch;
  const people = [
    ['Alice', alice, '/tmp/klatsch-alice'],
    ['Bob', bob, '/tmp/klatsch-bob'],
  ] as const;
  console.log(`\nDemo circle: Bob already solved cursor-based pagination in a Postgres-backed Node.js API; Alice is stuck on it.`);
  console.log(`Alice uses ${personalBase(config, true, 'alice')} and Bob ${personalBase(config, true, 'bob')}: two hostnames, so one browser keeps both signed in, each with their own cookie.\n`);
  for (const [name, id, dir] of people) {
    const handle = name.toLowerCase();
    const url = personalBase(config, true, handle);
    const link = createLoginLink(klatsch.db, secret, id, url);
    // An opened link is used up; printing it too invites a second click on "Link expired".
    if (openInBrowser(link)) console.log(`Opened ${name}'s sign-in in your browser (new link: ${self()} login --demo --user ${handle})`);
    else console.log(`${name}'s web UI (link valid 10 minutes, works once):\n  ${link}`);
    console.log(`${name}'s Claude Code (connects to ${url}/mcp; start it from a fresh terminal):\n  mkdir -p ${dir} && cd ${dir} && ${self()} connect --demo --user ${handle} && ${startClaude}\n`);
  }
  console.log(`Then tell Alice's session: "I'm stuck on pagination in my Node.js API: OFFSET paging on Postgres gets slow and skips rows. Share it on Klatsch and look for help."`);
  console.log(`When an agent shows a code, enter it at ${personalBase(config, true, 'alice')}/ui/device (Alice) or ${personalBase(config, true, 'bob')}/ui/device (Bob).\n`);
}

function seedLocal(klatsch: Klatsch, secret: Buffer): void {
  const me = klatsch.ensureUser('me', 'Me');
  klatsch.ensureCircle('local', me);
  const { config } = klatsch;
  const hasToken = klatsch.db.prepare('SELECT 1 FROM tokens WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?').get(me, Date.now());
  if (!hasToken) {
    const { token } = createToken(klatsch.db, secret, me, { ttlDays: config.tokenTtlDays });
    console.log(`\nConnect Claude Code (token shown once, valid ${config.tokenTtlDays} days):\n  ${mcpAddCommand(config.publicUrl, token)}`);
  }
  // A login link opens a human session; print one only for a person at a terminal.
  if (process.stdout.isTTY) console.log(`\nApprove drafts and intros here:\n  ${createLoginLink(klatsch.db, secret, me, config.publicUrl)}\n`);
}

/**
 * The connected directory a helper or the proxy serves: `--dir` as connect writes it; else the project Claude
 * Code names to a plugin's stdio server (`CLAUDE_PROJECT_DIR`, in its environment, never on a command line);
 * else where it was started.
 */
const projectDir = (dir: string | undefined): string => dir ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

function main(): void {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      demo: { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
      port: { type: 'string' },
      data: { type: 'string' },
      user: { type: 'string' },
      hook: { type: 'boolean', default: false },
      dir: { type: 'string' },
      url: { type: 'string' },
      token: { type: 'string' },
      name: { type: 'string' },
      circle: { type: 'string' },
      client: { type: 'string' },
      on: { type: 'boolean', default: false },
      off: { type: 'boolean', default: false },
      slug: { type: 'string' },
      cap: { type: 'string' },
      repo: { type: 'string' },
      since: { type: 'string' },
      limit: { type: 'string' },
      package: { type: 'string' },
      github: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
      'status-line': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      version: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.version) {
    console.log(VERSION);
    return;
  }
  if (values.help) {
    console.log(USAGE);
    return;
  }
  // The environment (a container) first, flags over it.
  const base = loadConfig({ ...envConfig(process.env), ...(values.port ? { port: Number(values.port) } : {}), ...(values.data ? { dataDir: values.data } : {}) });

  switch (positionals[0]) {
    case 'issue': {
      if ((values.package === undefined) === (values.github === undefined)) throw new Error('Name the repository with --package <npm name> or --github <owner/name>.');
      const { title = '', body = '', github, package: name } = values;
      const fail = (error: Error) => {
        console.error(error.message);
        process.exitCode = 1;
      };
      void (async () => {
        const repo = github !== undefined ? checkRepo(github) : await repoOfNpmPackage(name!, process.cwd());
        if (!repo) throw new Error(github !== undefined ? '--github is owner/name.' : 'That package names no repository on github.com. Find it yourself and use --github.');
        console.log(JSON.stringify(issueLinks(repo, title, body), null, 2));
      })().catch(fail);
      return;
    }
    case 'harvest': {
      // No default: a repository is scanned only when someone names it.
      if (!values.repo) throw new Error('Name the one repository to look in: klatsch harvest --repo <dir>');
      const candidates = harvest(resolve(values.repo), {
        ...(values.since !== undefined ? { since: values.since } : {}),
        ...(values.limit !== undefined ? { limit: Number(values.limit) } : {}),
      });
      console.log(JSON.stringify({ candidates, note: HARVEST_NOTE }, null, 2));
      return;
    }
    case 'up': {
      const config = values.demo ? { ...base, dataDir: join(base.dataDir, 'demo') } : base;
      checkServing(config);
      // The demo and the local seed (a user "me", a token printed to the log) are for one person's machine.
      if (values.demo && isHosted(config)) throw new Error('--demo runs on a loopback public URL only.');
      const reset = values.demo && !values.keep;
      if (reset) for (const suffix of ['', '-wal', '-shm']) rmSync(join(config.dataDir, `klatsch.db${suffix}`), { force: true });
      const { klatsch, secret } = open(config, values.demo);
      // The operator's choice, off by default; see docs/self-hosting.md. Without the library it stays off and says so.
      if (process.env.KLATSCH_SEMANTIC === '1') {
        void loadEmbedder(join(config.dataDir, 'models')).then((embedder) => {
          klatsch.useEmbedder(embedder);
          console.error(embedder ? 'Semantic matching is on.' : 'KLATSCH_SEMANTIC=1, but @huggingface/transformers is not installed: matching by tags only.');
        });
      }
      const server = serve({ fetch: createRelay(klatsch, secret).fetch, hostname: config.host, port: config.port }, () => {
        console.log(`Klatsch relay on ${config.publicUrl}${reset ? ' (demo data, reset on every start; --keep keeps it)' : ''}`);
        if (reset) seedDemo(klatsch, secret);
        else if (values.demo) console.log(`Demo data kept. New login link: ${self()} login --demo --user <alice|bob>`);
        else if (!isHosted(config)) seedLocal(klatsch, secret);
      });
      // `docker stop`, systemd or Ctrl-C: stop taking requests, drop open ones (a waiting tool call or watch),
      // close the database so its WAL is checkpointed, and exit cleanly. Requests run synchronously against
      // the database, so none is halfway through a write when this runs.
      const stop = () => {
        server.close();
        if ('closeAllConnections' in server) server.closeAllConnections();
        klatsch.db.close();
        process.exit(0);
      };
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
      return;
    }
    case 'connect': {
      const client = clientFlag(values.client);
      const wantStatus = values['status-line'];
      if (wantStatus && client !== 'claude') throw new Error('--status-line is for Claude Code.');
      if (values.url !== undefined) {
        if (values.user || values.demo) throw new Error(USAGE);
        connectRemote(base.dataDir, values.url, values.token, client, wantStatus);
        return;
      }
      if (!values.user) throw new Error(USAGE);
      const config = values.demo ? { ...base, dataDir: join(base.dataDir, 'demo') } : base;
      // A config file connect cannot merge into stops it before anything changes.
      CLIENT[client].check(process.cwd());
      const { klatsch, secret } = open(config, values.demo);
      const id = memberId(klatsch, values.user);
      // Reconnecting a directory replaces its token instead of leaving the old one valid, also when it was another person's.
      const previous = readAgentToken(base.dataDir, process.cwd());
      const owner = previous ? verifyToken(klatsch.db, secret, previous.token)?.userId : undefined;
      for (const user of new Set([id, ...(owner ? [owner] : [])])) for (const label of dirLabels()) revokeTokens(klatsch.db, user, label);
      // Every client here reads the one token file, so the token serves them all. The Tokens page names the
      // folder by its name only; the path stays in the label, which only this machine's commands read.
      const others = connectedClients(process.cwd()).filter((name) => name !== client);
      const { token } = createToken(klatsch.db, secret, id, {
        ttlDays: values.demo ? 1 : config.tokenTtlDays,
        label: dirLabel(process.cwd()),
        agent: { clients: [client, ...others], project: basename(realpathSync(process.cwd())) },
      });
      connectDirectory(base.dataDir, personalBase(config, values.demo, values.user), token, process.cwd(), client, wantStatus);
      console.log(`Connected ${process.cwd()} as @${values.user}${others.length ? ` (also for ${others.join(', ')}, with the new token)` : ''}. ${CLIENT[client].next}`);
      return;
    }
    case 'disconnect': {
      const only = values.client === undefined ? undefined : clientFlag(values.client);
      if (!values.user) {
        // A hosted connect: this machine has no relay database, so the token can only be revoked on the relay.
        const url = readAgentToken(base.dataDir, process.cwd())?.url;
        const done = disconnectClients(base.dataDir, only);
        const revoke = done.left.length ? '' : ` Revoke the token on ${url ? `${url}/ui/tokens` : "the relay's Tokens page"}.`;
        console.log(`Disconnected ${process.cwd()}: ${removedText(done)}.${revoke}`);
        return;
      }
      const config = values.demo ? { ...base, dataDir: join(base.dataDir, 'demo') } : base;
      const { klatsch } = open(config, values.demo);
      const id = userId(klatsch, values.user);
      const done = disconnectClients(base.dataDir, only);
      let revoked = 0;
      if (!done.left.length) for (const label of dirLabels()) revoked += revokeTokens(klatsch.db, id, label);
      console.log(`Disconnected ${process.cwd()}: ${removedText(done)}${done.left.length ? '' : `, and revoked ${revoked} token(s) of @${values.user}`}.`);
      return;
    }
    case 'pending': {
      // The reminder hook connect installs, for the directory it names; not meant to be typed. Prints nothing on any error.
      if (!values.hook || !values.dir) return;
      void hookReminder(base.dataDir, values.dir).then((text) => process.stdout.write(text));
      return;
    }
    case 'status-line': {
      // The status line connect --status-line installs, for the directory it names; not meant to be typed.
      if (!values.dir) return;
      void statusLine(base.dataDir, values.dir).then((text) => process.stdout.write(text));
      return;
    }
    case 'mcp-proxy': {
      // The stdio MCP server connect registers for clients without a header helper; not meant to be typed.
      void runProxy(base.dataDir, projectDir(values.dir), process.stdin, process.stdout, values.url);
      return;
    }
    case 'token-header': {
      // The header helper (Claude Code's headersHelper, Codex's http_headers_helper) connect registered: the header,
      // as JSON, on stdout. Only for the relay `--url` names and, where Claude Code names the server it asks for,
      // only for that server: a token never goes to a relay it was not made for.
      const agent = agentTokenFor(base.dataDir, projectDir(values.dir), values.url, process.env.CLAUDE_CODE_MCP_SERVER_URL);
      process.stdout.write(JSON.stringify(agent ? { Authorization: `Bearer ${agent.token}` } : {}));
      return;
    }
    case 'init': {
      if (!values.user || !values.name || !values.circle) throw new Error(USAGE);
      const { klatsch } = open(base);
      // For the first person only: everyone after joins an existing circle by invite, never by a command.
      if (klatsch.db.prepare('SELECT 1 FROM circles WHERE name = ?').get(values.circle))
        throw new Error(`Circle ${values.circle} already exists; others join it by an invite from its Circle page.`);
      const id = klatsch.ensureUser(values.user, values.name);
      klatsch.ensureCircle(values.circle, id);
      console.log(`@${values.user} is in circle ${values.circle}. Sign in with: klatsch login --user ${values.user}`);
      return;
    }
    case 'circle': {
      // The operator's switch for a public circle (the web toggle is the owner's), e.g. a "commons" at launch.
      const name = positionals[2];
      if (positionals[1] !== 'public' || !name || values.on === values.off) throw new Error(USAGE);
      const { klatsch } = open(base);
      let circle = klatsch.db.prepare('SELECT id FROM circles WHERE name = ?').get(name) as { id: string } | undefined;
      if (!circle && values.on && values.user) circle = { id: klatsch.ensureCircle(name, userId(klatsch, values.user)) };
      if (!circle) throw new Error(`No circle ${name}.${values.on ? ' Name its owner with --user to make it.' : ''}`);
      const owner = klatsch.db.prepare(`SELECT user_id FROM memberships WHERE circle_id = ? AND role = 'owner'`).get(circle.id) as { user_id: string } | undefined;
      if (!owner) throw new Error(`Circle ${name} has no owner.`);
      const cap = values.cap === undefined ? undefined : Number(values.cap);
      const token = klatsch.setJoinLink(owner.user_id, circle.id, values.on, { ...(values.slug !== undefined ? { name: values.slug } : {}), ...(cap !== undefined ? { cap } : {}) });
      console.log(token ? `Anyone with this link can join ${name}: ${base.publicUrl}/join/${token}` : `The join link of ${name} is off. Its members stay.`);
      return;
    }
    case 'email': {
      // The operator vouches for the address (e.g. the first member, who never had a GitHub sign-in to start from).
      const address = positionals[1];
      if (!values.user || !address || positionals.length > 2) throw new Error(USAGE);
      const { klatsch, secret } = open(base);
      klatsch.useSecret(secret);
      const id = userId(klatsch, values.user);
      const owner = klatsch.db.prepare('SELECT id FROM users WHERE mailbox = ?').get(mailboxOf(address)) as { id: string } | undefined;
      if (owner && owner.id !== id) throw new Error('That address already belongs to another person here.');
      klatsch.setVerifiedEmail(id, address, 'cli');
      console.log(`@${values.user} can now sign in by email at that address.`);
      return;
    }
    case 'delete': {
      if (!values.user || !values.yes) throw new Error(USAGE);
      const { klatsch, secret } = open(base);
      klatsch.useSecret(secret);
      klatsch.deleteAccount(userId(klatsch, values.user), 'cli');
      console.log(`Deleted @${values.user} and everything they shared. Backups keep it until they roll over.`);
      return;
    }
    case 'revoke': {
      if (!values.user) throw new Error(USAGE);
      const config = values.demo ? { ...base, dataDir: join(base.dataDir, 'demo') } : base;
      const { klatsch } = open(config, values.demo);
      console.log(`Revoked ${revokeTokens(klatsch.db, userId(klatsch, values.user))} token(s) of @${values.user}.`);
      return;
    }
    case 'login':
      // A login link opens a human session. Agents usually run commands without a terminal; a person
      // runs this in one. A speed bump, not a boundary: a pseudo-terminal gets past it.
      if (!process.stdout.isTTY) {
        console.error('klatsch login prints a link for a person: run it yourself in a terminal.');
        process.exitCode = 1;
        return;
      }
    // falls through
    case 'token': {
      if (!values.user) throw new Error(USAGE);
      const config = values.demo ? { ...base, dataDir: join(base.dataDir, 'demo') } : base;
      const { klatsch, secret } = open(config, values.demo);
      const url = personalBase(config, values.demo, values.user);
      if (positionals[0] === 'token') {
        const { token } = createToken(klatsch.db, secret, memberId(klatsch, values.user), { ttlDays: config.tokenTtlDays });
        console.log(mcpAddCommand(url, token));
      } else {
        const link = createLoginLink(klatsch.db, secret, userId(klatsch, values.user), url);
        if (values.demo && openInBrowser(link)) console.log(`Opened @${values.user}'s sign-in in your browser.`);
        else console.log(link);
      }
      return;
    }
    default:
      console.log(USAGE);
  }
}

/** A mistake on the command line is one plain line, not a stack trace; `KLATSCH_DEBUG=1` shows the trace. */
function failPlainly(error: unknown): void {
  if (process.env.KLATSCH_DEBUG) console.error(error);
  else console.error(`klatsch: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

process.on('unhandledRejection', (error) => {
  failPlainly(error);
  process.exit(1);
});
try {
  main();
} catch (error) {
  failPlainly(error);
}
