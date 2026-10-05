import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, Check, ChevronDown, Clock3, Download, FileText, History, MessageSquare, Paperclip, Plus, RefreshCw, Save, Trash2, Undo2 } from 'lucide-react';
import type { Activity, Bootstrap, Task, TaskDetail } from '../shared/types';
import AttachmentUploader from './AttachmentUploader';
import { api, ApiError, errorMessage, json } from './api';
import { dateInput, ErrorNotice, formatBytes, formatDate, isoDate, Loading, Modal, priorities, ReminderPicker, TaxonomyPicker, localTimezone } from './ui';

type Props = { id: string; bootstrap: Bootstrap; onClose: () => void; onChange: () => void; onOpen: (id: string) => void; onDeleted: () => void; onRestored: () => void };
const changeNames: Record<string, string> = { title: '任务名称', description: '任务内容', notes: '备注', status_id: '状态', priority: '优先级', progress: '完成进度', received_at: '接收时间', due_at: '截止时间', category_ids: '分类', tag_ids: '标签', reminder_offsets: '提醒时间', overdue_interval: '逾期提醒间隔', parent_id: '关联任务', deleted_at: '删除时间' };
function ChangeSummary({ activity, bootstrap }: { activity: Activity; bootstrap: Bootstrap }) {
  if (!activity.changes) return null;
  try {
    const changes = JSON.parse(activity.changes) as Record<string, unknown>;
    const text = (key: string, value: unknown): string => {
      if (value === null || value === '') return '未设置';
      if (Array.isArray(value)) return value.map(v => bootstrap.taxonomies.find(t => t.id === v)?.name || String(v)).join('、') || '无';
      if (key === 'status_id') return bootstrap.taxonomies.find(t => t.id === value)?.name || String(value);
      if (key === 'priority') return priorities.find(p => p.value === value)?.label || String(value);
      if (key.endsWith('_at')) return formatDate(String(value), true);
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    };
    return <details className="change-details"><summary>查看变更<ChevronDown size={13} /></summary><dl>{Object.entries(changes).map(([key, value]) => {
      const pair = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
      return <div key={key}><dt>{changeNames[key] || key}</dt><dd>{pair && ('from' in pair || 'before' in pair || 'old' in pair) ? `${text(key, pair.from ?? pair.before ?? pair.old ?? null)} → ${text(key, pair.to ?? pair.after ?? pair.new ?? null)}` : text(key, value)}</dd></div>;
    })}</dl></details>;
  } catch { return null; }
}

