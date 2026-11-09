// What people wrote never lies readable in the database file, the copy Litestream sends to object storage; and the
// relay, with its secret, reads it as before. Read here as bytes on disk, past everything the code does for reading.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openApproval } from '../src/auth/approvals.ts';
import { loadConfig } from '../src/config.ts';
import { seedVocabulary } from '../src/match/vocabulary.ts';
import { Klatsch } from '../src/service.ts';
import { openDb } from '../src/store/db.ts';
import { SEALED_PREFIX, sealerFrom } from '../src/store/sealed.ts';

const TEXT = 'Keyset paging fixed the customer-acme outage on db.acme.internal';
const URL_TEXT = 'https://example.com/posts/secret-paging-fix';
const QUOTE = 'A quote nobody has read yet about keyset paging';

function relay(dir: string, secret?: Buffer) {
  const db = openDb(join(dir, 'klatsch.db'));
  seedVocabulary(db);
  const klatsch = new Klatsch(db, loadConfig({ dataDir: dir }), () => {});
  if (secret) klatsch.useSecret(secret);
  return { db, klatsch };
}
/** Every byte the relay has on disk: the database, its log, its index. */
const onDisk = (dir: string) => Buffer.concat(readdirSync(dir).filter((f) => f.startsWith('klatsch.db')).map((f) => readFileSync(join(dir, f)))).toString('latin1');
const people = (r: ReturnType<typeof relay>) => {
  const alice = r.klatsch.ensureUser('alice', 'Alice');
  const bob = r.klatsch.ensureUser('bob', 'Bob');
  r.klatsch.addMember(r.klatsch.ensureCircle('demo', alice), bob, alice);
  return { alice, bob };
};
const note = (r: ReturnType<typeof relay>, user: string) => {
  const d = r.klatsch.draftSip(user, { status: 'solved', tags: ['pagination'], summary: TEXT, visibility: 'open', source: { url: URL_TEXT, title: 'Paging post title' } }, 'cli');
  r.klatsch.approveSip(user, d.sipId, 'cli', 'open');
  return d.sipId;
};

describe('sealed text', () => {
  it('seals with a fresh nonce; another key, or a changed byte, opens nothing', () => {
    const a = sealerFrom(randomBytes(32));
    const one = a.seal('x');
    assert.notEqual(one, a.seal('x'));
    assert.equal(a.open(one), 'x');
    assert.equal(sealerFrom(randomBytes(32)).open(one), undefined);
    assert.equal(a.open(`${one.slice(0, -2)}AA`), undefined);
    assert.equal(a.open(`${SEALED_PREFIX}short`), undefined);
    assert.equal(a.open('plain'), undefined);
  });

  it('new text is not readable in the files on disk, and the relay reads it as before', () => {
    const dir = mkdtempSync(join(tmpdir(), 'klatsch-sealed-'));
    const r = relay(dir, randomBytes(32));
    const { alice, bob } = people(r);
    const sipId = note(r, bob);
    r.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const bytes = onDisk(dir);
    for (const words of [TEXT, 'customer-acme', 'db.acme.internal', URL_TEXT, 'Paging post title']) assert.ok(!bytes.includes(words), words);
    const own = r.db.prepare('SELECT summary, flags, source_url FROM sips WHERE id = ?').get(sipId) as { summary: string; flags: string; source_url: string };
    assert.equal(own.summary, TEXT);
    assert.equal(own.source_url, URL_TEXT);
    assert.deepEqual(JSON.parse(own.flags).map((f: { kind: string }) => f.kind).includes('hostname'), true);
    assert.equal(r.klatsch.sipsOf(bob)[0]?.summary, TEXT);
    const looking = r.klatsch.draftSip(alice, { status: 'looking', tags: ['pagination'], summary: 'Stuck on paging.' }, 'cli');
    r.klatsch.approveSip(alice, looking.sipId, 'cli');
    assert.equal(r.klatsch.visibleNotes(alice)[0]?.summary, TEXT);
    r.db.close();
  });

  it('the columns themselves hold only sealed values, also a quote waiting and an approval waiting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'klatsch-sealed-'));
    const secret = randomBytes(32);
    const r = relay(dir, secret);
    const { alice, bob } = people(r);
    const sipId = note(r, bob);
    r.db.prepare(`INSERT INTO handoffs (id, user_id, from_user_id, sip_id, text, created_at) VALUES ('q1', ?, ?, ?, ?, 1)`).run(alice, bob, sipId, sealerFrom(secret).seal(QUOTE));
    openApproval(r.db, secret, alice, 'share_sip', { summary: 'An approval waiting about paging' }, 3);
    r.db.close();
    const raw = new DatabaseSync(join(dir, 'klatsch.db'));
    const sip = raw.prepare('SELECT summary, flags, source_url, source_title FROM sips').get() as Record<string, string>;
    for (const value of Object.values(sip)) assert.ok(value.startsWith(SEALED_PREFIX));
    assert.ok((raw.prepare('SELECT payload FROM approvals').get() as { payload: string }).payload.startsWith(SEALED_PREFIX));
    raw.close();
  });

  it('text from before is sealed at the next start, with nothing left behind in the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'klatsch-sealed-'));
    const before = relay(dir);
    const { bob } = people(before);
    const sipId = note(before, bob);
    before.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    assert.ok(onDisk(dir).includes(TEXT), 'plain before the key arrives');
    before.db.close();
    const after = relay(dir, randomBytes(32));
    assert.ok(!onDisk(dir).includes(TEXT), 'gone from every file');
    assert.ok(!onDisk(dir).includes(URL_TEXT));
    assert.equal((after.db.prepare('SELECT summary FROM sips WHERE id = ?').get(sipId) as { summary: string }).summary, TEXT);
    after.db.close();
  });

  it('a restore without the server secret refuses to start, says what to do, and changes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'klatsch-sealed-'));
    const secret = randomBytes(32);
    const first = relay(dir, secret);
    note(first, people(first).bob);
    first.db.close();
    const db = openDb(join(dir, 'klatsch.db'));
    const klatsch = new Klatsch(db, loadConfig({ dataDir: dir }), () => {});
    assert.throws(() => klatsch.useSecret(randomBytes(32)), /sealed with another server secret/);
    klatsch.useSecret(secret);
    assert.equal(klatsch.sipsOf((db.prepare(`SELECT id FROM users WHERE handle = 'bob'`).get() as { id: string }).id)[0]?.summary, TEXT);
    db.close();
  });

  it('a name that looks sealed breaks nobody’s page: it stays as written', () => {
    const r = relay(mkdtempSync(join(tmpdir(), 'klatsch-sealed-')), randomBytes(32));
    const id = r.klatsch.ensureUser('mallory', `${SEALED_PREFIX}AAAA`);
    assert.equal(r.klatsch.user(id).display_name, `${SEALED_PREFIX}AAAA`);
    r.db.close();
  });

  it('the same ask while open still reuses its approval, though sealed values never compare equal', () => {
    const secret = randomBytes(32);
    const r = relay(mkdtempSync(join(tmpdir(), 'klatsch-sealed-')), secret);
    const { alice } = people(r);
    const payload = { summary: 'Same ask' };
    const one = openApproval(r.db, secret, alice, 'share_sip', payload, 3);
    const two = openApproval(r.db, secret, alice, 'share_sip', payload, 3);
    assert.equal(one?.approval.id, two?.approval.id);
    assert.deepEqual(two?.approval.payload, payload);
    assert.notEqual(openApproval(r.db, secret, alice, 'share_sip', { summary: 'Other ask' }, 3)?.approval.id, one?.approval.id);
    r.db.close();
  });
});
