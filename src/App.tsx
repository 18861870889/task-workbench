import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Archive, ArrowDownWideNarrow, ArrowRight, Bell, CalendarDays, Check, CheckCheck, ChevronDown, Circle, Clock3, Folder, Inbox, LayoutList, ListFilter, LoaderCircle, LogOut, Plus, RefreshCw, Search, Settings2, ShieldCheck, SlidersHorizontal, Tag, Trash2, WifiOff, X } from 'lucide-react';
import type { Bootstrap, Task, Taxonomy } from '../shared/types';
import { api, errorMessage, json } from './api';
import Settings from './Settings';
import TaskPanel from './TaskPanel';
import { color, ErrorNotice, formatDate, isoDate, Loading, Modal, priorities } from './ui';

const TaskCalendar = lazy(() => import('./TaskCalendar'));
type View = 'active' | 'calendar' | 'archive' | 'all' | 'trash' | 'settings';
const navigation = [{ value: 'active' as View, label: '当前任务', icon: Inbox }, { value: 'calendar' as View, label: '日程', icon: CalendarDays }, { value: 'archive' as View, label: '归档库', icon: Archive }, { value: 'all' as View, label: '全部记录', icon: LayoutList }, { value: 'trash' as View, label: '回收站', icon: Trash2 }, { value: 'settings' as View, label: '分类与设置', icon: Settings2 }];
const titles = { active: '当前任务', calendar: '任务日程', archive: '归档库', all: '全部记录', trash: '回收站', settings: '分类与设置' };
const subtitles = { active: '记录每一步，让待办有着落。', calendar: '按截止日期安排，回看每一项工作。', archive: '已完成的工作，随时可以找到。', all: '正在推进的与已经完成的，都在这里。', trash: '删除的任务与附件保留在这里，可以随时恢复。', settings: '让工作台适应你的工作方式。' };

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? 'compact' : ''}`}><span className="brand-mark"><CheckCheck size={23} strokeWidth={2.2} /></span><div><strong>我的工作台</strong>{!compact && <small>个人任务管理</small>}</div></div>;
}
function Login({ onLogin, initialError }: { onLogin: () => void; initialError: string }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const login = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await api('/login', json('POST', { password })); setPassword(''); onLogin(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  return <main className="login-page"><div className="login-aside"><Brand /><div className="login-statement"><div className="login-graphic" aria-hidden="true"><div><Check size={23} /><span /><span /></div><div><Clock3 size={23} /><span /><span /></div><div><Folder size={23} /><span /><span /></div></div><h1>每一项工作，<br />都有一处落点。</h1><p>记录任务与沟通，跟进截止日期，<br />留下可以随时查找的工作历史。</p></div><span className="login-aside-footer">专注于你的工作，按你的方式管理。</span></div><div className="login-form-wrap"><Brand compact /><form className="login-form" onSubmit={login}><div className="login-lock"><ShieldCheck size={24} /></div><h2>打开你的工作台</h2><p>输入访问密码，继续管理你的任务。</p><label className="field">访问密码<input type="password" name="password" autoComplete="current-password" required autoFocus value={password} onChange={e => setPassword(e.target.value)} placeholder="输入访问密码" disabled={busy} /></label><ErrorNotice>{error}</ErrorNotice><button className="primary" disabled={busy || !password}>{busy ? <LoaderCircle size={18} className="spin" /> : <>进入工作台<ArrowRight size={18} /></>}</button><small>这是你的个人工作空间，请妥善保管访问密码。</small></form><span className="login-footer">我的工作台 · 测试版</span></div></main>;
}

function QuickAdd({ onCreated }: { onCreated: (task: Task) => void }) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [priority, setPriority] = useState(2);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!title.trim()) return;
    setBusy(true); setError('');
    try { const result = await api<{ task: Task }>('/tasks', json('POST', { title: title.trim(), due_at: isoDate(due), priority })); setTitle(''); setDue(''); setPriority(2); onCreated(result.task); input.current?.focus(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  return <div className="quick-add"><form onSubmit={submit}><div className="quick-add-main"><span className="quick-plus"><Plus size={22} /></span><input ref={input} id="quick-title" aria-label="新任务名称" placeholder="记下新任务，按 Enter 添加…" value={title} onChange={e => setTitle(e.target.value)} required maxLength={300} disabled={busy} /><button type="button" className={`icon-button quick-options ${expanded ? 'is-open' : ''}`} title="设置截止时间与优先级" aria-label="展开新任务选项" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><SlidersHorizontal size={18} /></button><button className="primary" disabled={busy || !title.trim()}>{busy ? <LoaderCircle size={17} className="spin" /> : <><Plus size={16} /><span>添加任务</span></>}</button></div>{expanded && <div className="quick-add-options"><label className="field">截止时间<span className="field-hint">可留空</span><input type="datetime-local" value={due} onChange={e => setDue(e.target.value)} disabled={busy} /></label><label className="field">优先级<select value={priority} onChange={e => setPriority(Number(e.target.value))} disabled={busy}>{priorities.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}</select></label><p>接收时间会自动记录，<br />更多信息可以在任务详情中补充。</p></div>}</form><ErrorNotice>{error}</ErrorNotice></div>;
}

function TaskRow({ task, taxonomies, onOpen }: { task: Task; taxonomies: Taxonomy[]; onOpen: () => void }) {
  const status = taxonomies.find(t => t.id === task.status_id);
  const overdue = !task.deleted_at && !task.completed_at && task.due_at && new Date(task.due_at).valueOf() < Date.now();
  const categories = taxonomies.filter(t => task.category_ids.includes(t.id));
  const tags = taxonomies.filter(t => task.tag_ids.includes(t.id));
  return <button className={`task-row ${task.completed_at ? 'is-complete' : ''}`} onClick={onOpen} aria-label={`查看任务：${task.title}`}><div className="task-main-cell"><span className="task-state-icon" style={{ color: status ? color(status.color) : undefined }}>{task.completed_at ? <Check size={19} /> : <Circle size={17} />}</span><div className="task-title-wrap"><strong>{task.title}</strong><div className="task-meta">{categories.map(item => <span key={item.id} className="task-category"><span className="color-dot" style={{ background: color(item.color) }} />{item.name}</span>)}{tags.map(item => <span className="task-tag" key={item.id}>#{item.name}</span>)}{!categories.length && !tags.length && <span className="unclassified">未分类</span>}</div></div></div><span className="status-cell"><span className="table-status"><span className="color-dot" style={{ background: status ? color(status.color) : undefined }} />{status?.name || '未设置状态'}</span></span><span className={`priority-cell priority-${task.priority}`}><i />{priorities.find(p => p.value === task.priority)?.label || '普通'}</span><span className={`due-cell ${overdue ? 'overdue' : ''}`}><Clock3 size={14} />{formatDate(task.due_at)}{overdue && <small>已逾期</small>}</span><span className="progress-cell"><span className="mini-progress"><span style={{ width: `${Math.min(100, Math.max(0, task.progress))}%` }} /></span><span>{task.progress}%</span></span></button>;
}

function Workspace({ onLogout }: { onLogout: () => void }) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [view, setView] = useState<View>(() => {
    const requested = new URLSearchParams(location.search).get('view');
    return navigation.some(item => item.value === requested) ? requested as View : 'active';
  });
  const [tasks, setTasks] = useState<Task[]>([]);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [category, setCategory] = useState('');
  const [tag, setTag] = useState('');
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [dateField, setDateField] = useState('due');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sort, setSort] = useState('due_at');
  const [direction, setDirection] = useState('asc');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(location.search).get('task'));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [online, setOnline] = useState(navigator.onLine);
  const [revision, setRevision] = useState(0);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [deleteTargets, setDeleteTargets] = useState<Task[]>([]);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  useEffect(() => { setCheckedIds(new Set()); }, [view, query, category, tag, status, priority, dateField, dateFrom, dateTo]);
  useEffect(() => { setCheckedIds(current => new Set([...current].filter(id => tasks.some(task => task.id === id)))); }, [tasks]);
  const querySequence = useRef(0);
  const refreshBootstrap = useCallback(async () => { const result = await api<Bootstrap>('/bootstrap'); setBootstrap(result); }, []);
  useEffect(() => { void refreshBootstrap().catch(e => { setError(errorMessage(e)); setLoading(false); }); }, [refreshBootstrap]);
  useEffect(() => {
    const url = new URL(location.href);
    if (view === 'active') url.searchParams.delete('view');
    else url.searchParams.set('view', view);
    history.replaceState(null, '', url);
  }, [view]);
  useEffect(() => { const timer = setTimeout(() => setDebouncedQuery(query), 280); return () => clearTimeout(timer); }, [query]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 5000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    const connected = () => { setOnline(true); setRevision(v => v + 1); };
    const disconnected = () => setOnline(false);
    window.addEventListener('online', connected); window.addEventListener('offline', disconnected);
    return () => { window.removeEventListener('online', connected); window.removeEventListener('offline', disconnected); };
  }, []);
  useEffect(() => {
    if (!bootstrap || view === 'settings') return;
    const sequence = ++querySequence.current;
    const params = new URLSearchParams({ view: view === 'calendar' ? 'all' : view, q: debouncedQuery, category, tag, status, priority, sort, direction });
    if (dateFrom) params.set(`${dateField}_from`, new Date(`${dateFrom}T00:00:00`).toISOString());
    if (dateTo) params.set(`${dateField}_to`, new Date(`${dateTo}T23:59:59.999`).toISOString());
    setLoading(true); setError('');
    void api<{ tasks: Task[] }>(`/tasks?${params}`).then(result => { if (sequence === querySequence.current) setTasks(result.tasks); }).catch(e => { if (sequence === querySequence.current) setError(errorMessage(e)); }).finally(() => { if (sequence === querySequence.current) setLoading(false); });
    return () => { querySequence.current++; };
  }, [bootstrap, view, debouncedQuery, category, tag, status, priority, dateField, dateFrom, dateTo, sort, direction, revision]);
  const logout = async () => { setLogoutBusy(true); try { await api('/logout', { method: 'POST' }); onLogout(); } catch (e) { setError(errorMessage(e)); } finally { setLogoutBusy(false); } };
  const navigate = (next: View) => { setView(next); setError(''); };
  const filtered = tasks.filter(task => !priority || String(task.priority) === priority);
  const overdue = filtered.filter(task => !task.deleted_at && !task.completed_at && task.due_at && new Date(task.due_at).valueOf() < Date.now()).length;
  const upcoming = filtered.filter(task => !task.deleted_at && !task.completed_at && task.due_at && new Date(task.due_at).valueOf() >= Date.now() && new Date(task.due_at).valueOf() <= Date.now() + 3 * 86400000).length;
  const filters = Boolean(category || tag || status || priority || dateFrom || dateTo || query);
  const resetFilters = () => { setCategory(''); setTag(''); setStatus(''); setPriority(''); setDateFrom(''); setDateTo(''); setQuery(''); };
  const openTask = (id: string) => { setSelectedId(id); const url = new URL(location.href); url.searchParams.set('task', id); history.replaceState(null, '', url); };
  const closeTask = () => { setSelectedId(null); const url = new URL(location.href); url.searchParams.delete('task'); history.replaceState(null, '', url); };
  const selectedTasks = filtered.filter(task => checkedIds.has(task.id));
  const selectableTasks = filtered.slice(0, 100);
  const allSelected = selectableTasks.length > 0 && selectableTasks.every(task => checkedIds.has(task.id));
  const toggleTask = (id: string) => setCheckedIds(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else if (next.size < 100) next.add(id);
    return next;
  });
  const deleteSelected = async () => {
    if (!deleteTargets.length || deleteBusy) return;
    setDeleteBusy(true); setDeleteError('');
    try {
      await api('/tasks/bulk-delete', json('POST', { tasks: deleteTargets.map(task => ({ id: task.id, version: task.version })) }));
      setToast(`已将 ${deleteTargets.length} 项任务移入回收站，可随时恢复。`);
      setDeleteTargets([]); setCheckedIds(new Set()); setRevision(value => value + 1);
    } catch (e) { setDeleteError(errorMessage(e)); }
    finally { setDeleteBusy(false); }
  };
  const date = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());

  return <div className="app-shell"><a className="skip-link" href="#main">跳到任务内容</a><aside className="sidebar"><Brand /><div className="sidebar-label">我的空间</div><nav aria-label="主导航">{navigation.map(item => <button key={item.value} className={view === item.value ? 'active' : ''} onClick={() => navigate(item.value)} aria-current={view === item.value ? 'page' : undefined}><item.icon size={19} />{item.label}{view === item.value && <span className="nav-indicator" />}</button>)}</nav><div className="sidebar-note"><div><Bell size={18} /><strong>留一点空间给专注</strong></div><p>任务交给工作台，<br />下一步由你来决定。</p><button onClick={() => navigate('settings')}>设置提醒<ArrowRight size={14} /></button></div><div className="sidebar-footer"><span className="avatar">我</span><div><strong>个人工作空间</strong><small>测试版 · 0.1.0</small></div><button className="icon-button" aria-label="退出登录" title="退出登录" disabled={logoutBusy} onClick={() => void logout()}><LogOut size={17} /></button></div></aside>
    <div className="workspace"><header className="topbar"><Brand compact /><div className="breadcrumb">我的空间<span>/</span>{titles[view]}</div><div className="topbar-right"><span className="date-label">{date}</span><span className="private-label"><ShieldCheck size={15} />个人空间</span><button className="icon-button mobile-logout" aria-label="退出登录" disabled={logoutBusy} onClick={() => void logout()}><LogOut size={18} /></button></div></header>
      {!online && <div className="offline-banner" role="status"><WifiOff size={17} />当前离线，无法保存任务或发送提醒设置。恢复连接后会重新载入。</div>}
      <main id="main"><div className="page-heading"><div><h1>{titles[view]}<span className="heading-dot" /></h1><p>{subtitles[view]}</p></div>{view !== 'settings' && <button className="secondary page-refresh" disabled={loading} onClick={() => setRevision(v => v + 1)}><RefreshCw size={16} className={loading ? 'spin' : ''} />刷新</button>}</div>
        <ErrorNotice>{error}</ErrorNotice>{!bootstrap ? !error ? <Loading text="正在打开工作空间…" /> : <button className="secondary" onClick={() => { setError(''); void refreshBootstrap().catch(e => setError(errorMessage(e))); }}>重新连接</button> : view === 'settings' ? <Settings bootstrap={bootstrap} refresh={refreshBootstrap} /> : <>
        {view !== 'trash' && <QuickAdd onCreated={task => { setView(current => current === 'calendar' ? 'calendar' : 'active'); resetFilters(); setRevision(v => v + 1); setToast(`已添加“${task.title}”`); }} />}
        <div className="result-summary"><div><span className="summary-value">{loading ? '—' : filtered.length}</span><span>当前结果</span></div><div><span className={`summary-value ${overdue ? 'overdue' : ''}`}>{loading ? '—' : overdue}</span><span>已逾期</span></div><div><span className="summary-value">{loading ? '—' : upcoming}</span><span>3 天内到期</span></div><p>{view === 'trash' ? '回收站中的任务停止提醒，附件仍占用存储空间。' : view === 'archive' ? '完成后的工作记录保留在归档库。' : '没有截止日期的任务，也可以从容安排。'}</p></div>
        <section className={`task-workspace ${view === 'calendar' ? 'calendar-workspace' : ''}`} aria-label={view === 'calendar' ? '任务日程' : '任务列表'}><div className="task-toolbar"><div className="search-box"><Search size={18} /><input aria-label={view === 'trash' ? '搜索回收站' : '搜索全部记录，包含归档任务'} value={query} onChange={e => { setQuery(e.target.value); if (e.target.value.trim() && view !== 'calendar' && view !== 'trash') setView('all'); }} placeholder={view === 'trash' ? '搜索回收站中的任务…' : '搜索全部记录，包含归档任务…'} />{query && <button className="icon-button" aria-label="清空搜索" onClick={() => setQuery('')}><X size={15} /></button>}</div><div className="toolbar-actions"><button className={`secondary filter-toggle ${filtersOpen || filters ? 'selected' : ''}`} aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}><ListFilter size={17} />筛选{(category || tag || status || priority || dateFrom || dateTo) && <span className="filter-dot" />}</button>{view !== 'calendar' && <><label className="sort-control"><ArrowDownWideNarrow size={17} /><select aria-label="任务排序方式" value={sort} onChange={e => setSort(e.target.value)}><option value="due_at">截止时间</option><option value="received_at">接收时间</option><option value="priority">优先级</option><option value="category">分类</option><option value="tag">标签</option><option value="status">状态</option></select></label><button className="direction-button" aria-label={direction === 'asc' ? '当前升序，切换为降序' : '当前降序，切换为升序'} onClick={() => setDirection(direction === 'asc' ? 'desc' : 'asc')}>{direction === 'asc' ? '↑ 升序' : '↓ 降序'}</button></>}</div></div>
        {filtersOpen && <div className="filter-panel"><label className="field">分类<select value={category} onChange={e => setCategory(e.target.value)}><option value="">全部分类</option>{bootstrap.taxonomies.filter(t => t.kind === 'category').map(t => <option key={t.id} value={t.id}>{t.name}{t.archived ? '（已停用）' : ''}</option>)}</select></label><label className="field">标签<select value={tag} onChange={e => setTag(e.target.value)}><option value="">全部标签</option>{bootstrap.taxonomies.filter(t => t.kind === 'tag').map(t => <option key={t.id} value={t.id}>{t.name}{t.archived ? '（已停用）' : ''}</option>)}</select></label><label className="field">状态<select value={status} onChange={e => setStatus(e.target.value)}><option value="">全部状态</option>{bootstrap.taxonomies.filter(t => t.kind === 'status').map(t => <option key={t.id} value={t.id}>{t.name}{t.archived ? '（已停用）' : ''}</option>)}</select></label><label className="field">优先级<select value={priority} onChange={e => setPriority(e.target.value)}><option value="">全部优先级</option>{priorities.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}</select></label><label className="field">日期类型<select value={dateField} onChange={e => setDateField(e.target.value)}><option value="due">截止日期</option><option value="received">接收日期</option></select></label><label className="field">开始日期<input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} /></label><label className="field">结束日期<input type="date" value={dateTo} min={dateFrom || undefined} onChange={e => setDateTo(e.target.value)} /></label><button className="text-button" disabled={!filters} onClick={resetFilters}>清除筛选</button></div>}
        {view !== 'calendar' && view !== 'trash' && <div className="bulk-toolbar"><label className="checkbox-label"><input type="checkbox" checked={allSelected} disabled={loading || !filtered.length} onChange={() => setCheckedIds(allSelected ? new Set() : new Set(selectableTasks.map(task => task.id)))} />{filtered.length > 100 ? '选择前 100 项筛选结果' : '选择当前筛选结果'}</label><span className="bulk-count" role="status">{selectedTasks.length ? `已选 ${selectedTasks.length} 项` : '每次最多选择 100 项'}</span>{selectedTasks.length > 0 && <><button className="text-button" onClick={() => setCheckedIds(new Set())}>取消选择</button><button className="secondary danger-text" disabled={loading} onClick={() => { setDeleteError(''); setDeleteTargets(selectedTasks); }}><Trash2 size={15} />删除所选</button></>}</div>}
        {view === 'calendar' ? <Suspense fallback={<Loading text="正在载入日程…" />}><TaskCalendar tasks={filtered} taxonomies={bootstrap.taxonomies} onOpen={openTask} loading={loading} /></Suspense> : <><div className={`task-table-head ${view !== 'trash' ? 'with-selection' : ''}`} aria-hidden="true"><span>任务名称</span><span>状态</span><span>优先级</span><span>截止时间</span><span>进度</span></div>
        {loading ? <Loading text="正在读取任务…" /> : filtered.length ? <div className="task-table">{filtered.map(task => <div key={task.id} className={`task-list-entry ${view === 'trash' ? '' : 'selectable'} ${checkedIds.has(task.id) ? 'selected' : ''}`}>{view !== 'trash' && <label className="task-select"><input type="checkbox" aria-label={`选择任务：${task.title}`} checked={checkedIds.has(task.id)} disabled={!checkedIds.has(task.id) && checkedIds.size >= 100} onChange={() => toggleTask(task.id)} /></label>}<TaskRow task={task} taxonomies={bootstrap.taxonomies} onOpen={() => openTask(task.id)} /></div>)}</div> : <div className="empty-state"><div className="empty-icon">{filters ? <Search size={30} /> : view === 'trash' ? <Trash2 size={30} /> : view === 'archive' ? <Archive size={30} /> : <Inbox size={30} />}</div><h2>{filters ? '没有找到匹配的任务' : view === 'trash' ? '回收站是空的' : view === 'archive' ? '完成的工作，会留在这里' : '从第一项任务开始'}</h2><p>{filters ? '试试其他关键词，或放宽筛选条件。' : view === 'trash' ? '删除的任务会保留在这里，恢复后回到原来的任务列表。' : view === 'archive' ? '将任务设为完成状态后，会自动进入归档库。' : '在上方记下任务名称即可创建，其他信息可以慢慢补充。'}</p>{filters ? <button className="secondary" onClick={resetFilters}>清除搜索与筛选</button> : view !== 'archive' && view !== 'trash' && <button className="text-button" onClick={() => document.getElementById('quick-title')?.focus()}><Plus size={16} />添加第一项任务</button>}</div>}
        <footer className="list-footer"><span>{filtered.length} 项任务{filters ? ' · 已筛选' : ''}</span><span>点击任务查看详情与历史<ArrowRight size={13} /></span></footer></>}</section>
        <p className="workspace-footnote"><ShieldCheck size={13} />你的工作记录保存在服务器；完成任务后保留历史。</p>
        </>}
      </main><nav className="mobile-nav" aria-label="手机导航">{navigation.map(item => <button key={item.value} className={view === item.value ? 'active' : ''} aria-current={view === item.value ? 'page' : undefined} onClick={() => navigate(item.value)}><item.icon size={21} /><span>{item.value === 'settings' ? '设置' : item.label}</span></button>)}</nav>
    </div>{selectedId && bootstrap && <TaskPanel id={selectedId} bootstrap={bootstrap} onClose={closeTask} onOpen={openTask} onChange={() => setRevision(v => v + 1)} onDeleted={() => { closeTask(); setRevision(v => v + 1); setToast('任务已移入回收站，可随时恢复。'); }} onRestored={() => { closeTask(); setRevision(v => v + 1); setToast('任务已恢复到原来的任务列表。'); }} />}{toast && <div className="toast" role="status"><Check size={18} /><span>{toast}</span><button aria-label="关闭提示" onClick={() => setToast('')}><X size={15} /></button></div>}
    {deleteTargets.length > 0 && <Modal title={`删除这 ${deleteTargets.length} 项任务？`} onClose={() => { if (!deleteBusy) setDeleteTargets([]); }}><div className="modal-body"><p>所选任务将移入回收站并停止提醒，附件和历史记录会保留，可随时恢复。只删除所选任务，关联的后续跟进不会一起删除。</p><ul className="delete-preview">{deleteTargets.slice(0, 5).map(task => <li key={task.id}>{task.title}</li>)}{deleteTargets.length > 5 && <li>另有 {deleteTargets.length - 5} 项任务</li>}</ul><ErrorNotice>{deleteError}</ErrorNotice><div className="dialog-actions"><button className="secondary" disabled={deleteBusy} onClick={() => setDeleteTargets([])}>取消</button><button className="danger" disabled={deleteBusy} onClick={() => void deleteSelected()}><Trash2 size={16} />{deleteBusy ? '正在移入回收站…' : `确认删除 ${deleteTargets.length} 项`}</button></div></div></Modal>}
  </div>;
}

export default function App() {
  const [session, setSession] = useState<'loading' | 'logged-in' | 'logged-out'>('loading');
  const [error, setError] = useState('');
  useEffect(() => {
    void api<{ authenticated: boolean }>('/session').then(result => setSession(result.authenticated ? 'logged-in' : 'logged-out')).catch(e => { setError(errorMessage(e)); setSession('logged-out'); });
    const expire = () => { setError('登录已过期，请重新输入访问密码。'); setSession('logged-out'); };
    window.addEventListener('sessionexpired', expire);
    return () => window.removeEventListener('sessionexpired', expire);
  }, []);
  if (session === 'loading') return <div className="initial-loading"><Brand compact /><Loading text="正在连接工作台…" /></div>;
  if (session === 'logged-out') return <Login initialError={error} onLogin={() => { setError(''); setSession('logged-in'); }} />;
  return <Workspace onLogout={() => { setError(''); setSession('logged-out'); }} />;
}
