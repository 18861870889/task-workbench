import { open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync, constants } from 'node:sqlite';

// Offline only: read two SQL/SQLite snapshots, without calling Cloudflare, running
// Wrangler, or changing either input. SQL dumps execute in an isolated in-memory
// database with ATTACH/DETACH and filesystem-related PRAGMAs disabled.
//
// node scripts/verify-migration.mjs old-account.sql new-account.sql
// node scripts/verify-migration.mjs verification.sqlite new-account.sql --new-origin-reset
//
// The optional flag verifies the exact new-origin security reset documented below.
// Run it before logging in to the new site, so its sessions table is still empty.
const BUSINESS_TABLES = ['tasks', 'activities', 'attachments', 'taxonomies', 'task_taxonomies', 'settings', 'notifications'];
const SECURITY_TABLES = ['sessions', 'push_subscriptions', 'login_attempts'];
const NEW_NULL_COLUMNS = { tasks: new Set(['deleted_at']), attachments: new Set(['storage_key']) };
const CANCELLED_ON_MIGRATION = '账号迁移：旧设备订阅已停用，请在新地址重新开启提醒';
const PENDING_STATUSES = new Set(['pending', 'retry', 'processing']);

class VerificationError extends Error {}
function requireValue(condition, message) {
  if (!condition) throw new VerificationError(message);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function snapshot(path) {
  const handle = await open(path, 'r');
  let sqlite;
  try {
    const header = Buffer.alloc(16);
    await handle.read(header, 0, header.length, 0);
    sqlite = header.equals(Buffer.from('SQLite format 3\0'));
  } finally { await handle.close(); }
  if (sqlite) return new DatabaseSync(path, { readOnly: true, allowExtension: false });
  const database = new DatabaseSync(':memory:', { allowExtension: false });
  try {
    database.setAuthorizer((operation, argument) => {
      if (operation === constants.SQLITE_ATTACH || operation === constants.SQLITE_DETACH) return constants.SQLITE_DENY;
      if (operation === constants.SQLITE_PRAGMA && !['foreign_keys', 'defer_foreign_keys', 'query_only', 'table_info', 'foreign_key_check', 'quick_check'].includes(argument)) return constants.SQLITE_DENY;
      return constants.SQLITE_OK;
    });
    database.exec(await readFile(path, 'utf8'));
    database.exec('PRAGMA query_only=ON');
    return database;
  } catch {
    database.close();
    throw new VerificationError('SQL snapshot could not be loaded safely; input files were not changed.');
  }
}

function columns(database, table) {
  const result = database.prepare(`PRAGMA table_info("${table}")`).all().map(column => column.name);
  requireValue(result.length > 0, `Required table is missing: ${table}`);
  return result;
}

function rows(database, table) {
  const statement = database.prepare(`SELECT * FROM "${table}"`);
  statement.setReadBigInts(true);
  return statement.all();
}

function encodedValue(value) {
  if (value === null) return ['null'];
  if (value instanceof Uint8Array) return ['blob', value.byteLength, digest(value)];
  if (typeof value === 'bigint') return ['integer', value.toString()];
  if (typeof value === 'number') return ['real', String(value)];
  if (typeof value === 'string') return ['text', value];
  throw new VerificationError('Unsupported SQLite value type.');
}

function normalizedRows(database, table, allColumns, oldSide, reset) {
  return rows(database, table).map(row => {
    for (const name of allColumns) if (!(name in row)) row[name] = null;
    if (reset && oldSide && table === 'notifications' && PENDING_STATUSES.has(row.status)) {
      row.status = 'cancelled';
      row.lease_until = null;
      row.next_attempt_at = null;
      row.last_error = CANCELLED_ON_MIGRATION;
    }
    return row;
  });
}

function tableHash(data, allColumns) {
  // Sort fixed-width row digests to make the result independent of row/column
  // order, while retaining duplicate rows and distinctions between SQL types.
  const digests = data.map(row => digest(JSON.stringify(allColumns.map(name => [name, encodedValue(row[name])])))).sort();
  return digest(JSON.stringify([allColumns, digests]));
}

function compareTable(oldDatabase, newDatabase, table, reset) {
  const oldColumns = columns(oldDatabase, table);
  const newColumns = columns(newDatabase, table);
  const allColumns = [...new Set([...oldColumns, ...newColumns])].sort();
  for (const name of allColumns) {
    if (oldColumns.includes(name) && newColumns.includes(name)) continue;
    requireValue(!oldColumns.includes(name) && newColumns.includes(name) && NEW_NULL_COLUMNS[table]?.has(name), `Unexpected schema difference: ${table}`);
  }
  const oldRows = normalizedRows(oldDatabase, table, allColumns, true, reset);
  const newRows = normalizedRows(newDatabase, table, allColumns, false, reset);
  const oldHash = tableHash(oldRows, allColumns);
  const newHash = tableHash(newRows, allColumns);
  requireValue(oldRows.length === newRows.length && oldHash === newHash, `Business data differs: ${table} (old rows=${oldRows.length}, new rows=${newRows.length}). No row contents printed.`);
  console.log(`PASS ${table}: rows=${newRows.length}, all-fields SHA256=${newHash}`);
  return { oldRows, newRows };
}

function attachmentHash(data) {
  let bytes = 0n;
  const files = [];
  for (const row of data) {
    requireValue(!row.storage_key, 'R2 objects are present; this D1 migration verifier cannot verify their external file bytes. Perform a separate authenticated R2 object comparison.');
    requireValue(row.content instanceof Uint8Array, 'An attachment has no BLOB file bytes.');
    requireValue(BigInt(row.content.byteLength) === row.size, 'Attachment byte length differs from its recorded size.');
    bytes += BigInt(row.content.byteLength);
    files.push(digest(JSON.stringify([encodedValue(row.id), row.content.byteLength, digest(row.content)])));
  }
  return { bytes, hash: digest(JSON.stringify(files.sort())) };
}

function validDatabase(database, label) {
  const quickCheck = database.prepare('PRAGMA quick_check').all();
  requireValue(quickCheck.length === 1 && Object.values(quickCheck[0])[0] === 'ok', `${label} snapshot failed SQLite quick_check.`);
  requireValue(database.prepare('PRAGMA foreign_key_check').all().length === 0, `${label} snapshot has foreign-key inconsistencies.`);
}

let oldDatabase;
let newDatabase;
try {
  const args = process.argv.slice(2);
  const reset = args.includes('--new-origin-reset');
  const paths = args.filter(value => value !== '--new-origin-reset');
  requireValue(paths.length === 2 && args.length === (reset ? 3 : 2) && paths.every(path => !path.startsWith('--')),
    'Usage: node scripts/verify-migration.mjs OLD.sql|sqlite NEW.sql|sqlite [--new-origin-reset]');
  oldDatabase = await snapshot(paths[0]);
  newDatabase = await snapshot(paths[1]);
  validDatabase(oldDatabase, 'Old');
  validDatabase(newDatabase, 'New');
  console.log('PASS snapshot integrity and foreign keys; inputs opened read-only or imported in memory.');
  let attachments;
  for (const table of BUSINESS_TABLES) {
    const compared = compareTable(oldDatabase, newDatabase, table, reset);
    if (table === 'attachments') attachments = compared;
  }
  const before = attachmentHash(attachments.oldRows);
  const after = attachmentHash(attachments.newRows);
  requireValue(before.bytes === after.bytes && before.hash === after.hash, 'Attachment byte hashes differ.');
  console.log(`PASS attachment bytes: files=${attachments.newRows.length}, bytes=${after.bytes}, per-file SHA256 aggregate=${after.hash}`);
  for (const table of SECURITY_TABLES) {
    if (reset) {
      columns(oldDatabase, table);
      columns(newDatabase, table);
      const oldCount = oldDatabase.prepare(`SELECT count(*) AS count FROM "${table}"`).get().count;
      const newCount = newDatabase.prepare(`SELECT count(*) AS count FROM "${table}"`).get().count;
      requireValue(newCount === 0, `Security reset incomplete: ${table} must be empty before first new-site login.`);
      console.log(`PASS intentional security reset: ${table}, old rows=${oldCount}, new rows=0`);
    } else {
      compareTable(oldDatabase, newDatabase, table, false);
    }
  }
  const uploadTable = newDatabase.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='attachment_uploads'").get();
  if (uploadTable) requireValue(newDatabase.prepare('SELECT count(*) AS count FROM attachment_uploads').get().count === 0,
    'Target has pending upload reservations; verify from a quiescent migration snapshot.');
  console.log(`Migration verification passed${reset ? ' with the explicit new-origin security reset' : ' with exact data preservation'}. No network requests, input writes, task edits, or notifications sent.`);
} catch (error) {
  // Never forward SQLite/FS errors: they can contain SQL, local paths or data.
  console.error(`Migration verification failed: ${error instanceof VerificationError ? error.message : 'Unable to safely read or compare snapshots. No business contents or secrets were printed.'}`);
  process.exitCode = 1;
} finally {
  oldDatabase?.close();
  newDatabase?.close();
}
