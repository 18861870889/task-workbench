import { useEffect, useRef, type ReactNode } from 'react';
import { X, Plus, Trash2, AlertCircle, LoaderCircle } from 'lucide-react';
import type { Taxonomy } from '../shared/types';

export const priorities = [{ value: 1, label: '低' }, { value: 2, label: '普通' }, { value: 3, label: '高' }, { value: 4, label: '紧急' }];
export const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
export function formatDate(value: string | null, full = false) {
  if (!value) return '无截止日期';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat('zh-CN', { year: full ? 'numeric' : undefined, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
export function dateInput(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  return new Date(date.valueOf() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function isoDate(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error('请填写有效的日期和时间。');
  return date.toISOString();
}
export function formatBytes(bytes: number) {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000000) return `${Number((bytes / 1000).toFixed(1))} KB`;
  return `${Number((bytes / 1000000).toFixed(2))} MB`;
}
export const color = (value: string) => /^#[0-9a-f]{6}$/i.test(value) ? value : '#54758b';
export function ErrorNotice({ children }: { children: ReactNode }) { return children ? <div className="notice error" role="alert"><AlertCircle size={17} /><span>{children}</span></div> : null; }
export function Loading({ text = '正在载入…' }: { text?: string }) { return <div className="loading" role="status"><LoaderCircle size={20} className="spin" />{text}</div>; }
export function Modal({ title, children, onClose, wide = false, className = '' }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; if (dialog && !dialog.open) dialog.showModal(); return () => { if (dialog?.open) dialog.close(); }; }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'wide' : ''} ${className}`} aria-label={title} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === ref.current) onClose(); }}><div className="modal-inner"><header className="modal-header"><h2>{title}</h2><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={20} /></button></header>{children}</div></dialog>;
}
export function TaxonomyPicker({ label, items, selected, onChange }: { label: string; items: Taxonomy[]; selected: string[]; onChange: (ids: string[]) => void }) {
  const visible = items.filter(item => !item.archived || selected.includes(item.id));
  return <fieldset className="picker"><legend>{label}<span className="field-hint">可多选</span></legend>{!visible.length ? <p className="muted small">还没有{label}，可在“分类与设置”中创建。</p> : <div className="chip-options">{visible.map(item => <label key={item.id} className={`chip-choice ${selected.includes(item.id) ? 'chosen' : ''}`}><input type="checkbox" checked={selected.includes(item.id)} onChange={() => onChange(selected.includes(item.id) ? selected.filter(id => id !== item.id) : [...selected, item.id])} /><span className="color-dot" style={{ background: color(item.color) }} />{item.name}{item.archived ? '（已停用）' : ''}</label>)}</div>}</fieldset>;
}
export function ReminderPicker({ offsets, onChange, overdue, onOverdue }: { offsets: number[]; onChange: (values: number[]) => void; overdue: number; onOverdue: (value: number) => void }) {
  return <div className="reminder-editor"><div className="section-label">到期前提醒</div><p className="field-hint">0 分钟表示到期时；留空表示不提前提醒。</p>{offsets.map((offset, index) => <div className="reminder-row" key={index}><span>提前</span><input type="number" aria-label={`第 ${index + 1} 条提醒提前分钟`} min="0" step="1" value={offset} onChange={e => onChange(offsets.map((v, i) => i === index ? Math.max(0, Math.round(Number(e.target.value))) : v))} /><span>分钟</span><small>{offset === 0 ? '到期时' : offset % 1440 === 0 ? `${offset / 1440} 天` : offset % 60 === 0 ? `${offset / 60} 小时` : ''}</small><button type="button" className="icon-button" aria-label={`删除第 ${index + 1} 条提醒`} onClick={() => onChange(offsets.filter((_, i) => i !== index))}><Trash2 size={16} /></button></div>)}<button className="text-button" type="button" onClick={() => onChange([...offsets, 60])}><Plus size={15} />添加提醒时间</button><label className="field overdue-field">逾期重复提醒间隔（分钟）<input type="number" min="0" step="1" value={overdue} onChange={e => onOverdue(Math.max(0, Math.round(Number(e.target.value))))} /><span className="field-hint">0 为不重复；1440 分钟为每天一次。完成后停止提醒。</span></label></div>;
}
