import { DatabaseSync } from 'node:sqlite';
import { migrations } from './migrations.ts';
import { SEALED_COLUMNS, SEALED_PREFIX, type Sealer } from './sealed.ts';

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  // secure_delete: text that was replaced or removed does not linger in free pages of the file.
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  opensSealedText(db);
  migrate(db);
  return db;
}

const sealers = new WeakMap<Db, Sealer>();

/** One place for reading: any sealed value in any result comes back as its text, so no query has to know. */
function opensSealedText(db: Db): void {
  const reveal = <T>(row: T): T => {
    const sealer = sealers.get(db);
    if (!sealer || !row || typeof row !== 'object') return row;
    const fields = row as Record<string, unknown>;
    for (const name of Object.keys(fields)) {
      const value = fields[name];
      // Not a throw when it does not open: a display name can start with the prefix, and must break nobody's page.
      if (typeof value === 'string' && value.startsWith(SEALED_PREFIX)) fields[name] = sealer.open(value) ?? value;
    }
    return row;
  };
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    const statement = prepare(sql);
    const { get, all } = statement;
    statement.get = ((...args: unknown[]) => reveal((get as (...a: unknown[]) => unknown).apply(statement, args))) as typeof statement.get;
    statement.all = ((...args: unknown[]) => ((all as (...a: unknown[]) => unknown[]).apply(statement, args)).map(reveal)) as typeof statement.all;
    return statement;
  };
}

/** Sealed once the relay has its key; plain before that, and `useSealer` seals what is plain when it arrives. */
export const sealText = (db: Db, text: string): string => sealers.get(db)?.seal(text) ?? text;
/** A file, sealed when the relay has its key: a first byte says which (1 sealed, 0 plain, for a relay without one). */
export const sealBytes = (db: Db, bytes: Buffer): Buffer => {
  const sealer = sealers.get(db);
  return sealer ? Buffer.concat([Buffer.from([1]), sealer.sealBytes(bytes)]) : Buffer.concat([Buffer.from([0]), bytes]);
};
export const openBytes = (db: Db, value: Uint8Array): Buffer | undefined => {
  const buf = Buffer.from(value);
  if (buf[0] === 0) return buf.subarray(1);
  return sealers.get(db)?.openBytes(buf.subarray(1));
};
export const sealOptional = (db: Db, text: string | null | undefined): string | null => (text === null || text === undefined ? null : sealText(db, text));

/**
 * Gives the database its key: refuses a key that opens none of what is already sealed, as after a restore without
 * the server secret, instead of showing people gibberish; then seals whatever is still plain (rows from before
 * this existed), and moves the old pages out of the write-ahead log.
 */
export function useSealer(db: Db, sealer: Sealer): void {
  const prior = sealers.get(db);
  sealers.delete(db);
  const sample = db.prepare(`SELECT summary FROM sips WHERE summary LIKE '${SEALED_PREFIX}%' LIMIT 20`).all() as { summary: string }[];
  if (sample.length && !sample.some((row) => sealer.open(row.summary) !== undefined)) {
    if (prior) sealers.set(db, prior);
    throw new Error('The text in this database was sealed with another server secret. Restore the data dir\'s `secret` file from your backup (see docs/self-hosting.md); nothing was changed.');
  }
  let sealed = 0;
  transaction(db, () => {
    for (const [table, id, columns] of SEALED_COLUMNS) {
      for (const column of columns) {
        const rows = db.prepare(`SELECT ${id} AS id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL AND ${column} NOT LIKE '${SEALED_PREFIX}%'`).all() as { id: string; value: string | Uint8Array }[];
        const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${id} = ?`);
        for (const row of rows) {
          update.run(sealer.seal(typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('base64')), row.id);
          sealed++;
        }
      }
    }
  });
  sealers.set(db, sealer);
  if (sealed) {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {}
  }
}

function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let version = row.user_version; version < migrations.length; version++) {
    transaction(db, () => {
      db.exec(migrations[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
}

let savepoints = 0;
const afterCommitQueue = new WeakMap<Db, (() => void)[]>();

/** Runs `fn` once the outermost transaction commits (dropped on rollback), or now if none is open. */
export function afterCommit(db: Db, fn: () => void): void {
  if (!db.isTransaction) return fn();
  const queue = afterCommitQueue.get(db) ?? [];
  queue.push(fn);
  afterCommitQueue.set(db, queue);
}

/** Nests: inside an open transaction it uses a savepoint, so an outer step can include inner ones. */
export function transaction<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) {
    const name = `sp${++savepoints}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw error;
    }
  }
  db.exec('BEGIN IMMEDIATE');
  let result: T;
  try {
    result = fn();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    afterCommitQueue.delete(db);
    throw error;
  }
  const queued = afterCommitQueue.get(db) ?? [];
  afterCommitQueue.delete(db);
  for (const run of queued) run();
  return result;
}
