import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FullCalendar, { type CalendarRef, type DatesSetInfo, type EventInput } from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/react/daygrid';
import listPlugin from '@fullcalendar/react/list';
import interactionPlugin from '@fullcalendar/react/interaction';
import themePlugin from '@fullcalendar/react/themes/pulse';
import zhCnLocale from '@fullcalendar/react/locales/zh-cn';
import { CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, Inbox, LoaderCircle } from 'lucide-react';
import type { Task, Taxonomy } from '../shared/types';
import { color, localTimezone, priorities } from './ui';
import { localDateKey, partitionCalendarTasks, tasksForDay } from './calendar-data';
import '@fullcalendar/react/skeleton.css';
import '@fullcalendar/react/themes/pulse/theme.css';
import '@fullcalendar/react/themes/pulse/palettes/green.css';
import './calendar.css';

const plugins = [themePlugin, dayGridPlugin, listPlugin, interactionPlugin];
const timeFormat = { hour: '2-digit', minute: '2-digit', hour12: false } as const;
const dayFormatter = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
const timeFormatter = new Intl.DateTimeFormat('zh-CN', timeFormat);
const pointDuration = { milliseconds: 1 };
type CalendarView = 'dayGridMonth' | 'listWeek';
interface Props { tasks: Task[]; taxonomies: Taxonomy[]; onOpen: (id: string) => void; loading: boolean }

function dayLabel(key: string) {
  return dayFormatter.format(new Date(`${key}T12:00:00`));
}
function taskState(task: Task, now: number) {
  return task.completed_at ? 'complete' : task.due_at && new Date(task.due_at).valueOf() < now ? 'late' : 'active';
}
function DeadlineTask({ task, taxonomies, now, onOpen }: { task: Task; taxonomies: Taxonomy[]; now: number; onOpen: (id: string) => void }) {
  const status = taxonomies.find(item => item.id === task.status_id);
  const state = taskState(task, now);
  return <button type="button" className={`calendar-task is-${state}`} onClick={() => onOpen(task.id)} aria-label={`查看任务：${task.title}`}>
    <span className="calendar-task-clock">{task.completed_at ? <Check size={14} /> : <Clock3 size={14} />}{task.due_at ? timeFormatter.format(new Date(task.due_at)) : '未设日期'}</span>
    <strong>{task.title}</strong>
    <span className="calendar-task-meta"><span className="color-dot" style={{ background: status ? color(status.color) : '#75858e' }} />{status?.name || '未设置状态'}{state === 'complete' && status?.name !== '已完成' && <span>已完成</span>}{state === 'late' && <span className="calendar-late-label">已逾期</span>}<span className="calendar-task-priority">{priorities.find(item => item.value === task.priority)?.label || '普通'}</span></span>
  </button>;
}

