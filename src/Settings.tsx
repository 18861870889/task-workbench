import { useEffect, useState, type FormEvent } from 'react';
import { Bell, BellOff, Check, ChevronDown, Download, Folder, Mail, Plus, RefreshCw, Send, ShieldCheck, Smartphone, Tag, X } from 'lucide-react';
import type { AppSettings, Bootstrap, NotificationLog, Taxonomy, TaxonomyKind } from '../shared/types';
import { api, errorMessage, json } from './api';
import { color, ErrorNotice, formatBytes, formatDate, Loading, ReminderPicker, localTimezone } from './ui';

type Props = { bootstrap: Bootstrap; refresh: () => Promise<void> };
const names = { category: '分类', tag: '标签', status: '状态' };

function TaxonomyRow({ item, changed }: { item: Taxonomy; changed: () => Promise<void> }) {
  const [name, setName] = useState(item.name);
  const [tint, setTint] = useState(item.color);
  const [closed, setClosed] = useState(Boolean(item.is_closed));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const dirty = name !== item.name || tint !== item.color || closed !== Boolean(item.is_closed);
  useEffect(() => { setName(item.name); setTint(item.color); setClosed(Boolean(item.is_closed)); }, [item]);
  const act = async (remove = false, restore = false) => {
    setBusy(true); setError('');
    try { await api(`/taxonomies/${encodeURIComponent(item.id)}`, remove ? { method: 'DELETE' } : json('PATCH', restore ? { archived: 0 } : { name: name.trim(), color: tint, is_closed: closed ? 1 : 0 })); await changed(); setConfirm(false); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  return <div className={`taxonomy-row ${item.archived ? 'archived-taxonomy' : ''}`}><div className="taxonomy-row-fields"><input type="color" aria-label={`${item.name}的颜色`} value={color(tint)} onChange={e => setTint(e.target.value)} disabled={busy || Boolean(item.archived)} /><input aria-label={`${names[item.kind]}名称：${item.name}`} value={name} maxLength={80} onChange={e => setName(e.target.value)} disabled={busy || Boolean(item.archived)} />{item.kind === 'status' && <label className="checkbox-label"><input type="checkbox" checked={closed} onChange={e => setClosed(e.target.checked)} disabled={busy || Boolean(item.archived)} />完成并归档</label>}{item.archived ? <><span className="muted small">已停用</span><button className="text-button" disabled={busy} onClick={() => void act(false, true)}>恢复使用</button></> : <><button className="text-button" disabled={busy || !dirty || !name.trim()} onClick={() => void act()}>保存</button><button className="icon-button" disabled={busy} aria-label={`停用${item.name}`} onClick={() => setConfirm(true)}><X size={17} /></button></>}</div>{confirm && <div className="inline-confirm"><p>停用“{item.name}”后不再用于新选择，已有记录保留。</p><button className="text-button" onClick={() => setConfirm(false)} disabled={busy}>取消</button><button className="text-button danger-text" onClick={() => void act(true)} disabled={busy}>确认停用</button></div>}<ErrorNotice>{error}</ErrorNotice></div>;
}

function TaxonomySettings({ bootstrap, refresh }: Props) {
  const [kind, setKind] = useState<TaxonomyKind>('category');
  const [name, setName] = useState('');
  const [tint, setTint] = useState('#16877b');
  const [closed, setClosed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const items = bootstrap.taxonomies.filter(t => t.kind === kind);
  const add = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await api('/taxonomies', json('POST', { kind, name: name.trim(), color: tint, is_closed: kind === 'status' && closed ? 1 : 0 })); await refresh(); setName(''); setClosed(false); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  return <section className="settings-section"><div className="section-heading"><h2><Folder size={20} />按照你的工作分类</h2></div><p className="section-description">分类负责归类，标签负责灵活标记。状态也可以由你命名。</p><div className="segmented taxonomy-tabs" aria-label="选择设置类型">{(['category', 'tag', 'status'] as TaxonomyKind[]).map(value => <button key={value} aria-pressed={kind === value} onClick={() => { setKind(value); setError(''); }}>{names[value]}<span>{bootstrap.taxonomies.filter(t => t.kind === value && !t.archived).length}</span></button>)}</div>{kind === 'status' && <p className="notice subtle"><Check size={17} /><span>带“完成并归档”的状态会让任务进入归档库；改回普通状态后会恢复到当前任务。</span></p>}<div className="taxonomy-list">{items.map(item => <TaxonomyRow key={item.id} item={item} changed={refresh} />)}{!items.length && <p className="empty-inline">还没有{names[kind]}，从下方添加一个。</p>}</div><form className="taxonomy-create" onSubmit={add}><div className="taxonomy-row-fields"><input type="color" aria-label={`新${names[kind]}颜色`} value={tint} onChange={e => setTint(e.target.value)} /><input required maxLength={80} aria-label={`新${names[kind]}名称`} placeholder={`新的${names[kind]}名称`} value={name} onChange={e => setName(e.target.value)} />{kind === 'status' && <label className="checkbox-label"><input type="checkbox" checked={closed} onChange={e => setClosed(e.target.checked)} />完成并归档</label>}<button className="secondary" disabled={busy || !name.trim()}><Plus size={16} />添加{names[kind]}</button></div></form><ErrorNotice>{error}</ErrorNotice></section>;
}

function urlBase64ToUint8Array(value: string) {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const decoded = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}
async function pushRegistration() {
  await navigator.serviceWorker.register('/sw.js');
  return await Promise.race([navigator.serviceWorker.ready, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('通知组件未准备好，请刷新页面后重试。')), 15000))]);
}
function NotificationSettings({ bootstrap }: { bootstrap: Bootstrap }) {
  const supported = typeof Notification !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [permission, setPermission] = useState(supported ? Notification.permission : 'default');
  const [logs, setLogs] = useState<NotificationLog[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(true);
  const loadLogs = async () => { setLoadingLogs(true); try { const result = await api<{ notifications: NotificationLog[] }>('/notifications'); setLogs(result.notifications); } catch (e) { setError(errorMessage(e)); } finally { setLoadingLogs(false); } };
  useEffect(() => {
    if (supported) void navigator.serviceWorker.getRegistration('/').then(reg => reg?.pushManager.getSubscription()).then(sub => setSubscription(sub || null)).catch(() => {});
    void loadLogs();
  }, []);
  const enable = async () => {
    setBusy(true); setError(''); setMessage('');
    try {
      if (!supported) throw new Error('当前浏览器尚不能启用通知。iPhone 请先添加到主屏幕，再从桌面图标打开。');
      if (!bootstrap.capabilities.push || !bootstrap.vapid_public_key) throw new Error('服务器推送尚未配置完成。');
      // This permission request is made directly in the click handler for iOS user activation.
      const allowed = await Notification.requestPermission(); setPermission(allowed);
      if (allowed !== 'granted') throw new Error(allowed === 'denied' ? '通知权限已被关闭，请在系统设置中允许此工作台发送通知后重试。' : '尚未允许通知。你可以稍后再次启用。');
      const registration = await pushRegistration();
      const expectedKey = urlBase64ToUint8Array(bootstrap.vapid_public_key);
      let existing = await registration.pushManager.getSubscription();
      if (existing) {
        const oldKey = existing.options.applicationServerKey ? new Uint8Array(existing.options.applicationServerKey) : null;
        const matches = oldKey?.length === expectedKey.length && oldKey.every((value, index) => value === expectedKey[index]);
        if (!matches) {
          await api('/push/unsubscribe', json('POST', { endpoint: existing.endpoint }));
          await existing.unsubscribe(); existing = null; setSubscription(null);
        }
      }
      const sub = existing || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: expectedKey });
      await api('/push/subscribe', json('POST', sub.toJSON()));
      setSubscription(sub); setMessage('此设备已连接通知服务。点击“发送测试通知”验证实际接收。');
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const disable = async () => {
    if (!subscription) return;
    setBusy(true); setError(''); setMessage('');
    try { await api('/push/unsubscribe', json('POST', { endpoint: subscription.endpoint })); await subscription.unsubscribe(); setSubscription(null); setMessage('已关闭此设备的推送订阅。'); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const test = async () => {
    if (!subscription) return;
    setBusy(true); setError(''); setMessage('');
    try { await api('/push/test', json('POST', { endpoint: subscription.endpoint })); setMessage('测试请求已发送，请查看设备通知。发送成功不代表设备已显示通知。'); }
    catch (e) { setError(errorMessage(e)); }
    finally { await loadLogs(); setBusy(false); }
  };
  const retry = async (id: string) => {
    setBusy(true); setError('');
    try { await api(`/notifications/${encodeURIComponent(id)}/retry`, { method: 'POST' }); await loadLogs(); setMessage('已请求重试这条提醒。'); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  return <section className="settings-section"><div className="section-heading"><h2><Bell size={20} />设备通知</h2><span className={`status-pill ${subscription ? 'connected' : ''}`}>{subscription ? '已有浏览器订阅' : '尚未启用'}</span></div><p className="section-description">提醒由服务器按截止时间发送。网络、系统通知设置或专注模式可能影响弹出时间。</p><div className="notification-actions"><button className="primary" disabled={busy || !bootstrap.capabilities.push} onClick={() => void enable()}><Bell size={16} />{subscription ? '重新连接通知' : '启用此设备通知'}</button><button className="secondary" disabled={busy || !subscription} onClick={() => void test()}><Send size={16} />发送测试通知</button>{subscription && <button className="text-button" disabled={busy} onClick={() => void disable()}><BellOff size={16} />关闭此设备</button>}</div>{!bootstrap.capabilities.push && <p className="notice subtle">服务器推送尚未配置完成，当前不能发送通知。</p>}{permission === 'denied' && <p className="notice subtle">系统通知权限当前为关闭状态，请在设备设置中重新允许。</p>}<ErrorNotice>{error}</ErrorNotice>{message && <p className="success-message" role="status"><Check size={16} />{message}</p>}<details className="install-guide" open={!standalone}><summary><Smartphone size={17} />在 iPhone 上像 App 一样使用<ChevronDown size={16} /></summary><ol><li>使用 iOS 16.4 或更新系统，在 Safari 中打开本站。</li><li>点击分享按钮，选择“添加到主屏幕”。</li><li>从主屏幕图标打开工作台，登录后启用此设备通知。</li><li>发送一条测试通知，确认锁屏和通知中心都能收到。</li></ol><p>无需上架 App Store。普通浏览器标签页不能替代 iPhone 主屏幕应用的推送权限。</p></details><div className="notification-log-heading"><h3>提醒发送记录</h3><button className="text-button" disabled={loadingLogs} onClick={() => void loadLogs()}><RefreshCw size={14} />刷新</button></div>{loadingLogs ? <Loading /> : !logs.length ? <p className="empty-inline">还没有发送记录。设置截止时间并启用通知后，提醒会在这里留下记录。</p> : <ul className="notification-logs">{logs.map(log => <li key={log.id}><div><strong>{log.title || '任务提醒'}</strong><small>{formatDate(log.scheduled_at, true)} · {log.channel === 'push' ? '设备通知' : log.channel} · 尝试 {log.attempts} 次</small>{log.last_error && <p className="danger-text">{log.last_error}</p>}</div><span className={`log-status ${log.status}`}>{{ sent: '已发送', delivered: '已发送', pending: '待发送', scheduled: '待发送', processing: '发送中', retry: '等待重试', failed: '发送失败', skipped: '已跳过', cancelled: '已取消' }[log.status] || log.status}</span>{['failed', 'error'].includes(log.status) && <button className="text-button" onClick={() => void retry(log.id)} disabled={busy}>重试</button>}</li>)}</ul>}<p className="field-hint">“已发送”指推送服务已接受请求，不是设备已读回执。</p></section>;
}

export default function Settings({ bootstrap, refresh }: Props) {
  const [settings, setSettings] = useState<AppSettings>(bootstrap.settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => setSettings(bootstrap.settings), [bootstrap.settings]);
  const update = (changes: Partial<AppSettings>) => { setSettings(current => ({ ...current, ...changes })); setSaved(false); };
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setSaved(false);
    try { await api('/settings', json('PATCH', { ...settings, default_reminder_offsets: [...new Set(settings.default_reminder_offsets)], email_enabled: bootstrap.capabilities.email && settings.email_enabled })); await refresh(); setSaved(true); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  return <div className="settings-page"><TaxonomySettings bootstrap={bootstrap} refresh={refresh} /><section className="settings-section"><div className="section-heading"><h2><Tag size={20} />新任务的默认提醒</h2></div><p className="section-description">修改后应用于新创建的任务，已有任务可以在详情中单独调整。</p><form onSubmit={save}><fieldset disabled={busy} className="form-fields"><ReminderPicker offsets={settings.default_reminder_offsets} onChange={v => update({ default_reminder_offsets: v })} overdue={settings.default_overdue_interval} onOverdue={v => update({ default_overdue_interval: v })} /><div className="timezone-note"><span className="section-label">日期显示时区</span><p className="field-hint">日期按当前设备时区 {localTimezone} 显示；服务器按实际时刻安排提醒。</p></div><div className="email-settings"><h3><Mail size={17} />备用邮件提醒</h3><label className="field">备用邮箱<input type="email" value={settings.email || ''} onChange={e => update({ email: e.target.value })} placeholder="your@email.com" /></label><label className="checkbox-label"><input type="checkbox" disabled={!bootstrap.capabilities.email} checked={bootstrap.capabilities.email && settings.email_enabled} onChange={e => update({ email_enabled: e.target.checked })} />启用邮件提醒</label>{!bootstrap.capabilities.email && <p className="field-hint">尚未接入邮件发送服务。当前仅保存邮箱地址，不会发送邮件。</p>}</div></fieldset><ErrorNotice>{error}</ErrorNotice><div className="settings-save"><span className="success-message" role="status">{saved && <><Check size={16} />设置已保存</>}</span><button className="primary" disabled={busy}>保存默认设置</button></div></form></section><NotificationSettings bootstrap={bootstrap} /><section className="settings-section"><div className="section-heading"><h2><ShieldCheck size={20} />你的工作记录</h2></div><p className="section-description">完成的任务保留在归档库；删除的任务移入回收站，可随时恢复。你可以导出任务、分类和历史记录作为备份。</p><div className="storage-meter"><div><strong>工作台存储</strong><span>单个附件最多 {formatBytes(bootstrap.capabilities.max_attachment_bytes)}</span></div><progress max={bootstrap.capabilities.max_database_bytes} value={bootstrap.capabilities.used_database_bytes} aria-label="数据库存储使用量" /><p className="field-hint">数据库已用 {formatBytes(bootstrap.capabilities.used_database_bytes)} / {formatBytes(bootstrap.capabilities.max_database_bytes)}，其中附件 {formatBytes(bootstrap.capabilities.used_attachment_bytes)}。</p><p className="field-hint">任务、历史记录和附件共享数据库容量，预留 {formatBytes(bootstrap.capabilities.reserved_database_bytes)} 给任务和历史。归档及回收站中的附件仍占用空间。</p><p className="field-hint">预计还能存放约 {formatBytes(bootstrap.capabilities.available_attachment_bytes)} 附件。容量按十进制显示，1 MB = 1,000,000 字节。</p><button className="text-button" disabled={busy} onClick={() => { setBusy(true); void refresh().catch(e => setError(errorMessage(e))).finally(() => setBusy(false)); }}><RefreshCw size={13} />刷新容量</button></div><a className="secondary" href="/api/export" download><Download size={16} />导出数据（JSON）</a><p className="field-hint">导出包含附件名称等信息，不包含附件文件本身；请在任务详情中单独下载附件。</p><div className="build-note">我的工作台 · 测试版 0.1.0</div></section></div>;
}
