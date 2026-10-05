export type TaxonomyKind = 'category' | 'tag' | 'status';
export interface Taxonomy { id: string; kind: TaxonomyKind; name: string; color: string; is_closed: number; sort_order: number; archived: number }
export interface Task {
  id: string; title: string; description: string; notes: string; status_id: string;
  priority: number; progress: number; received_at: string; due_at: string | null;
  created_at: string; updated_at: string; completed_at: string | null; deleted_at: string | null;
  parent_id: string | null; version: number; category_ids: string[]; tag_ids: string[];
  reminder_offsets: number[]; overdue_interval: number;
}
export interface Activity { id: string; task_id: string; kind: string; content: string; changes: string | null; created_at: string }
export interface Attachment { id: string; task_id: string; name: string; mime: string; size: number; created_at: string }
export interface TaskDetail { task: Task; activities: Activity[]; attachments: Attachment[]; followups: Task[] }
export interface NotificationLog { id: string; task_id: string | null; title: string; status: string; channel: string; last_error: string | null; created_at: string; sent_at: string | null; scheduled_at: string; attempts: number }
export interface AppSettings { timezone: string; default_reminder_offsets: number[]; default_overdue_interval: number; email: string; email_enabled: boolean }
export interface Bootstrap { taxonomies: Taxonomy[]; settings: AppSettings; capabilities: { push: boolean; email: boolean; attachments: boolean; attachment_storage: 'd1'; max_attachment_bytes: number; max_database_bytes: number; used_database_bytes: number; used_attachment_bytes: number; reserved_database_bytes: number; available_attachment_bytes: number }; vapid_public_key: string | null }

// API: all routes /api, all JSON except file bodies. Errors {error:string}, 401 login, 409 conflict.
// GET /session -> {authenticated:boolean}; POST /login {password}; POST /logout.
// GET /bootstrap -> Bootstrap. GET /tasks?q=&view=active|archive|all|trash&category=&tag=&status=&sort=due_at|received_at|priority|status|category|tag&direction=asc|desc -> {tasks:Task[]}.
// POST /tasks -> {task:Task}; GET /tasks/:id -> TaskDetail; PATCH /tasks/:id requires version -> {task:Task}.
// POST /tasks/:id/activities {kind:'progress'|'communication'|'note',content} -> {activity:Activity}.
// DELETE /tasks/:id {version} -> {task:Task}; POST /tasks/bulk-delete {tasks:[{id,version}]} -> {ok,deleted_count}, max 100, atomic.
// POST /tasks/:id/restore {version} -> {task:Task}. Trash tasks are read-only except restore; attachments remain downloadable.
// POST /tasks/:id/attachments raw file, Content-Type + X-File-Name (URI encoded) + X-File-Size + optional X-Upload-Id (UUID, reuse for retry) -> {attachment:Attachment}.
// Legacy multipart file uploads remain limited to 1 MiB; raw uploads accept up to 1,990,000 bytes in one D1 BLOB. GET /attachments/:id returns an authenticated download.
// POST /taxonomies {kind,name,color?,is_closed?}; PATCH /taxonomies/:id; DELETE /taxonomies/:id soft-disables.
// PATCH /settings accepts AppSettings. GET /export returns JSON export (attachment metadata, excludes file bytes).
// POST /push/subscribe {endpoint,keys:{p256dh,auth},expirationTime?}; POST /push/unsubscribe {endpoint}.
// POST /push/test sends notification only to subscription endpoint in body {endpoint}; no background messages unless user enables push.
// GET /notifications -> {notifications:NotificationLog[]}. POST /notifications/:id/retry.
