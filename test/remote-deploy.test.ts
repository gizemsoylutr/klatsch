import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SCRIPT = join(import.meta.dirname, '..', 'deploy', 'remote-deploy.sh');
const REPO = 'ghcr.io/gizemsoylutr/klatsch';
const DIGEST = `sha256:${'0123456789abcdef'.repeat(4)}`;
const GOOD = `${REPO}@${DIGEST}`;
const ENV = 'KLATSCH_DOMAIN=klatsch.example\nKLATSCH_IMAGE=ghcr.io/gizemsoylutr/klatsch:latest\nLITESTREAM_BUCKET=b\n';

/**
 * The forced command in a deploy dir of its own, with a fake `docker` that logs its arguments and reports
 * the image in .env as running (or `running`, when given).
 */
function deploy(ref: string | undefined, options: { env?: string; running?: string } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'klatsch-deploy-')));
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'klatsch-docker-')));
  const log = join(bin, 'docker.log');
  copyFileSync(SCRIPT, join(dir, 'remote-deploy.sh'));
  if (options.env !== undefined) writeFileSync(join(dir, '.env'), options.env, { mode: 0o600 });
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1 $2" in
  "compose ps") echo container-id ;;
  "inspect --format") echo image-id ;;
  "image inspect") ${options.running ? `echo '${options.running}'` : `sed -n 's/^KLATSCH_IMAGE=//p' .env`} ;;
esac
`,
  );
  chmodSync(join(bin, 'docker'), 0o755);
  const env: NodeJS.ProcessEnv = { PATH: `${bin}:${process.env.PATH}` };
  if (ref !== undefined) env.SSH_ORIGINAL_COMMAND = ref;
  const run = spawnSync('sh', [join(dir, 'remote-deploy.sh')], { cwd: dir, env, encoding: 'utf8' });
  const docker = existsSync(log) ? readFileSync(log, 'utf8') : '';
  const dotenv = existsSync(join(dir, '.env')) ? readFileSync(join(dir, '.env'), 'utf8') : undefined;
  return { run, docker, dotenv, dir };
}

describe('deploy/remote-deploy.sh, the deploy key\'s forced command', () => {
  it('points .env at the image by digest, keeps the rest and its mode, and checks what runs', () => {
    const { run, docker, dotenv, dir } = deploy(GOOD, { env: ENV });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(dotenv, `KLATSCH_DOMAIN=klatsch.example\nLITESTREAM_BUCKET=b\nKLATSCH_IMAGE=${GOOD}\n`);
    assert.equal(statSync(join(dir, '.env')).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir).sort(), ['.env', 'remote-deploy.sh'], 'no temp file left');
    assert.match(docker, /^compose pull --quiet\ncompose up -d --remove-orphans\ncompose ps -q klatsch\n/);
    assert.match(run.stdout, new RegExp(`Deployed ${GOOD}`));
  });

  it('refuses anything but exactly <repository>@sha256:<64 lowercase hex>, before touching anything', () => {
    const hex = DIGEST.slice('sha256:'.length);
    const crafted = [
      undefined,
      '',
      // The multi-line bypass: a valid line followed by a second line that a line-wise check would ignore.
      `${GOOD}\nKLATSCH_DOMAIN=evil.example`,
      `${REPO}@sha256:x\n${hex}`,
      `${GOOD}\n`,
      `${GOOD}|id`,
      `${GOOD};id`,
      `${GOOD} `,
      ` ${GOOD}`,
      `${REPO}@sha256:${hex.toUpperCase()}`,
      `${REPO}@sha256:${hex.slice(1)}`,
      `${REPO}@sha256:${hex}0`,
      `ghcr.io/evil/klatsch@${DIGEST}`,
      `${REPO}x@${DIGEST}`.slice(0, GOOD.length),
      `${REPO}:latest`,
      `${REPO}@sha512:${hex}`,
      `$(id)@${DIGEST}`,
    ];
    for (const ref of crafted) {
      const { run, docker, dotenv } = deploy(ref, { env: ENV });
      assert.notEqual(run.status, 0, JSON.stringify(ref));
      assert.match(run.stderr, /Refused/);
      assert.equal(docker, '', `docker not called for ${JSON.stringify(ref)}`);
      assert.equal(dotenv, ENV, '.env unchanged');
    }
  });

  it('fails when .env has no KLATSCH_IMAGE line, or no .env at all', () => {
    const missing = deploy(GOOD, { env: 'KLATSCH_DOMAIN=klatsch.example\n' });
    assert.notEqual(missing.run.status, 0);
    assert.match(missing.run.stderr, /no KLATSCH_IMAGE line/);
    assert.equal(missing.docker, '');
    assert.notEqual(deploy(GOOD).run.status, 0);
  });

  it('fails when the running container is not the image asked for', () => {
    const { run, docker } = deploy(GOOD, { env: ENV, running: `${REPO}@sha256:${'f'.repeat(64)}` });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /not ghcr\.io/);
    assert.doesNotMatch(docker, /image prune/);
  });
});
