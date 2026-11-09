import type { Operator } from './copy/legal.ts';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface Config {
  dataDir: string;
  host: string;
  port: number;
  /** Canonical URL of this relay; agent tokens are bound to it. */
  publicUrl: string;
  lookingTtlDays: number;
  tokenTtlDays: number;
  /** How long a tool call waits for the human to decide an approval opened from a dialog. */
  approvalWaitMs: number;
  /** How long after an accepted intro each person can read (and send to their agent) the other's sip. */
  connectedTextHours: number;
  /** "Sign in with GitHub", when the relay has a GitHub OAuth App; without it, only login links sign in. */
  github?: GitHub;
  /** "Sign in with Google", when the relay has a Google OAuth client. */
  google?: Google;
  /** Who runs this relay, for its privacy and terms pages. Without it those pages do not exist. */
  operator?: Operator;
}

export interface Google {
  clientId: string;
  clientSecret: string;
  /** Where people sign in and codes are exchanged, and who may issue the ID token. Only tests point these elsewhere. */
  authorize: string;
  token: string;
  issuers: string[];
}

export const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export interface GitHub {
  clientId: string;
  clientSecret: string;
  /** Where people authorize and codes are exchanged, and the REST API. Only tests point these elsewhere, never a hosted relay. */
  web: string;
  api: string;
}

export const GITHUB_WEB = 'https://github.com';
export const GITHUB_API = 'https://api.github.com';

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const host = overrides.host ?? '127.0.0.1';
  const port = overrides.port ?? 7417;
  return {
    dataDir: overrides.dataDir ?? join(homedir(), '.klatsch'),
    host,
    port,
    publicUrl: overrides.publicUrl ?? `http://${host}:${port}`,
    lookingTtlDays: overrides.lookingTtlDays ?? 14,
    tokenTtlDays: overrides.tokenTtlDays ?? 7,
    approvalWaitMs: overrides.approvalWaitMs ?? 120_000,
    connectedTextHours: overrides.connectedTextHours ?? 24,
    ...(overrides.github ? { github: overrides.github } : {}),
    ...(overrides.google ? { google: overrides.google } : {}),
    ...(overrides.operator ? { operator: overrides.operator } : {}),
  };
}

const LOOPBACK_NAMES = ['127.0.0.1', 'localhost'];
const LOOPBACK_BINDS = [...LOOPBACK_NAMES, '::1'];

/**
 * Settings for a relay in a container, where flags are awkward: `KLATSCH_PUBLIC_URL`, `KLATSCH_HOST`,
 * `KLATSCH_PORT`, `KLATSCH_DATA_DIR`, and the GitHub OAuth App (`KLATSCH_GITHUB_CLIENT_ID` with
 * `KLATSCH_GITHUB_CLIENT_SECRET`, or `KLATSCH_GITHUB_CLIENT_SECRET_FILE` for a Docker secret). Unset or
 * empty variables are left to the defaults (or the flags).
 */
export function envConfig(env: NodeJS.ProcessEnv): Partial<Config> {
  const pick = (name: string) => (env[name] ? env[name] : undefined);
  const port = pick('KLATSCH_PORT');
  const github = githubFromEnv(pick('KLATSCH_GITHUB_CLIENT_ID'), pick('KLATSCH_GITHUB_CLIENT_SECRET'), pick('KLATSCH_GITHUB_CLIENT_SECRET_FILE'));
  const google = googleFromEnv(pick('KLATSCH_GOOGLE_CLIENT_ID'), pick('KLATSCH_GOOGLE_CLIENT_SECRET'), pick('KLATSCH_GOOGLE_CLIENT_SECRET_FILE'));
  const name = pick('KLATSCH_OPERATOR_NAME');
  const email = pick('KLATSCH_OPERATOR_EMAIL');
  const processors = pick('KLATSCH_OPERATOR_PROCESSORS');
  if ((name || email || processors) && !(name && email && processors)) throw new Error('The privacy and terms pages need KLATSCH_OPERATOR_NAME, KLATSCH_OPERATOR_EMAIL and KLATSCH_OPERATOR_PROCESSORS, or none of them.');
  return {
    ...(name && email && processors ? { operator: { name, email, processors } } : {}),
    ...(pick('KLATSCH_PUBLIC_URL') ? { publicUrl: pick('KLATSCH_PUBLIC_URL') } : {}),
    ...(pick('KLATSCH_HOST') ? { host: pick('KLATSCH_HOST') } : {}),
    ...(port ? { port: Number(port) } : {}),
    ...(pick('KLATSCH_DATA_DIR') ? { dataDir: pick('KLATSCH_DATA_DIR') } : {}),
    ...(github ? { github } : {}),
    ...(google ? { google } : {}),
  };
}

