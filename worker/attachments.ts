import { z } from 'zod';
import type { Attachment } from '../shared/types';
import { ApiError } from './errors.ts';

// D1 limits a BLOB and the complete row to 2,000,000 bytes. Leave 10 KB for
// filenames and other row fields; MB here is decimal, not MiB.
export const MAX_ATTACHMENT_BYTES = 1_990_000;
export const MAX_DATABASE_BYTES = 500_000_000;
export const RESERVED_DATABASE_BYTES = 2_000_000;
export const ATTACHMENT_OVERHEAD_BYTES = 16 * 1024;
export const LEGACY_ATTACHMENT_BYTES = 1024 * 1024;
const ATTACHMENT_COLUMNS = 'id,task_id,name,mime,size,created_at';

export function fileName(value: string): string {
  return Array.from(value.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim()).slice(0, 240).join('') || 'attachment';
}

export function fileMime(value: string): string {
  return value.length <= 255 && /^[\w.+-]+\/[\w.+-]+$/.test(value) ? value : 'application/octet-stream';
}

async function savedUpload(db: D1Database, id: string): Promise<Attachment | null> {
  return db.prepare(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE id=?`).bind(id).first<Attachment>();
}

function matchingUpload(saved: Attachment, requested: Attachment): boolean {
  return saved.task_id === requested.task_id && saved.name === requested.name
    && saved.mime === requested.mime && saved.size === requested.size;
}

export async function attachmentUsage(db: D1Database): Promise<{ used: number; databaseUsed: number; available: number }> {
  // The official D1 result metadata reports the whole database, including tasks,
  // history, indexes and SQLite pages. Summing file sizes alone is not capacity.
  const result = await db.prepare('SELECT COALESCE(SUM(size),0) AS used FROM attachments').all<{ used: number }>();
  const databaseUsed = result.meta.size_after;
  if (!Number.isSafeInteger(databaseUsed) || databaseUsed <= 0) {
    throw new ApiError('暂时无法读取数据库容量，请稍后重试', 503);
  }
  return {
    used: result.results[0]?.used ?? 0,
    databaseUsed,
    available: Math.max(0, MAX_DATABASE_BYTES - databaseUsed - RESERVED_DATABASE_BYTES - ATTACHMENT_OVERHEAD_BYTES),
  };
}

function databaseCapacityError(error: unknown): boolean {
  return error instanceof Error && /SQLITE_FULL|database(?: or disk)? is full|database or disk.*full|maximum database size|exceed(?:ed|s)?.*(?:database|storage).*size|storage capacity/i.test(error.message);
}

/** Save bytes, history and version together. There is no remote file/object step. */
export async function storeD1Attachment(db: D1Database, attachment: Attachment, bytes: ArrayBuffer): Promise<{ attachment: Attachment; reused: boolean }> {
  if (bytes.byteLength !== attachment.size) throw new ApiError('文件长度与申报大小不一致');
  if (bytes.byteLength === 0) throw new ApiError('不能上传空文件');
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new ApiError('每个附件最多 1.99 MB（1,990,000 字节）', 413);
  const existing = await savedUpload(db, attachment.id);
  if (existing) {
    if (!matchingUpload(existing, attachment)) throw new ApiError('上传编号已用于另一个文件，请重新选择文件', 409);
    return { attachment: existing, reused: true };
  }
  const usage = await attachmentUsage(db);
  if (attachment.size > usage.available) {
    throw new ApiError('数据库剩余空间不足；500 MB 由任务、历史和附件共享，并保留 2 MB 用于后续记录', 413);
  }
  const activityId = crypto.randomUUID();
  const now = new Date().toISOString();
  let results: D1Result[];
  try {
    results = await db.batch([
      // The attachment-byte sum is a compare-and-set snapshot. Two concurrent
      // uploads cannot both consume the same measured database free space. D1's
      // own hard database limit remains the final authority if other writes grow
      // the database between this measurement and the transaction.
      db.prepare(`INSERT INTO attachments(id,task_id,name,mime,size,content,created_at,storage_key)
        SELECT ?,?,?,?,?,?,?,NULL WHERE EXISTS (SELECT 1 FROM tasks WHERE id=? AND deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM attachments WHERE id=?)
        AND COALESCE((SELECT SUM(size) FROM attachments),0)=?`)
        .bind(attachment.id, attachment.task_id, attachment.name, attachment.mime, attachment.size, bytes,
          attachment.created_at, attachment.task_id, attachment.id, usage.used),
      db.prepare(`INSERT INTO activities(id,task_id,kind,content,changes,created_at)
        SELECT ?,id,'attachment',?,json_object('attachment',json(?),'version',json_object('before',version,'after',version+1)),?
        FROM tasks WHERE id=? AND changes()=1`)
        .bind(activityId, `上传附件：${attachment.name}`, JSON.stringify(attachment), now, attachment.task_id),
      db.prepare(`UPDATE tasks SET version=version+1,updated_at=?
        WHERE id=? AND EXISTS (SELECT 1 FROM activities WHERE id=?)`).bind(now, attachment.task_id, activityId),
    ]);
  } catch (error) {
    // A transport failure may hide a committed transaction. Check the UUID
    // before surfacing the error so retrying never creates a second attachment.
    const saved = await savedUpload(db, attachment.id);
    if (saved && matchingUpload(saved, attachment)) return { attachment: saved, reused: true };
    if (databaseCapacityError(error)) throw new ApiError('数据库已达到容量上限，本次附件及记录均未保存；已有数据保留', 413);
    throw error;
  }
  if (results[0].meta.changes === 1) return { attachment, reused: false };
  const saved = await savedUpload(db, attachment.id);
  if (saved) {
    if (!matchingUpload(saved, attachment)) throw new ApiError('上传编号已用于另一个文件，请重新选择文件', 409);
    return { attachment: saved, reused: true };
  }
  const task = await db.prepare('SELECT deleted_at FROM tasks WHERE id=?').bind(attachment.task_id).first<{ deleted_at: string | null }>();
  if (!task || task.deleted_at) throw new ApiError('任务已删除，请恢复后再上传附件', 409);
  throw new ApiError('其他附件刚刚上传，容量已更新，请重试此文件', 409);
}

export async function uploadRawAttachment(env: Env, taskId: string, request: Request): Promise<{ attachment: Attachment; reused: boolean }> {
  const sizeHeader = request.headers.get('x-file-size') ?? '';
  if (!/^[1-9]\d{0,10}$/.test(sizeHeader)) throw new ApiError('请提供有效的文件大小；不能上传空文件');
  const size = Number(sizeHeader);
  if (size > MAX_ATTACHMENT_BYTES) throw new ApiError('每个附件最多 1.99 MB（1,990,000 字节）', 413);
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) !== size) throw new ApiError('文件长度与申报大小不一致');
  if (!request.body) throw new ApiError('请选择文件上传');
  const encodedName = request.headers.get('x-file-name');
  if (!encodedName || encodedName.length > 4096) throw new ApiError('请提供有效的文件名称');
  let name: string;
  try { name = fileName(decodeURIComponent(encodedName)); }
  catch { throw new ApiError('文件名称编码不正确'); }
  const mime = fileMime(request.headers.get('content-type') ?? '');
  const uploadId = request.headers.get('x-upload-id');
  const id = uploadId ? z.uuid().parse(uploadId) : crypto.randomUUID();
  const attachment: Attachment = { id, task_id: taskId, name, mime, size, created_at: new Date().toISOString() };
  // Bound the actual stream, including requests without Content-Length. A single
  // preallocated buffer caps payload memory below 2 MB and never concatenates it.
  const buffer = new Uint8Array(size);
  const reader = request.body.getReader();
  let received = 0;
  let reachedEnd = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { reachedEnd = true; break; }
      received += value.byteLength;
      if (received > size) {
        // Release our reader in finally, then return the controlled 400/413.
        // Cancelling the inbound stream here can abort Miniflare's request
        // connection before its HTTP error response reaches the client.
        throw new ApiError('实际文件大小超过申报大小或 1.99 MB 上限', received > MAX_ATTACHMENT_BYTES ? 413 : 400);
      }
      buffer.set(value, received - value.byteLength);
    }
  } finally {
    // A fully consumed request owns no pending reads. Keep its closed reader
    // until response completion; releasing it at EOF can abort the local
    // Workers proxy RPC before a short-file error response has been delivered.
    if (!reachedEnd) reader.releaseLock();
  }
  if (received !== size) throw new ApiError('文件未完整上传，请重试');
  return storeD1Attachment(env.DB, attachment, buffer.buffer);
}
