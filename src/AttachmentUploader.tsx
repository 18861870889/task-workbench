import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, RefreshCw, Upload, X } from 'lucide-react';
import { errorMessage, uploadAttachment } from './api';
import { formatBytes } from './ui';

type UploadItem = {
  id: string;
  file: File;
  status: 'waiting' | 'uploading' | 'success' | 'failed' | 'invalid';
  progress: number;
  error: string;
};
type Props = {
  taskId: string;
  maxBytes: number;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onPendingChange: (pending: boolean) => void;
  onUploaded: () => Promise<void>;
};
const fileKey = (file: File) => `${file.name}\0${file.size}\0${file.lastModified}`;

export default function AttachmentUploader({ taskId, maxBytes, disabled, onBusyChange, onPendingChange, onUploaded }: Props) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [running, setRunning] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const itemsRef = useRef<UploadItem[]>([]);
  const runningRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const setQueue = (next: UploadItem[]) => { itemsRef.current = next; setItems(next); };
  const updateItem = (id: string, patch: Partial<UploadItem>) => setQueue(itemsRef.current.map(item => item.id === id ? { ...item, ...patch } : item));
  useEffect(() => { onPendingChange(items.some(item => ['waiting', 'uploading', 'failed'].includes(item.status))); }, [items, onPendingChange]);

  const send = async (ids: string[]) => {
    if (runningRef.current || !ids.length) return;
    runningRef.current = true; setRunning(true); onBusyChange(true); setRefreshError('');
    try {
      for (const id of ids) {
        const item = itemsRef.current.find(value => value.id === id);
        if (!item || !['waiting', 'failed'].includes(item.status)) continue;
        updateItem(id, { status: 'uploading', progress: 0, error: '' });
        try {
          await uploadAttachment(taskId, item.file, item.id, progress => updateItem(id, { progress }));
          updateItem(id, { status: 'success', progress: 100 });
        } catch (error) { updateItem(id, { status: 'failed', error: errorMessage(error) }); }
      }
    } finally {
      // Even a failed response can mean the server committed the file. Refresh the task version.
      try { await onUploaded(); }
      catch (error) { setRefreshError(`附件处理结束，但详情刷新失败：${errorMessage(error)}`); }
      runningRef.current = false; setRunning(false); onBusyChange(false);
    }
  };
  const selectFiles = (files: FileList | null) => {
    if (!files || disabled || runningRef.current) return;
    const known = new Set(itemsRef.current.filter(item => item.status !== 'invalid').map(item => fileKey(item.file)));
    const additions: UploadItem[] = [];
    for (const file of Array.from(files)) {
      if (known.has(fileKey(file))) continue;
      known.add(fileKey(file));
      const invalid = file.size > maxBytes || file.size === 0;
      additions.push({ id: crypto.randomUUID(), file, status: invalid ? 'invalid' : 'waiting', progress: 0, error: file.size === 0 ? '空文件无法上传。' : invalid ? `超过单个文件 ${formatBytes(maxBytes)} 上限。` : '' });
    }
    setQueue([...itemsRef.current, ...additions]);
    if (inputRef.current) inputRef.current.value = '';
    void send(additions.filter(item => item.status === 'waiting').map(item => item.id));
  };
  const failed = items.filter(item => item.status === 'failed');
  return <div className="attachment-uploader">
    <div className="upload-controls"><label className={`secondary upload-button ${disabled || running ? 'disabled' : ''}`}><Upload size={15} />批量上传文件<input ref={inputRef} type="file" multiple aria-label="选择多个附件上传" disabled={disabled || running} onChange={event => selectFiles(event.target.files)} /></label><span className="field-hint">可一次选择多张照片或多个文件，逐个上传。</span></div>
    {items.length > 0 && <div className="upload-queue"><div className="upload-queue-heading"><span role="status">{running ? '正在上传，请保持页面打开' : `已上传 ${items.filter(item => item.status === 'success').length} / ${items.length} 个文件`}</span>{!running && <button className="text-button" disabled={disabled} onClick={() => setQueue(itemsRef.current.filter(item => item.status === 'failed'))}>清除已完成记录</button>}</div><ul>{items.map(item => <li key={item.id}><div className="upload-file-line"><strong>{item.file.name}</strong><span>{formatBytes(item.file.size)}</span>{item.status === 'success' && <Check size={16} aria-label="上传成功" />}{item.status === 'uploading' && <LoaderCircle size={16} className="spin" aria-label="正在上传" />}{!running && item.status !== 'success' && <button type="button" className="icon-button" aria-label={`移除上传记录：${item.file.name}`} onClick={() => setQueue(itemsRef.current.filter(value => value.id !== item.id))}><X size={14} /></button>}</div>{item.status === 'uploading' && <><progress max="100" value={item.progress} aria-label={`${item.file.name}上传进度`} /><small>{item.progress === 100 ? '文件已传输，等待服务器确认…' : `上传中 ${item.progress}%`}</small></>}{item.status === 'waiting' && <small>等待上传</small>}{item.status === 'success' && <small className="upload-success">上传成功</small>}{item.error && <div className="upload-error"><small>{item.error}</small>{item.status === 'failed' && <button type="button" className="text-button" disabled={disabled || running} onClick={() => void send([item.id])}><RefreshCw size={13} />重试</button>}</div>}</li>)}</ul>{failed.length > 1 && <button className="text-button" disabled={disabled || running} onClick={() => void send(failed.map(item => item.id))}><RefreshCw size={14} />重试 {failed.length} 个失败文件</button>}</div>}
    {refreshError && <div className="notice error" role="alert"><span>{refreshError}</span><button className="text-button" disabled={running || disabled} onClick={() => { setRefreshError(''); void onUploaded().catch(error => setRefreshError(errorMessage(error))); }}>刷新详情</button></div>}
  </div>;
}