export default function TaskPanel({ id, bootstrap, onClose, onChange, onOpen, onDeleted, onRestored }: Props) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [draft, setDraft] = useState<Task | null>(null);
  const [due, setDue] = useState('');
  const [received, setReceived] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [activityKind, setActivityKind] = useState('progress');
  const [activity, setActivity] = useState('');
  const [followup, setFollowup] = useState('');
  const [tab, setTab] = useState<'info' | 'timeline'>('info');
  const [dirty, setDirty] = useState(false);
  const [closePrompt, setClosePrompt] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [pendingUploads, setPendingUploads] = useState(false);
  const [deletePrompt, setDeletePrompt] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const locked = busy || uploadBusy;
  const deleted = Boolean(detail?.task.deleted_at);
  const unsaved = dirty || Boolean(activity.trim() || followup.trim()) || pendingUploads;
  const fetchSequence = useRef(0);

  const load = async () => {
    const sequence = ++fetchSequence.current;
    const result = await api<TaskDetail>(`/tasks/${encodeURIComponent(id)}`);
    if (sequence !== fetchSequence.current) return;
    setDetail(result); setDraft(result.task); setDue(dateInput(result.task.due_at)); setReceived(dateInput(result.task.received_at)); setConflict(false); setDirty(false);
  };
  useEffect(() => {
    setDetail(null); setDraft(null); setError(''); setSuccess(''); setActivity(''); setFollowup(''); setDirty(false); setClosePrompt(false); setDeletePrompt(false); setDeleteError(''); setPendingUploads(false); setUploadBusy(false);
    void load().catch(e => setError(errorMessage(e)));
    return () => { fetchSequence.current++; };
  }, [id]);
  useEffect(() => {
    if (!unsaved && !locked) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [unsaved, locked]);
  const update = <K extends keyof Task>(key: K, value: Task[K]) => { setDraft(current => current ? { ...current, [key]: value } : null); setDirty(true); setSuccess(''); };
  const run = async (action: () => Promise<void>, message: string) => {
    setBusy(true); setError(''); setSuccess('');
    try { await action(); await load(); onChange(); setSuccess(message); }
    catch (e) { setError(errorMessage(e)); setConflict(e instanceof ApiError && e.status === 409); }
    finally { setBusy(false); }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || locked || deleted) return;
    await run(async () => {
      const receivedAt = received === dateInput(detail?.task.received_at ?? null) ? detail!.task.received_at : isoDate(received);
      if (!receivedAt) throw new Error('请填写任务接收时间。');
      await api(`/tasks/${encodeURIComponent(id)}`, json('PATCH', {
        version: draft.version, title: draft.title.trim(), description: draft.description, notes: draft.notes,
        status_id: draft.status_id, priority: draft.priority, progress: draft.progress,
        received_at: receivedAt, due_at: due === dateInput(detail?.task.due_at ?? null) ? detail!.task.due_at : isoDate(due), category_ids: draft.category_ids, tag_ids: draft.tag_ids,
        reminder_offsets: [...new Set(draft.reminder_offsets)], overdue_interval: draft.overdue_interval,
      }));
    }, '任务已保存。');
  };
  const moveToTrash = async () => {
    if (!draft || locked || deleted || unsaved) return;
    setBusy(true); setDeleteError('');
    try { await api(`/tasks/${encodeURIComponent(id)}`, json('DELETE', { version: draft.version })); onDeleted(); }
    catch (e) { setDeleteError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const restore = async () => {
    if (!draft || locked || !deleted) return;
    setBusy(true); setError('');
    try { await api(`/tasks/${encodeURIComponent(id)}/restore`, json('POST', { version: draft.version })); onRestored(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const statuses = bootstrap.taxonomies.filter(t => t.kind === 'status' && (!t.archived || t.id === draft?.status_id));
  const close = () => { if (locked) return; if (unsaved) setClosePrompt(true); else onClose(); };

  return <Modal title="任务详情" wide className="task-panel" onClose={close}>
    <div className="panel-status"><ErrorNotice>{error}</ErrorNotice>{success && <p className="success-message" role="status"><Check size={16} />{success}</p>}{conflict && <button className="secondary" disabled={locked} onClick={() => { setError(''); void load().catch(e => setError(errorMessage(e))); }}><RefreshCw size={15} />重新载入最新内容（放弃未保存修改）</button>}</div>
    {!draft || !detail ? !error && <Loading /> : <>
      <div className="task-panel-heading"><div className="eyebrow">{deleted ? '回收站中的任务' : detail.task.completed_at ? '已归档任务' : '进行中的工作'} · {detail.task.parent_id ? '后续跟进' : '任务记录'}</div><h3>{detail.task.title}</h3><p><Clock3 size={14} />接收于 {formatDate(detail.task.received_at, true)}<span>更新于 {formatDate(detail.task.updated_at)}</span></p>{detail.task.parent_id && <button className="text-button" disabled={locked || unsaved} onClick={() => onOpen(detail.task.parent_id!)}>查看原任务<ArrowUpRight size={14} /></button>}</div>
      {deleted && <div className="trash-notice notice subtle"><Trash2 size={17} /><span>已于 {formatDate(detail.task.deleted_at, true)} 移入回收站。当前仅可查看和下载附件，恢复后可继续编辑。</span></div>}
      <div className="panel-tabs" role="tablist" aria-label="任务详情内容"><button id="info-tab" role="tab" aria-controls="info-panel" aria-selected={tab === 'info'} onClick={() => setTab('info')}>任务信息</button><button id="timeline-tab" role="tab" aria-controls="timeline-panel" aria-selected={tab === 'timeline'} onClick={() => setTab('timeline')}><History size={15} />进展与历史<span>{detail.activities.length}</span></button></div>
      <div className="panel-scroll">
      <div hidden={tab !== 'info'} id="info-panel" role="tabpanel" aria-labelledby="info-tab"><form id="task-edit" onSubmit={save}>
        <fieldset disabled={locked || deleted} className="form-fields"><label className="field">任务名称<input required maxLength={300} value={draft.title} onChange={e => update('title', e.target.value)} /></label>
        <div className="form-grid"><label className="field">状态<select value={draft.status_id} onChange={e => update('status_id', e.target.value)}>{statuses.map(status => <option key={status.id} value={status.id}>{status.name}{status.is_closed ? ' · 完成并归档' : ''}{status.archived ? '（已停用）' : ''}</option>)}</select></label><label className="field">优先级<select value={draft.priority} onChange={e => update('priority', Number(e.target.value))}>{priorities.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}</select></label></div>
        <div className="form-grid"><label className="field">接收时间<input required type="datetime-local" value={received} onChange={e => { setReceived(e.target.value); setDirty(true); }} /></label><label className="field">截止时间<span className="field-hint">可留空</span><input type="datetime-local" value={due} onChange={e => { setDue(e.target.value); setDirty(true); }} /></label></div><p className="field-hint date-hint">时间按本机时区 {localTimezone} 显示。</p>
        <label className="field">完成进度<div className="progress-editor"><input type="range" min="0" max="100" step="1" value={draft.progress} onChange={e => update('progress', Number(e.target.value))} /><input aria-label="完成进度百分比" type="number" min="0" max="100" value={draft.progress} onChange={e => update('progress', Math.max(0, Math.min(100, Math.round(Number(e.target.value)))))} /><span>%</span></div><span className="field-hint">进度可手动填写；选择完成状态后才会归档。</span></label>
        <TaxonomyPicker label="分类" items={bootstrap.taxonomies.filter(t => t.kind === 'category')} selected={draft.category_ids} onChange={ids => update('category_ids', ids)} />
        <TaxonomyPicker label="标签" items={bootstrap.taxonomies.filter(t => t.kind === 'tag')} selected={draft.tag_ids} onChange={ids => update('tag_ids', ids)} />
        <label className="field">任务内容<textarea rows={4} value={draft.description} onChange={e => update('description', e.target.value)} placeholder="需要做什么、交付要求或相关背景…" /></label>
        <label className="field">备注<textarea rows={3} value={draft.notes} onChange={e => update('notes', e.target.value)} placeholder="补充说明、联系人或参考信息…" /></label>
        <details className="settings-disclosure"><summary>提醒安排<span>{draft.reminder_offsets.length} 个时间点<ChevronDown size={15} /></span></summary>{!due && <p className="muted small">尚未设置截止时间，提醒规则会保留，设置截止时间后生效。</p>}<ReminderPicker offsets={draft.reminder_offsets} onChange={v => update('reminder_offsets', v)} overdue={draft.overdue_interval} onOverdue={v => update('overdue_interval', v)} /></details>
        </fieldset>
      </form>
      <section className="detail-section"><div className="section-heading"><h4><Paperclip size={17} />附件<span>{detail.attachments.length}</span></h4></div><p className="field-hint">支持照片和文件，单个文件最多 {formatBytes(bootstrap.capabilities.max_attachment_bytes)}。{dirty ? '请先保存任务修改，再上传附件。' : ''}</p>{!deleted && <AttachmentUploader key={id} taskId={id} maxBytes={bootstrap.capabilities.max_attachment_bytes} disabled={busy || dirty || !bootstrap.capabilities.attachments} onBusyChange={setUploadBusy} onPendingChange={setPendingUploads} onUploaded={async () => { await load(); onChange(); }} />}{detail.attachments.length ? <ul className="attachment-list">{detail.attachments.map(file => <li key={file.id}><FileText size={18} /><div><span>{file.name}</span><small>{formatBytes(file.size)} · {formatDate(file.created_at)}</small></div><a href={`/api/attachments/${encodeURIComponent(file.id)}`} download className="icon-button" aria-label={`下载 ${file.name}`}><Download size={17} /></a></li>)}</ul> : <p className="empty-inline">还没有附件。</p>}</section>
      <section className="detail-section"><div className="section-heading"><h4><ArrowUpRight size={17} />后续跟进<span>{detail.followups.length}</span></h4></div>{detail.followups.map(task => <button className="followup-item" key={task.id} disabled={locked || unsaved} onClick={() => onOpen(task.id)}><span>{task.title}</span><ArrowUpRight size={16} /></button>)}{!deleted && <form className="inline-add" onSubmit={e => { e.preventDefault(); if (!followup.trim()) return; void run(async () => { await api('/tasks', json('POST', { title: followup.trim(), parent_id: id })); setFollowup(''); }, '已创建后续跟进任务。'); }}><input aria-label="后续跟进事项" placeholder="添加一项后续跟进…" maxLength={300} value={followup} onChange={e => setFollowup(e.target.value)} disabled={locked || dirty} required /><button className="secondary" disabled={locked || dirty || !followup.trim()}><Plus size={16} />添加</button></form>}{dirty && <p className="field-hint">请先保存任务修改，再添加跟进。</p>}</section>
      </div><div hidden={tab !== 'timeline'} id="timeline-panel" role="tabpanel" aria-labelledby="timeline-tab">{!deleted && <form className="activity-form" onSubmit={e => { e.preventDefault(); if (!activity.trim()) return; void run(async () => { await api(`/tasks/${encodeURIComponent(id)}/activities`, json('POST', { kind: activityKind, content: activity.trim() })); setActivity(''); }, '记录已加入时间线。'); }}><div className="section-heading"><h4><MessageSquare size={17} />记录最新进展</h4><select disabled={locked || dirty} aria-label="记录类型" value={activityKind} onChange={e => setActivityKind(e.target.value)}><option value="progress">最新进展</option><option value="communication">沟通记录</option><option value="note">补充备注</option></select></div><textarea aria-label="记录内容" required value={activity} onChange={e => setActivity(e.target.value)} rows={4} placeholder="记录发生了什么、与谁沟通、下一步需要跟进什么…" disabled={locked || dirty} /><div className="activity-action"><span className="field-hint">{dirty ? '请先保存任务信息中的修改。' : '保存后会保留时间和记录内容。'}</span><button className="primary" disabled={locked || dirty || !activity.trim()}><Plus size={16} />添加记录</button></div></form>}<ol className="timeline">{detail.activities.map(item => <li key={item.id}><span className={`timeline-dot ${item.kind === 'communication' ? 'communication' : ''}`} /><div className="timeline-meta"><strong>{{ progress: '最新进展', communication: '沟通记录', note: '备注', created: '创建任务', create: '创建任务', updated: '更新任务', update: '更新任务', attachment: '附件', completed: '完成归档', deleted: '移入回收站', restored: '恢复任务' }[item.kind] || '任务更新'}</strong><time dateTime={item.created_at}>{formatDate(item.created_at, true)}</time></div><p>{item.content}</p><ChangeSummary activity={item} bootstrap={bootstrap} /></li>)}</ol>{!detail.activities.length && <p className="empty-inline">还没有历史记录。</p>}</div>
      </div>
      <footer className="panel-footer"><div className="panel-footer-status"><span className={dirty ? 'unsaved' : 'muted'}>{uploadBusy ? '附件上传中，请保持页面打开…' : busy ? '正在保存到服务器…' : dirty ? '有未保存的修改' : `最近更新 ${formatDate(detail.task.updated_at)}`}</span>{!deleted && <button className="text-button danger-text" disabled={locked || unsaved} title={unsaved ? '请先保存修改，并处理未完成的上传' : '将任务移入回收站'} onClick={() => { setDeleteError(''); setDeletePrompt(true); }}><Trash2 size={14} />删除任务</button>}</div>{deleted ? <button className="primary" disabled={locked} onClick={() => void restore()}><Undo2 size={16} />恢复任务</button> : <button form="task-edit" className="primary" type={tab === 'info' ? 'submit' : 'button'} disabled={locked || !dirty} onClick={tab === 'timeline' ? () => setTab('info') : undefined}><Save size={16} />{tab === 'timeline' && dirty ? '返回信息页保存' : '保存修改'}</button>}</footer>
    </>}
    {closePrompt && <Modal title="保留未保存的内容？" onClose={() => setClosePrompt(false)}><div className="modal-body"><p>当前还有未保存的修改、记录或未完成的上传。关闭后，这些内容和上传队列会丢失，已上传成功的附件会保留。</p><div className="dialog-actions"><button className="secondary" onClick={() => setClosePrompt(false)}>继续编辑</button><button className="danger" onClick={onClose}>放弃并关闭</button></div></div></Modal>}
    {deletePrompt && <Modal title="删除这项任务？" onClose={() => { if (!locked) setDeletePrompt(false); }}><div className="modal-body"><p>“{detail?.task.title}”将移入回收站并停止提醒。附件和历史记录会保留，可随时恢复；关联的后续跟进不会一起删除。</p><ErrorNotice>{deleteError}</ErrorNotice><div className="dialog-actions"><button className="secondary" disabled={locked} onClick={() => setDeletePrompt(false)}>取消</button><button className="danger" disabled={locked} onClick={() => void moveToTrash()}><Trash2 size={16} />{busy ? '正在移入回收站…' : '确认删除'}</button></div></div></Modal>}
  </Modal>;
}
