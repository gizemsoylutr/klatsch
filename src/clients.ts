import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { HOOK_MARK, STATUS_MARK, hasKlatschHook, readJsonObject, readSettings, settingsPath, updateJsonFile, updateSettings, withKlatsch, withKlatschHook, withoutKlatsch, withoutKlatschHook } from './claude-settings.ts';
import { codexConfigPath, codexHooksPath, hasKlatschToml, readToml, updateToml, withKlatschToml, withoutKlatschToml } from './codex-config.ts';
import { START_LISTENING } from './copy/agent.ts';
import {
  copilotLocation,
  copilotMcpPath,
  copilotPermissionsPath,
  hasCopilotServer,
  hasVscodeServer,
  legacyCopilotPermissionsPath,
  vscodeMcpPath,
  withCopilotApprovals,
  withCopilotServer,
  withoutCopilotApprovals,
  withoutCopilotServer,
  withoutVscodeServer,
  withVscodeServer,
} from './copilot-config.ts';

/**
 * The agents `klatsch connect --client` sets up. All of them use the same per-directory token file; what
 * differs is how the client gets the token (a header helper, or the `mcp-proxy` stdio server where the
 * client has none), whether it can run the reminder hook, and how its tools are pre-approved.
 */
export const CLIENTS = ['claude', 'codex', 'copilot-vscode', 'copilot-cli'] as const;
export type ClientName = (typeof CLIENTS)[number];

export const isClient = (value: string): value is ClientName => (CLIENTS as readonly string[]).includes(value);