/** Both the id and one secret, or nothing. Errors name the variables, never their values. */
function googleFromEnv(clientId: string | undefined, secret: string | undefined, secretFile: string | undefined): Google | undefined {
  if (secret && secretFile) throw new Error('Set KLATSCH_GOOGLE_CLIENT_SECRET or KLATSCH_GOOGLE_CLIENT_SECRET_FILE, not both.');
  let clientSecret = secret;
  if (secretFile) {
    try {
      clientSecret = readFileSync(secretFile, 'utf8').trim();
    } catch {
      throw new Error('KLATSCH_GOOGLE_CLIENT_SECRET_FILE cannot be read.');
    }
  }
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) throw new Error('Google sign-in needs both KLATSCH_GOOGLE_CLIENT_ID and a client secret, or neither.');
  return { clientId, clientSecret, authorize: GOOGLE_AUTHORIZE, token: GOOGLE_TOKEN, issuers: GOOGLE_ISSUERS };
}

/** Both the id and one secret, or nothing. Errors name the variables, never their values. */
function githubFromEnv(clientId: string | undefined, secret: string | undefined, secretFile: string | undefined): GitHub | undefined {
  if (secret && secretFile) throw new Error('Set KLATSCH_GITHUB_CLIENT_SECRET or KLATSCH_GITHUB_CLIENT_SECRET_FILE, not both.');
  let clientSecret = secret;
  if (secretFile) {
    try {
      clientSecret = readFileSync(secretFile, 'utf8').trim();
    } catch {
      throw new Error('KLATSCH_GITHUB_CLIENT_SECRET_FILE cannot be read.');
    }
  }
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) throw new Error('GitHub sign-in needs both KLATSCH_GITHUB_CLIENT_ID and a client secret, or neither.');
  return { clientId, clientSecret, web: GITHUB_WEB, api: GITHUB_API };
}

/** Hosted: the public URL is not on a loopback name, so only `publicUrl` counts and nothing local-only applies. */
export const isHosted = (config: Config): boolean => !LOOPBACK_NAMES.includes(new URL(config.publicUrl).hostname);

/**
 * Refuses a relay that would start but not work, or work unsafely. Hosted, behind a proxy such as Caddy:
 * an https origin with no path (agent tokens are bound to `<publicUrl>/mcp`), bound to a non-loopback
 * address so the proxy can reach it, with the public host as the only allowed Host and Origin. Local:
 * bound to loopback only, never reachable from the network.
 */
export function checkServing(config: Config): void {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('The port must be a number from 1 to 65535.');
  let url: URL;
  try {
    url = new URL(config.publicUrl);
  } catch {
    throw new Error('KLATSCH_PUBLIC_URL is not a URL.');
  }
  const loopbackBind = LOOPBACK_BINDS.includes(config.host);
  if (!isHosted(config)) {
    if (!loopbackBind) throw new Error(`A relay with a loopback public URL binds to loopback only, not ${config.host}.`);
    return;
  }
  if (url.protocol !== 'https:') throw new Error('A hosted relay needs an https public URL (TLS ends at the proxy in front of it).');
  if (url.origin !== config.publicUrl) throw new Error(`The public URL must be an origin only, like ${url.origin}.`);
  if (loopbackBind) throw new Error('A hosted relay binds to a non-loopback address (0.0.0.0 in a container) so its proxy can reach it.');
  // GitHub stand-ins are for tests on loopback; a hosted relay talks to GitHub itself.
  if (config.github && (config.github.web !== GITHUB_WEB || config.github.api !== GITHUB_API)) throw new Error('A hosted relay signs in with github.com only.');
  if (config.google && (config.google.authorize !== GOOGLE_AUTHORIZE || config.google.token !== GOOGLE_TOKEN)) throw new Error('A hosted relay signs in with Google itself only.');
}

/**
 * The origins this relay answers as itself. Hosted: only `publicUrl`. Local (`publicUrl` on a loopback
 * name): the same port on both 127.0.0.1 and localhost, so two people can share one browser on one
 * machine, each with their own cookie. Nothing else: not `::1`, not another port.
 */
export function relayOrigins(config: Config): string[] {
  const url = new URL(config.publicUrl);
  if (url.protocol !== 'http:' || !LOOPBACK_NAMES.includes(url.hostname)) return [url.origin];
  return LOOPBACK_NAMES.map((name) => `http://${name}${url.port ? `:${url.port}` : ''}`);
}

/** The base for links answering a request that came in on `host`: that host when it is one of the relay's own origins, else `publicUrl`. */
export function baseFor(config: Config, host: string | undefined): string {
  const origins = relayOrigins(config);
  return origins.length > 1 && origins.includes(`http://${host}`) ? `http://${host}` : config.publicUrl;
}

/**
 * The base URL a person's links and agent use. In the demo Alice uses 127.0.0.1 and Bob localhost: two
 * origins, so one browser keeps both signed in with separate cookies, and the links each one gets (built
 * from the host they come in on) open in the right session. Outside the demo, always `publicUrl`.
 */
export function personalBase(config: Config, demo: boolean, handle: string): string {
  const [ip, name] = relayOrigins(config);
  if (!demo || !name) return config.publicUrl;
  return handle === 'bob' ? name : ip!;
}

export function ensureDataDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** The server secret keys every stored token hash; it never leaves the data dir. */
export function loadSecret(dir: string): Buffer {
  const path = join(dir, 'secret');
  if (!existsSync(path)) writeFileSync(path, randomBytes(32), { mode: 0o600 });
  return readFileSync(path);
}
