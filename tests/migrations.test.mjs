import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

test('upgrading an existing database retains task identity, history, classifications and legacy attachment bytes', () => {
  const directory = new URL('../migrations/', import.meta.url);
  const migrations = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
  const sql = new DatabaseSync(':memory:');
  try {
    sql.exec('PRAGMA foreign_keys=ON');
    sql.exec(readFileSync(new URL(migrations[0], directory), 'utf8'));
    const timestamp = '2026-09-01T08:15:00.000Z';
    sql.prepare(`INSERT INTO tasks(id,title,notes,status_id,received_at,due_at,created_at,updated_at,completed_at,version)
      VALUES('original','原账号培训档案','旧账号备注','status-done',?,?,?,?,?,7)`)
      .run(timestamp, timestamp, timestamp, timestamp, timestamp);
    sql.prepare("INSERT INTO taxonomies(id,kind,name) VALUES('original-category','category','培训')").run();
    sql.prepare("INSERT INTO task_taxonomies(task_id,taxonomy_id) VALUES('original','original-category')").run();
    sql.prepare("INSERT INTO activities(id,task_id,kind,content,created_at) VALUES('history','original','communication','原有沟通记录',?)").run(timestamp);
    const bytes = Buffer.from([0, 255, 1, 128, 13, 10, 60, 62]);
    sql.prepare(`INSERT INTO attachments(id,task_id,name,mime,size,content,created_at)
      VALUES('old-file','original','旧附件.bin','application/octet-stream',?,?,?)`).run(bytes.length, bytes, timestamp);
    const before = {
      task: sql.prepare('SELECT * FROM tasks').get(),
      attachment: sql.prepare('SELECT * FROM attachments').get(),
      activities: sql.prepare('SELECT * FROM activities').all(),
      links: sql.prepare('SELECT * FROM task_taxonomies').all(),
    };
    for (const name of migrations.slice(1)) sql.exec(readFileSync(new URL(name, directory), 'utf8'));
    const afterTask = sql.prepare('SELECT * FROM tasks').get();
    const afterAttachment = sql.prepare('SELECT * FROM attachments').get();
    for (const [field, value] of Object.entries(before.task)) assert.deepEqual(afterTask[field], value, field);
    for (const [field, value] of Object.entries(before.attachment)) assert.deepEqual(afterAttachment[field], value, field);
    assert.equal(afterTask.deleted_at, null);
    assert.equal(afterAttachment.storage_key, null);
    assert.deepEqual(sql.prepare('SELECT * FROM activities').all(), before.activities);
    assert.deepEqual(sql.prepare('SELECT * FROM task_taxonomies').all(), before.links);
    assert.equal(sql.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { sql.close(); }
});
