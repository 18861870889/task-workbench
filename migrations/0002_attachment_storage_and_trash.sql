ALTER TABLE tasks ADD COLUMN deleted_at TEXT;
CREATE INDEX task_deleted ON tasks(deleted_at);

-- Existing small files retain their original BLOB. New files live in private R2;
-- their content column is an empty BLOB so this migration never rewrites data.
ALTER TABLE attachments ADD COLUMN storage_key TEXT;
CREATE UNIQUE INDEX attachment_storage_key ON attachments(storage_key) WHERE storage_key IS NOT NULL;

-- An atomic INSERT reserves quota before any upload reaches R2. Reservations
-- survive interrupted requests and are cleaned up only after deleting the object.
CREATE TABLE attachment_uploads (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  object_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size > 0 AND size <= 62914560),
  created_at TEXT NOT NULL
);
CREATE INDEX attachment_upload_created ON attachment_uploads(created_at);
