import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { localDateKey, partitionCalendarTasks, tasksForDay } from '../src/calendar-data.ts';

const task = (id, due_at, completed_at = null) => ({
  id, title: id, description: '', notes: '', status_id: completed_at ? 'status-done' : 'status-todo',
  priority: 2, progress: 0, received_at: '2026-10-01T10:00:00Z', due_at,
  created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z',
  completed_at, parent_id: null, version: 1, category_ids: [], tag_ids: [],
  reminder_offsets: [], overdue_interval: 0,
});

test('all tasks remain visible across dated and undated sections, including completed tasks', () => {
  const input = Object.freeze([
    task('scheduled', '2026-10-05T10:00:00Z'), task('undated', null),
    task('closed-scheduled', '2026-10-04T10:00:00Z', '2026-10-04T11:00:00Z'),
    task('closed-undated', null, '2026-10-04T11:00:00Z'),
  ]);
  const { dated, undated } = partitionCalendarTasks(input);
  assert.deepEqual(dated.map(t => t.id).sort(), ['closed-scheduled', 'scheduled']);
  assert.deepEqual(undated.map(t => t.id).sort(), ['closed-undated', 'undated']);
  assert.equal(new Set([...dated, ...undated].map(t => t.id)).size, input.length);
  assert.equal(input[1].due_at, null);
});

test('hide-completed applies to both calendar dates and the undated list', () => {
  const input = [task('active', null), task('closed', null, '2026-10-01T11:00:00Z'), task('closed-dated', '2026-10-05T10:00:00Z', '2026-10-04T11:00:00Z')];
  const { dated, undated } = partitionCalendarTasks(input, false);
  assert.equal(dated.length, 0);
  assert.deepEqual(undated.map(t => t.id), ['active']);
});

test('day selection uses the deadline rather than the receipt timestamp and sorts deadlines', () => {
  const early = new Date(2026, 9, 5, 8).toISOString();
  const late = new Date(2026, 9, 5, 17).toISOString();
  const other = new Date(2026, 9, 6, 8).toISOString();
  const input = Object.freeze([task('late', late), task('other-day', other), task('undated', null), task('early', early)]);
  assert.deepEqual(tasksForDay(input, '2026-10-05').map(t => t.id), ['early', 'late']);
  assert.equal(tasksForDay(input, '2026-10-01').length, 0);
  assert.equal(localDateKey('not-a-date'), '');
});

test('local calendar dates stay correct across China, Guinea, and a DST transition', () => {
  const helperUrl = new URL('../src/calendar-data.ts', import.meta.url).href;
  for (const [timezone, instant, expected] of [
    ['Asia/Shanghai', '2026-10-04T16:30:00Z', '2026-10-05'],
    ['Africa/Conakry', '2026-10-04T16:30:00Z', '2026-10-04'],
    ['America/New_York', '2026-11-01T05:30:00Z', '2026-11-01'],
    ['America/New_York', '2026-11-01T06:30:00Z', '2026-11-01'],
  ]) {
    const source = `import {localDateKey} from ${JSON.stringify(helperUrl)}; console.log(JSON.stringify([localDateKey(${JSON.stringify(instant)}),localDateKey('2026-10-05')]));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, TZ: timezone }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [expected, '2026-10-05'], timezone);
  }
});