const quote = (arg: string) => `'${arg.replace(/'/g, `'\\''`)}'`;

/** How a client config runs this CLI for one connected directory; never the token. */
export interface Wiring {
  url: string;
  /** Shell command printing `{"Authorization": "Bearer …"}` from the token file. */
  headerHelper: string;
  /** Shell command for the UserPromptSubmit hook. */
  hook: string;
  /** Shell command for the optional Claude Code status line. */
  statusLine: string;
  /** argv of the stdio proxy. */
  proxy: { command: string; args: string[] };
}

/** How to run this CLI: `node <script>` from a checkout or an install, `npx -y klatsch@<version>` from npx's cache. */
export interface Runner {
  command: string;
  args: string[];
}

/** A runner as a shell command line: the script path quoted, npx's plain words as they are. */
export const shellCommand = (cli: Runner): string => (cli.command === 'npx' ? ['npx', ...cli.args] : [cli.command, ...cli.args.map(quote)]).join(' ');

/**
 * The commands a client config runs for one connected directory. `--url` names the relay, so the helper and
 * the proxy hand the token only to that relay. `node` from PATH, as in the printed commands: an absolute path
 * to one Node version breaks on its next upgrade.
 */
export function wiring(cli: Runner, dataDir: string, dir: string, url: string): Wiring {
  const at = realpathSync(dir);
  const run = shellCommand(cli);
  const tail = `--data ${quote(dataDir)} --dir ${quote(at)}`;
  return {
    url,
    headerHelper: `${run} token-header --url ${quote(url)} ${tail}`,
    hook: `${run}${HOOK_MARK} ${tail}`,
    statusLine: `${run}${STATUS_MARK}${tail}`,
    proxy: { command: cli.command, args: [...cli.args, 'mcp-proxy', '--url', url, '--data', dataDir, '--dir', at] },
  };
}

interface Client {
  /** Throws, naming the file, when connect could not merge into it; called before anything changes. */
  check(dir: string): void;
  add(dir: string, wire: Wiring): void;
  /** Removes what connect added, also leftovers (one file already gone); returns notes for the person. */
  remove(dir: string): string[];
  connected(dir: string): boolean;
  /** The files connect writes in the directory, which should stay out of git. */
  files(dir: string): string[];
  /** What the person does next, after "Connected <dir>". */
  next: string;
}

/**
 * Takes Klatsch's entry out of a JSON file, if the file exists: disconnecting never creates one. A file that
 * is no longer plain JSON (comments added later) is left alone when it has nothing of ours (`mark`), and
 * refused, naming it, when it still has.
 */
function clean(path: string, change: Parameters<typeof updateJsonFile>[1], mark: string, drop?: 'file' | 'folder'): void {
  if (!existsSync(path)) return;
  try {
    readJsonObject(path);
  } catch {
    if (!readFileSync(path, 'utf8').includes(mark)) return;
    throw new Error(`${path} still has what klatsch connect added, but is no longer plain JSON (comments or trailing commas?): remove the klatsch entry by hand, then run this again.`);
  }
  updateJsonFile(path, change, drop);
}

const claude: Client = {
  check: (dir) => void withKlatsch(readSettings(dir), HOOK_MARK),
  add(dir, wire) {
    try {
      execFileSync('claude', ['mcp', 'remove', 'klatsch', '-s', 'local'], { cwd: dir, stdio: 'ignore' });
    } catch {}
    const server = { type: 'http', url: `${wire.url}/mcp`, headersHelper: wire.headerHelper };
    execFileSync('claude', ['mcp', 'add-json', '--scope', 'local', 'klatsch', JSON.stringify(server)], { cwd: dir, stdio: 'ignore' });
    updateSettings(dir, (settings) => withKlatsch(settings, wire.hook));
  },
  remove(dir) {
    try {
      execFileSync('claude', ['mcp', 'remove', 'klatsch', '-s', 'local'], { cwd: dir, stdio: 'ignore' });
    } catch {}
    clean(settingsPath(dir), withoutKlatsch, HOOK_MARK);
    return [];
  },
  connected: (dir) => hasKlatschHook(readSettings(dir)),
  files: () => [],
  next: `Start Claude Code here listening for Klatsch news: claude "${START_LISTENING}"\n(plain claude, or claude --continue, works too; it listens once Klatsch comes up).`,
};

const codex: Client = {
  check(dir) {
    try {
      withKlatschToml(readToml(codexConfigPath(dir)), '', '');
    } catch (error) {
      throw new Error(`${codexConfigPath(dir)} ${(error as Error).message} Fix it, then run this again.`);
    }
    withKlatschHook(readJsonObject(codexHooksPath(dir)), HOOK_MARK);
  },
  add(dir, wire) {
    updateToml(codexConfigPath(dir), (toml) => withKlatschToml(toml, `${wire.url}/mcp`, wire.headerHelper));
    updateJsonFile(codexHooksPath(dir), (hooks) => withKlatschHook(hooks, wire.hook));
  },
  remove(dir) {
    if (existsSync(codexConfigPath(dir))) updateToml(codexConfigPath(dir), withoutKlatschToml);
    clean(codexHooksPath(dir), withoutKlatschHook, HOOK_MARK, 'folder');
    return [];
  },
  connected: (dir) => hasKlatschToml(readToml(codexConfigPath(dir))),
  files: (dir) => [codexConfigPath(dir), codexHooksPath(dir)],
  next: 'Start Codex here (codex), trust the project when asked, and run /hooks to trust the Klatsch hook. .codex/ holds no token, only paths on this machine: keep it out of git.',
};

/** What marks the proxy server entry as ours in a file that is no longer plain JSON. */
const PROXY_MARK = 'mcp-proxy';

/** VS Code's mcp.json may be JSONC; connect only merges plain JSON and says so instead of rewriting comments away. */
function readVscode(dir: string) {
  try {
    return readJsonObject(vscodeMcpPath(dir));
  } catch {
    throw new Error(
      `${vscodeMcpPath(dir)} is not plain JSON (comments or trailing commas?): klatsch connect does not rewrite it. Remove them, or add the klatsch server by hand (README, "Works with").`,
    );
  }
}

const copilotVscode: Client = {
  check: (dir) => void withVscodeServer(readVscode(dir), { command: '', args: [] }),
  add: (dir, wire) => updateJsonFile(vscodeMcpPath(dir), (json) => withVscodeServer(json, wire.proxy)),
  remove(dir) {
    clean(vscodeMcpPath(dir), withoutVscodeServer, PROXY_MARK, 'folder');
    return [];
  },
  connected: (dir) => hasVscodeServer(readJsonObject(vscodeMcpPath(dir))),
  files: (dir) => [vscodeMcpPath(dir)],
  next: 'Open this folder in VS Code, start the klatsch server from .vscode/mcp.json when asked, and choose "Always allow" for the Klatsch tools at the first confirmation. .vscode/mcp.json holds no token, only paths on this machine: keep it out of git.',
};

/** The saved approvals, unless only the older extensionless file exists: a new file would hide everything saved in it. */
function permissionsWritable(): boolean {
  return existsSync(copilotPermissionsPath()) || !existsSync(legacyCopilotPermissionsPath());
}

const copilotCli: Client = {
  check(dir) {
    withCopilotServer(readJsonObject(copilotMcpPath(dir)), { command: '', args: [] });
    if (permissionsWritable()) withCopilotApprovals(readJsonObject(copilotPermissionsPath()), copilotLocation(dir));
  },
  add(dir, wire) {
    updateJsonFile(copilotMcpPath(dir), (json) => withCopilotServer(json, wire.proxy));
    if (permissionsWritable()) updateJsonFile(copilotPermissionsPath(), (json) => withCopilotApprovals(json, copilotLocation(dir)));
    else console.error(`Not pre-approving the Klatsch tools: ${legacyCopilotPermissionsPath()} is in the older format. Approve them for this folder at the first prompt.`);
  },
  remove(dir) {
    clean(copilotMcpPath(dir), withoutCopilotServer, PROXY_MARK, 'file');
    // Approvals are saved per repository: connected below its root, other connected folders there may use them.
    const location = copilotLocation(dir);
    const path = copilotPermissionsPath();
    if (location === realpathSync(dir)) {
      clean(path, (json) => withoutCopilotApprovals(json, location), 'klatsch', 'file');
      return [];
    }
    let saved: Record<string, unknown> = {};
    try {
      saved = readJsonObject(path);
    } catch {}
    if (JSON.stringify(withoutCopilotApprovals(saved, location)) === JSON.stringify(saved)) return [];
    return [`Kept the Klatsch tool approvals for ${location} in ${path}: they cover the whole repository, where other folders may be connected. Remove the klatsch entries under that location by hand when none is.`];
  },
  connected: (dir) => hasCopilotServer(readJsonObject(copilotMcpPath(dir))),
  files: (dir) => [copilotMcpPath(dir)],
  next: 'Start the Copilot CLI here (copilot) and trust the folder when asked: it loads .mcp.json only in trusted folders. The Klatsch tools are approved for the whole repository (Copilot saves approvals per repository). .mcp.json holds no token, only paths on this machine: keep it out of git.',
};

/**
 * The files connect wrote in `dir` that git would pick up: they hold paths on this machine (never the token).
 * Empty outside a repository or without git.
 */
export function notIgnored(dir: string, client: ClientName): string[] {
  return CLIENT[client].files(dir).filter((path) => existsSync(path) && spawnSync('git', ['check-ignore', '-q', path], { cwd: dir, stdio: 'ignore' }).status === 1);
}

export const CLIENT: Record<ClientName, Client> = { claude, codex, 'copilot-vscode': copilotVscode, 'copilot-cli': copilotCli };

/** The clients connected in `dir`; a file connect could not have written (not plain JSON) counts as not connected. */
export const connectedClients = (dir: string): ClientName[] =>
  CLIENTS.filter((name) => {
    try {
      return CLIENT[name].connected(dir);
    } catch {
      return false;
    }
  });
