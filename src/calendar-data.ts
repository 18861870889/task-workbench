import type { Task } from '../shared/types';

/** Keep date-only input as a calendar day; convert instants to the device's day. */
export function localDateKey(value: string | Date): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    const check = new Date(0);
    check.setFullYear(year, month - 1, day);
    check.setHours(12, 0, 0, 0);
    return check.getFullYear() === year && check.getMonth() === month - 1 && check.getDate() === day ? value : '';
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) return '';
  return `${date.getFullYear().toString().padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function partitionCalendarTasks(tasks: Task[], showCompleted = true): { dated: Task[]; undated: Task[] } {
  const visible = showCompleted ? tasks : tasks.filter(task => !task.completed_at);
  return {
    dated: visible.filter(task => task.due_at && localDateKey(task.due_at)),
    undated: visible.filter(task => !task.due_at || !localDateKey(task.due_at)),
  };
}

export function tasksForDay(tasks: Task[], dayKey: string): Task[] {
  if (!localDateKey(dayKey)) return [];
  return tasks.filter(task => task.due_at && localDateKey(task.due_at) === dayKey)
    .sort((a, b) => new Date(a.due_at!).valueOf() - new Date(b.due_at!).valueOf() || b.priority - a.priority || a.id.localeCompare(b.id));
}