export default function TaskCalendar({ tasks, taxonomies, onOpen, loading }: Props) {
  const calendar = useRef<CalendarRef>(null);
  const [initialView] = useState<CalendarView>(() => window.matchMedia('(max-width: 640px)').matches ? 'listWeek' : 'dayGridMonth');
  const [view, setView] = useState<CalendarView>(initialView);
  const [title, setTitle] = useState('');
  const [selectedDay, setSelectedDay] = useState(() => localDateKey(new Date()));
  const [showCompleted, setShowCompleted] = useState(true);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60000); return () => window.clearInterval(timer); }, []);
  const { dated, undated } = useMemo(() => partitionCalendarTasks(tasks, showCompleted), [tasks, showCompleted]);
  const selectedTasks = useMemo(() => tasksForDay(dated, selectedDay), [dated, selectedDay]);
  const events = useMemo<EventInput[]>(() => dated.map(task => {
    const state = taskState(task, now);
    const label = state === 'complete' ? '已完成' : state === 'late' ? '逾期' : '';
    return { id: task.id, title: label ? `${label} · ${task.title}` : task.title, start: task.due_at!, allDay: false, color: state === 'late' ? '#ba4e48' : state === 'complete' ? '#75858e' : '#087f75', extendedProps: { state, task } };
  }), [dated, now]);
  const datesChanged = useCallback((info: DatesSetInfo) => {
    setTitle(info.view.title);
    setView(info.view.type as CalendarView);
    const start = localDateKey(info.view.currentStart);
    const end = localDateKey(info.view.currentEnd);
    setSelectedDay(current => current >= start && current < end ? current : start);
  }, []);
  const navigate = (direction: 'prev' | 'next' | 'today') => {
    if (loading) return;
    calendar.current?.getApi()[direction]();
    if (direction === 'today') setSelectedDay(localDateKey(new Date()));
  };
  const changeView = (nextView: CalendarView) => {
    if (!loading) calendar.current?.getApi().changeView(nextView, selectedDay);
  };
  const selectDay = (key: string, moveCalendar = false) => {
    if (loading || !localDateKey(key)) return;
    setSelectedDay(key);
    if (moveCalendar) calendar.current?.getApi().gotoDate(key);
  };

  return <div className="task-calendar" aria-busy={loading}>
    <div className="calendar-controls">
      <div className="calendar-range"><div className="calendar-navigation"><button type="button" className="icon-button" aria-label={view === 'dayGridMonth' ? '上个月' : '上一周'} disabled={loading} onClick={() => navigate('prev')}><ChevronLeft size={19} /></button><button type="button" className="icon-button" aria-label={view === 'dayGridMonth' ? '下个月' : '下一周'} disabled={loading} onClick={() => navigate('next')}><ChevronRight size={19} /></button></div><h2 aria-live="polite">{title || '任务日程'}</h2><button type="button" className="secondary calendar-today" disabled={loading} onClick={() => navigate('today')}>今天</button></div>
      <div className="calendar-view-switch" role="group" aria-label="日程视图"><button type="button" aria-pressed={view === 'dayGridMonth'} disabled={loading} onClick={() => changeView('dayGridMonth')}>月历</button><button type="button" aria-pressed={view === 'listWeek'} disabled={loading} onClick={() => changeView('listWeek')}>周日程</button></div>
    </div>
    <div className="calendar-description"><p>任务显示在截止当天 · {localTimezone}</p><label><input type="checkbox" checked={showCompleted} disabled={loading} onChange={event => setShowCompleted(event.target.checked)} />显示已完成</label></div>
    <div className="calendar-content" inert={loading || undefined}>
      <div className={`calendar-board ${view === 'listWeek' ? 'is-week-agenda' : ''}`}><FullCalendar
        ref={calendar} plugins={plugins} locale={zhCnLocale} firstDay={1} timeZone="local" initialView={initialView}
        headerToolbar={false} height="auto" events={events} datesSet={datesChanged} editable={false} selectable={false}
        eventInteractive={true} eventTimeFormat={timeFormat} displayEventEnd={false} forceEventDuration={false}
        defaultTimedEventDuration={pointDuration} dayMaxEvents={3} fixedWeekCount={false}
        eventClass={info => `deadline-event is-${info.event.extendedProps.state}`}
        eventTimeClass="deadline-event-time" eventTitleClass="deadline-event-title"
        dayHeaderClass="calendar-day-heading" dayCellClass={info => `calendar-day ${localDateKey(info.date) === selectedDay ? 'is-selected-day' : ''}`}
        navLinks={true} navLinkHint={dateText => `查看 ${dateText} 的任务`} navLinkDayClick={date => selectDay(localDateKey(date))}
        dayCellTopContent={info => <span className={`calendar-day-number ${info.isToday ? 'is-today' : ''} ${localDateKey(info.date) === selectedDay ? 'is-day-chosen' : ''}`}>{info.dayNumberText || info.text}</span>}
        dateClick={info => selectDay(info.dateStr.slice(0, 10))}
        eventClick={info => { if (!loading) onOpen(info.event.id); }}
        eventDidMount={info => { const task = info.event.extendedProps.task as Task; info.el.setAttribute('aria-label', `${task.title}，截止 ${dayLabel(localDateKey(task.due_at!))} ${timeFormatter.format(new Date(task.due_at!))}，${task.completed_at ? '已完成' : taskState(task, now) === 'late' ? '已逾期' : '未完成'}，打开详情`); }}
        moreLinkClick={info => { selectDay(localDateKey(info.date)); return 'popover'; }}
        noEventsText="这一周没有到期任务" noEventsClass="calendar-no-events" moreLinkText={count => `另 ${count} 项`}
      /></div>
      <aside className="calendar-day-panel" aria-label="选中日期的任务"><div className="calendar-panel-heading"><span><CalendarDays size={16} />当天任务</span><span className="calendar-count">{selectedTasks.length}</span></div><label className="calendar-selected-date"><span className="calendar-selected-label">选择日期</span><input type="date" aria-label="选择查看任务的日期" value={selectedDay} onChange={event => selectDay(event.target.value, true)} /></label><h3>{dayLabel(selectedDay)}</h3><p className="calendar-panel-caption">按截止时间排列，点击查看详情</p><div className="calendar-day-tasks">{selectedTasks.length ? selectedTasks.map(task => <DeadlineTask key={task.id} task={task} taxonomies={taxonomies} now={now} onOpen={onOpen} />) : <div className="calendar-empty-day"><CalendarDays size={25} /><p>这一天没有到期任务</p><small>可以选择其他日期查看</small></div>}</div></aside>
    </div>
    <section className="calendar-undated" aria-label="无截止日期的任务" inert={loading || undefined}><div className="calendar-undated-heading"><div><h3><Inbox size={17} />无截止日期<span className="calendar-count">{undated.length}</span></h3><p>这些任务仍在这里，设置截止日期后会显示在日历中。</p></div></div>{undated.length ? <div className="calendar-undated-grid">{undated.map(task => <DeadlineTask key={task.id} task={task} taxonomies={taxonomies} now={now} onOpen={onOpen} />)}</div> : <p className="calendar-undated-empty">当前结果中没有无截止日期的任务。</p>}</section>
    <div className="calendar-key"><span><i className="active" />未完成</span><span><i className="late" />已逾期</span><span><i className="complete" />已完成</span><small>截止时间标记，不代表任务持续时长</small></div>
    {loading && <div className="calendar-loading" role="status"><LoaderCircle className="spin" size={18} />正在更新日程…</div>}
  </div>;
}
