import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import ThreadView from '../components/messaging/ThreadView';

type Tab = 'all' | 'mentions' | 'follow_ups' | 'system' | 'sent';

interface NotificationAction {
  kind: string;
  label: string;
  params?: Record<string, unknown>;
  success_message?: string;
}

interface Notification {
  id: string;
  type: string;
  title: string;
  content: string | null;
  entity_type: string | null;
  entity_id: string | null;
  interaction_id: string | null;
  action_url: string | null;
  priority: string;
  is_read: boolean;
  read_at: string | null;
  acknowledged_at: string | null;
  email_sent_at: string | null;
  nudged_at: string | null;
  due_date: string | null;
  snoozed_until: string | null;
  created_at: string;
  source_user_id: string | null;
  source_first_name: string | null;
  source_last_name: string | null;
  actions?: NotificationAction[];
  // Thread context for "replied in a thread" re-notifications. Server
  // joins back to the thread root so the inbox card can show what the
  // conversation is about without forcing the user to expand. NULL on
  // notifications that aren't thread-anchored.
  thread_root_preview?: string | null;
  thread_root_id?: string | null;
  thread_root_author?: string | null;
}

interface SentNotification {
  id: string;
  type: string;
  title: string;
  content: string | null;
  entity_type: string | null;
  entity_id: string | null;
  interaction_id: string | null;
  action_url: string | null;
  created_at: string;
  recipient_id: string;
  recipient_first_name: string;
  recipient_last_name: string;
  is_read: boolean;
  read_at: string | null;
  acknowledged_at: string | null;
  nudged_at: string | null;
}

interface TabCounts {
  all_unread: string;
  mentions_unread: string;
  follow_ups_active: string;
  system_unread: string;
}

interface Preferences {
  [key: string]: string;
}

const TAB_CONFIG: Array<{ key: Tab; label: string; icon: string }> = [
  { key: 'all', label: 'All', icon: '' },
  { key: 'mentions', label: 'Mentions', icon: '@' },
  { key: 'follow_ups', label: 'Follow-ups', icon: '\u23F0' },
  { key: 'system', label: 'System', icon: '\u26A0\uFE0F' },
  { key: 'sent', label: 'Sent', icon: '\u2709\uFE0F' },
];

const PRIORITY_STYLES: Record<string, { dot: string; bg: string; label: string }> = {
  urgent: { dot: 'bg-red-500', bg: 'bg-red-50 border-red-200', label: 'Urgent' },
  high: { dot: 'bg-amber-500', bg: 'bg-amber-50 border-amber-200', label: 'Important' },
  normal: { dot: 'bg-blue-400', bg: 'bg-white border-gray-200', label: '' },
  low: { dot: 'bg-gray-300', bg: 'bg-gray-50 border-gray-100', label: '' },
};

const TYPE_LABELS: Record<string, string> = {
  mention: 'Mention',
  chase_alert: 'Chase',
  compliance: 'Compliance',
  hire_form: 'Hire Form',
  referral: 'Referral',
  follow_up: 'Follow-up',
  system: 'System',
};

const DELIVERY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'both', label: 'Notification + Email' },
  { value: 'notification', label: 'Notification only' },
  { value: 'email', label: 'Email only' },
  { value: 'none', label: 'None' },
];

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

// ── Date bucketing for inbox section headings ─────────────────────────────
// Only used when sort is by date (newest/oldest). Priority sort interleaves
// dates so headings would be confusing.
type DateBucket = 'today' | 'yesterday' | 'this_week' | 'this_month' | 'older';
const DATE_BUCKET_LABELS: Record<DateBucket, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'Earlier this week',
  this_month: 'Earlier this month',
  older: 'Older',
};

function dateBucket(dateStr: string): DateBucket {
  const now = new Date();
  const d = new Date(dateStr);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffMs = startOfToday.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays <= 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays <= 6) return 'this_week';
  if (diffDays <= 30) return 'this_month';
  return 'older';
}

// ── Snooze preset helpers ─────────────────────────────────────────────────
// Calculate concrete future timestamps for the friendly "Tomorrow morning",
// "Monday morning" presets the user wanted. All return ISO strings so the
// existing snooze endpoint (which expects snooze_until) takes them as-is.

function nextWorkdayMorningISO(targetWeekday: number | null = null): string {
  // Returns the next 08:00 LOCAL time that's after now. If targetWeekday is
  // set (0=Sun..6=Sat), advances to that weekday. Otherwise just to next day.
  const d = new Date();
  d.setHours(8, 0, 0, 0);
  // If 8am today is in the past, move to tomorrow.
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  if (targetWeekday !== null) {
    while (d.getDay() !== targetWeekday) {
      d.setDate(d.getDate() + 1);
    }
  }
  return d.toISOString();
}

function inHoursISO(hours: number): string {
  return new Date(Date.now() + hours * 3600_000).toISOString();
}

function inDaysISO(days: number): string {
  return new Date(Date.now() + days * 86400_000).toISOString();
}

type SortMode = 'priority' | 'newest' | 'oldest';

export default function InboxPage() {
  const [tab, setTab] = useState<Tab>('all');
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [sentItems, setSentItems] = useState<SentNotification[]>([]);
  const [tabCounts, setTabCounts] = useState<TabCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [showPrefs, setShowPrefs] = useState(false);
  const [prefs, setPrefs] = useState<Preferences>({});
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [snoozeId, setSnoozeId] = useState<string | null>(null);
  // Search + sort + show-acknowledged controls. Acknowledged are hidden by
  // default — once dealt with, they're noise.
  const [searchQ, setSearchQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('priority');
  const [showAcknowledged, setShowAcknowledged] = useState(false);
  const [bulkClearing, setBulkClearing] = useState(false);
  const [groupByEntity, setGroupByEntity] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  // Snooze modal — accepts a free-form ISO timestamp from the new preset
  // helpers (was previously a number-of-days only).
  const [snoozeUntilIso, setSnoozeUntilIso] = useState<string | null>(null);
  const [snoozeCustomDate, setSnoozeCustomDate] = useState('');
  // Undo toast: shown for 5 seconds after Done / Clear-read so the user
  // can revert a fat-finger tap.
  const [undoState, setUndoState] = useState<{
    kind: 'single' | 'bulk';
    ids: string[];
    label: string;
  } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const socketRef = useRef<Socket | null>(null);

  // Debounce search input so we don't hit the API on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(searchQ.trim()), 300);
    return () => clearTimeout(t);
  }, [searchQ]);

  const loadInbox = useCallback(async (p: number) => {
    setLoading(true);
    try {
      if (tab === 'sent') {
        const data = await api.get<{
          data: SentNotification[];
          pagination: { page: number; totalPages: number };
        }>(`/notifications/sent?page=${p}&limit=30`);
        setSentItems(data.data);
        setPage(data.pagination.page);
        setTotalPages(data.pagination.totalPages);
      } else {
        const params = new URLSearchParams({
          tab,
          page: String(p),
          limit: '30',
          sort: sortMode,
          include_acknowledged: showAcknowledged ? 'true' : 'false',
        });
        if (debouncedQ) params.set('q', debouncedQ);
        const data = await api.get<{
          data: Notification[];
          tab_counts: TabCounts;
          pagination: { page: number; totalPages: number; total: number };
        }>(`/notifications/inbox?${params.toString()}`);
        setNotifications(data.data);
        setTabCounts(data.tab_counts);
        setPage(data.pagination.page);
        setTotalPages(data.pagination.totalPages);
      }
    } catch (err: unknown) {
      console.error('Inbox load failed:', err);
      const detail = err instanceof Error ? err.message : String(err);
      setLoadError(`Failed to load inbox: ${detail}. Try re-running database migration (npm run db:migrate).`);
    } finally {
      setLoading(false);
    }
  }, [tab, sortMode, showAcknowledged, debouncedQ]);

  useEffect(() => {
    setPage(1);
    setLoadError(null);
    loadInbox(1);
  }, [tab, loadInbox]);

  // Real-time inbox updates — mirrors the NotificationBell socket
  // subscription. New mention / chase / system notifications appear at
  // the top of the list without a manual refresh. When the user is on
  // a filtered tab/search/page>1, we just bump the unread count in
  // tab_counts and let them refresh manually rather than splicing a
  // filtered item into a non-matching view.
  useEffect(() => {
    if (!user) return;

    const socket = io(window.location.origin, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      auth: { token: useAuthStore.getState().accessToken },
    });

    socket.on('notification', (notif: Notification) => {
      // Only splice into the visible list when:
      //  - we're on page 1 (otherwise the pagination invariant breaks)
      //  - no active search
      //  - tab matches the notification's type
      const onPageOne = page === 1;
      const noSearch = !debouncedQ;
      const tabMatches = (() => {
        if (tab === 'all') return true;
        if (tab === 'mentions') return notif.type === 'mention';
        if (tab === 'follow_ups') return notif.type === 'follow_up';
        if (tab === 'system') return ['compliance', 'chase_alert', 'hire_form', 'referral', 'system'].includes(notif.type);
        return false;
      })();

      if (onPageOne && noSearch && tabMatches && tab !== 'sent') {
        setNotifications((prev) => {
          // Avoid double-insert if echo arrives twice.
          if (prev.some((n) => n.id === notif.id)) return prev;
          return [notif, ...prev];
        });
      }

      // Always bump tab counts so unread badges stay accurate even when
      // the new item didn't splice into the visible list.
      setTabCounts((prev) => {
        if (!prev) return prev;
        const next = { ...prev };
        if (!notif.is_read) {
          next.all_unread = String(parseInt(next.all_unread || '0') + 1);
          if (notif.type === 'mention') {
            next.mentions_unread = String(parseInt(next.mentions_unread || '0') + 1);
          }
          if (['compliance', 'chase_alert', 'hire_form', 'referral', 'system'].includes(notif.type)) {
            next.system_unread = String(parseInt(next.system_unread || '0') + 1);
          }
        }
        return next;
      });
    });

    socketRef.current = socket;
    return () => { socket.disconnect(); };
  }, [user, tab, page, debouncedQ]);

  async function markRead(id: string) {
    try {
      await api.post('/notifications/read', { notification_ids: [id] });
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: true, read_at: new Date().toISOString() } : n));
    } catch (err) { console.error(err); }
  }

  async function acknowledge(id: string) {
    try {
      await api.post(`/notifications/${id}/acknowledge`, {});
      setNotifications(prev => prev.map(n => n.id === id
        ? { ...n, is_read: true, acknowledged_at: new Date().toISOString() }
        : n
      ));
      // Surface 5-second Undo toast.
      showUndo({ kind: 'single', ids: [id], label: 'Marked as Done' });
    } catch (err) { console.error(err); }
  }

  async function snoozeUntil(id: string, untilIso: string) {
    try {
      await api.post(`/notifications/${id}/snooze`, { snooze_until: untilIso });
      setNotifications(prev => prev.filter(n => n.id !== id));
      setSnoozeId(null);
      setSnoozeUntilIso(null);
      setSnoozeCustomDate('');
    } catch (err) { console.error(err); }
  }

  // ── Undo toast lifecycle ─────────────────────────────────────────────────
  function clearUndoTimer() {
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
  }
  function showUndo(state: { kind: 'single' | 'bulk'; ids: string[]; label: string }) {
    clearUndoTimer();
    setUndoState(state);
    undoTimerRef.current = setTimeout(() => setUndoState(null), 5000);
  }
  async function performUndo() {
    if (!undoState) return;
    const snapshot = undoState;
    clearUndoTimer();
    setUndoState(null);
    try {
      if (snapshot.kind === 'single') {
        await api.post(`/notifications/${snapshot.ids[0]}/unacknowledge`, {});
      } else {
        await api.post('/notifications/bulk-unacknowledge', { ids: snapshot.ids });
      }
      // Refetch — both single + bulk cases need fresh data because tab
      // counts change and items may move back into "show done"-hidden
      // territory.
      await loadInbox(1);
    } catch (err) {
      console.error('Undo failed:', err);
    }
  }

  useEffect(() => () => clearUndoTimer(), []);

  async function nudge(id: string) {
    try {
      await api.post(`/notifications/${id}/nudge`, {});
      setSentItems(prev => prev.map(n => n.id === id
        ? { ...n, nudged_at: new Date().toISOString(), is_read: false }
        : n
      ));
    } catch (err) { console.error(err); }
  }

  async function runAction(notifId: string, actionIndex: number) {
    try {
      const result = await api.post<{
        success: boolean;
        notification: Notification;
      }>(`/notifications/${notifId}/action`, { action_index: actionIndex });
      // The endpoint marks the notification acknowledged on success — reflect
      // that locally so the row collapses without a full refetch.
      setNotifications(prev => prev.map(n => n.id === notifId
        ? { ...n, is_read: true, acknowledged_at: result.notification.acknowledged_at }
        : n
      ));
    } catch (err) { console.error('Action failed:', err); }
  }

  function navigateToEntity(notif: Notification | SentNotification) {
    const url = notif.action_url;
    if (url) {
      // Add timestamp to force re-navigation even if same URL
      const sep = url.includes('?') ? '&' : '?';
      navigate(`${url}${sep}_t=${Date.now()}`);
      return;
    }
    // Fallback: construct URL from entity_type + entity_id
    if (notif.entity_type && notif.entity_id) {
      const pathMap: Record<string, string> = {
        jobs: '/jobs',
        people: '/people',
        organisations: '/organisations',
        venues: '/venues',
        fleet_vehicles: '/vehicles/fleet',
      };
      const base = pathMap[notif.entity_type];
      if (base) navigate(`${base}/${notif.entity_id}?_t=${Date.now()}`);
    }
  }

  async function loadPreferences() {
    try {
      const data = await api.get<{ data: Preferences }>('/notifications/preferences');
      setPrefs(data.data);
      setShowPrefs(true);
    } catch (err) { console.error(err); }
  }

  async function savePreferences() {
    setSavingPrefs(true);
    try {
      await api.put('/notifications/preferences', prefs);
      setShowPrefs(false);
    } catch (err) { console.error(err); }
    finally { setSavingPrefs(false); }
  }

  async function markAllRead() {
    try {
      await api.post('/notifications/read', {});
      setNotifications(prev => prev.map(n => ({ ...n, is_read: true, read_at: new Date().toISOString() })));
    } catch (err) { console.error(err); }
  }

  // Bulk-acknowledge everything that's been READ in the current tab.
  // Default scope is 'read' (safe — won't touch unread items the user
  // hasn't seen yet); the confirmation copy makes this explicit.
  async function bulkClear() {
    if (bulkClearing) return;
    const tabLabel = TAB_CONFIG.find(t => t.key === tab)?.label || 'this tab';
    if (!window.confirm(
      `Mark every read notification in ${tabLabel} as Done? Unread items will be left alone.`
    )) return;
    setBulkClearing(true);
    try {
      const body: Record<string, unknown> = { scope: 'read' };
      if (tab !== 'all') body.tab = tab;
      const result = await api.post<{ cleared: number; ids: string[] }>('/notifications/bulk-acknowledge', body);
      if (result.ids && result.ids.length > 0) {
        showUndo({
          kind: 'bulk',
          ids: result.ids,
          label: `${result.cleared} cleared`,
        });
      }
      // Refetch — simpler + safer than mutating the visible list, and
      // the tab counts need updating too.
      await loadInbox(1);
    } catch (err) {
      console.error('Bulk-clear failed:', err);
    } finally {
      setBulkClearing(false);
    }
  }

  const getTabCount = (t: Tab): number => {
    if (!tabCounts) return 0;
    switch (t) {
      case 'all': return parseInt(tabCounts.all_unread || '0');
      case 'mentions': return parseInt(tabCounts.mentions_unread || '0');
      case 'follow_ups': return parseInt(tabCounts.follow_ups_active || '0');
      case 'system': return parseInt(tabCounts.system_unread || '0');
      default: return 0;
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Inbox</h1>
          <p className="text-sm text-gray-500">
            Messages, mentions, and follow-ups
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadPreferences}
            className="text-xs text-gray-500 hover:text-gray-700 border border-gray-200 px-3 py-1.5 rounded hover:bg-gray-50 transition-colors"
          >
            Preferences
          </button>
          {tab !== 'sent' && notifications.some(n => !n.is_read) && (
            <button
              onClick={markAllRead}
              className="text-xs text-ooosh-600 hover:text-ooosh-700 border border-ooosh-200 px-3 py-1.5 rounded hover:bg-ooosh-50 transition-colors"
            >
              Mark all read
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-gray-200 overflow-x-auto scrollbar-hide">
        {TAB_CONFIG.map(t => {
          const count = getTabCount(t.key);
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                active
                  ? 'border-ooosh-600 text-ooosh-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {t.icon ? `${t.icon} ` : ''}{t.label}
              {count > 0 && t.key !== 'sent' && (
                <span className="ml-1.5 bg-red-100 text-red-600 text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Toolbar: search + sort + show-acknowledged + bulk-clear. Hidden on
          the Sent tab where it doesn't apply. */}
      {tab !== 'sent' && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div className="relative flex-1 min-w-[180px] max-w-md">
            <input
              type="text"
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              placeholder="Search title or message…"
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500 pr-7"
            />
            {searchQ && (
              <button
                onClick={() => setSearchQ('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm"
                aria-label="Clear search"
              >
                ×
              </button>
            )}
          </div>
          <select
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
            className="text-sm border border-gray-300 rounded px-2 py-1.5 focus:border-ooosh-500 focus:outline-none"
            title="Sort"
          >
            <option value="priority">Sort: Priority</option>
            <option value="newest">Sort: Newest</option>
            <option value="oldest">Sort: Oldest</option>
          </select>
          <label className="inline-flex items-center gap-1.5 text-gray-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showAcknowledged}
              onChange={(e) => setShowAcknowledged(e.target.checked)}
              className="rounded border-gray-300"
            />
            Show done
          </label>
          <label
            className="inline-flex items-center gap-1.5 text-gray-600 cursor-pointer select-none"
            title="Collapse adjacent notifications on the same job/person/etc. into a single card"
          >
            <input
              type="checkbox"
              checked={groupByEntity}
              onChange={(e) => setGroupByEntity(e.target.checked)}
              className="rounded border-gray-300"
            />
            Group by job
          </label>
          <button
            onClick={bulkClear}
            disabled={bulkClearing || notifications.length === 0}
            className="text-xs text-gray-600 hover:text-gray-800 border border-gray-300 px-3 py-1.5 rounded hover:bg-gray-50 transition-colors disabled:opacity-50"
            title="Mark every read notification in this tab as Done"
          >
            {bulkClearing ? 'Clearing…' : 'Clear read'}
          </button>
        </div>
      )}

      {/* Content */}
      {loadError ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
          {loadError}
        </div>
      ) : loading ? (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      ) : tab === 'sent' ? (
        <SentList items={sentItems} onNudge={nudge} onNavigate={navigateToEntity} />
      ) : notifications.length === 0 ? (
        <div className="text-center py-12">
          <div className="text-4xl mb-2">{tab === 'mentions' ? '@' : tab === 'follow_ups' ? '\u23F0' : '\u2709\uFE0F'}</div>
          <p className="text-gray-400">
            {tab === 'all' ? 'All caught up' : `No ${TAB_CONFIG.find(t => t.key === tab)?.label.toLowerCase() || 'items'}`}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {(() => {
            // Build a flat render plan that handles three features at once:
            //   - date headings (between bucket boundaries) when sort is by date
            //   - entity grouping (collapse adjacent same-entity rows into one card)
            //   - the default flat render
            // Single pass keeps the JSX readable.
            const showDateHeadings = sortMode === 'newest' || sortMode === 'oldest';
            const items: React.ReactNode[] = [];
            let currentBucket: DateBucket | null = null;
            let i = 0;
            while (i < notifications.length) {
              const n = notifications[i];

              // Date heading?
              if (showDateHeadings) {
                const b = dateBucket(n.created_at);
                if (b !== currentBucket) {
                  currentBucket = b;
                  items.push(
                    <div key={`hdr-${b}-${i}`} className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 pt-2 pb-0.5">
                      {DATE_BUCKET_LABELS[b]}
                    </div>
                  );
                }
              }

              // Entity grouping: gather an adjacent run of same-entity items.
              if (groupByEntity && n.entity_type && n.entity_id) {
                const groupKey = `${n.entity_type}:${n.entity_id}`;
                const runEnd = (() => {
                  let j = i;
                  while (
                    j < notifications.length
                    && notifications[j].entity_type === n.entity_type
                    && notifications[j].entity_id === n.entity_id
                  ) j++;
                  return j;
                })();
                const run = notifications.slice(i, runEnd);
                if (run.length > 1) {
                  const collapsed = collapsedGroups.has(groupKey);
                  const unreadInGroup = run.filter(r => !r.is_read).length;
                  items.push(
                    <div key={`grp-${groupKey}-${i}`}>
                      <button
                        type="button"
                        onClick={() => setCollapsedGroups(prev => {
                          const next = new Set(prev);
                          if (next.has(groupKey)) next.delete(groupKey); else next.add(groupKey);
                          return next;
                        })}
                        className="w-full text-left rounded-lg border border-dashed border-gray-300 bg-gray-50 hover:bg-gray-100 px-3 py-2 text-xs text-gray-600 flex items-center justify-between transition-colors"
                      >
                        <span>
                          {collapsed ? '▸' : '▾'} {run.length} notifications on this {n.entity_type === 'jobs' ? 'job' : n.entity_type?.replace(/s$/, '')}
                          {unreadInGroup > 0 && (
                            <span className="ml-2 bg-red-100 text-red-600 text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                              {unreadInGroup} unread
                            </span>
                          )}
                        </span>
                        <span className="text-gray-400">{collapsed ? 'Show' : 'Hide'}</span>
                      </button>
                      {!collapsed && (
                        <div className="space-y-2 mt-2 pl-3 border-l-2 border-gray-100">
                          {run.map(rn => (
                            <NotificationRow
                              key={rn.id}
                              notif={rn}
                              onMarkRead={markRead}
                              onAcknowledge={acknowledge}
                              onSnoozeClick={(id) => { setSnoozeId(id); setSnoozeUntilIso(nextWorkdayMorningISO()); setSnoozeCustomDate(''); }}
                              onNavigate={navigateToEntity}
                              onRunAction={runAction}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                  i = runEnd;
                  continue;
                }
              }

              // Default: single row.
              items.push(
                <NotificationRow
                  key={n.id}
                  notif={n}
                  onMarkRead={markRead}
                  onAcknowledge={acknowledge}
                  onSnoozeClick={(id) => { setSnoozeId(id); setSnoozeUntilIso(nextWorkdayMorningISO()); setSnoozeCustomDate(''); }}
                  onNavigate={navigateToEntity}
                  onRunAction={runAction}
                />
              );
              i++;
            }
            return items;
          })()}
        </div>
      )}

      {/* Undo toast — appears for 5 seconds after Done / Clear-read */}
      {undoState && (
        <div
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-gray-900 text-white text-sm px-4 py-2 rounded-lg shadow-lg flex items-center gap-3"
          role="status"
          aria-live="polite"
        >
          <span>{undoState.label}</span>
          <button
            onClick={performUndo}
            className="text-ooosh-200 hover:text-white font-medium underline underline-offset-2"
          >
            Undo
          </button>
          <button
            onClick={() => { clearUndoTimer(); setUndoState(null); }}
            className="text-gray-400 hover:text-white text-xs"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-between items-center text-sm text-gray-500 pt-2">
          <span>Page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <button onClick={() => loadInbox(page - 1)} disabled={page <= 1}
              className="px-3 py-1 border border-gray-300 rounded text-xs disabled:opacity-50 hover:bg-gray-50">
              Previous
            </button>
            <button onClick={() => loadInbox(page + 1)} disabled={page >= totalPages}
              className="px-3 py-1 border border-gray-300 rounded text-xs disabled:opacity-50 hover:bg-gray-50">
              Next
            </button>
          </div>
        </div>
      )}

      {/* Snooze modal — friendlier presets + a date+time picker for the
          "Pick exact moment" case. All presets resolve to ISO timestamps
          on click; the Snooze button just submits whatever's selected. */}
      {snoozeId && (() => {
        const presets: Array<{ key: string; label: string; iso: () => string }> = [
          { key: '2h',  label: '2 hours',           iso: () => inHoursISO(2) },
          { key: 'tom', label: 'Tomorrow morning',  iso: () => nextWorkdayMorningISO() },
          { key: 'mon', label: 'Monday morning',    iso: () => nextWorkdayMorningISO(1) },
          { key: '3d',  label: '3 days',            iso: () => inDaysISO(3) },
          { key: '1w',  label: '1 week',            iso: () => inDaysISO(7) },
          { key: '2w',  label: '2 weeks',           iso: () => inDaysISO(14) },
        ];
        // Resolve the chosen ISO: explicit custom date wins, otherwise
        // whichever preset was last clicked.
        function resolveIso(): string | null {
          if (snoozeCustomDate) {
            // datetime-local gives a value like "2026-05-19T08:30" without
            // timezone — interpret in local TZ.
            const d = new Date(snoozeCustomDate);
            if (!isNaN(d.getTime())) return d.toISOString();
          }
          return snoozeUntilIso;
        }
        const chosenIso = resolveIso();
        return (
          <div
            className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
            onClick={() => { setSnoozeId(null); setSnoozeUntilIso(null); setSnoozeCustomDate(''); }}
          >
            <div className="bg-white rounded-xl shadow-xl p-6 w-96" onClick={e => e.stopPropagation()}>
              <h3 className="text-lg font-semibold text-gray-900 mb-3">Snooze notification</h3>
              <p className="text-sm text-gray-500 mb-4">Remind me…</p>
              <div className="grid grid-cols-2 gap-2 mb-4">
                {presets.map(p => {
                  const active = !snoozeCustomDate && snoozeUntilIso === p.iso.toString();
                  // We can't compare ISO strings directly because each call
                  // to .iso() produces a fresh "now+offset" — track by key
                  // instead via a derived label match.
                  const isActive = !snoozeCustomDate
                    && snoozeUntilIso !== null
                    && p.iso().slice(0, 13) === snoozeUntilIso.slice(0, 13);
                  return (
                    <button
                      key={p.key}
                      onClick={() => { setSnoozeUntilIso(p.iso()); setSnoozeCustomDate(''); }}
                      className={`px-3 py-1.5 rounded text-sm border text-left transition-colors ${
                        (isActive || active)
                          ? 'bg-ooosh-600 text-white border-ooosh-600'
                          : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
              <label className="block text-xs text-gray-500 mb-1">Or pick a moment:</label>
              <input
                type="datetime-local"
                value={snoozeCustomDate}
                onChange={(e) => { setSnoozeCustomDate(e.target.value); setSnoozeUntilIso(null); }}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none mb-4"
              />
              <div className="flex justify-between items-center gap-2">
                <span className="text-xs text-gray-400">
                  {chosenIso ? `Until ${new Date(chosenIso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Pick an option'}
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => { setSnoozeId(null); setSnoozeUntilIso(null); setSnoozeCustomDate(''); }}
                    className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => { if (chosenIso) snoozeUntil(snoozeId, chosenIso); }}
                    disabled={!chosenIso}
                    className="px-4 py-1.5 text-sm bg-ooosh-600 text-white rounded hover:bg-ooosh-700 transition-colors disabled:opacity-50"
                  >
                    Snooze
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Preferences modal */}
      {showPrefs && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowPrefs(false)}>
          <div className="bg-white rounded-xl shadow-xl p-6 w-96 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-1">Notification Preferences</h3>
            <p className="text-sm text-gray-500 mb-4">Choose how you receive each type of notification.</p>
            <div className="space-y-3">
              {Object.entries(TYPE_LABELS).map(([type, label]) => (
                <div key={type} className="flex items-center justify-between">
                  <span className="text-sm text-gray-700">{label}</span>
                  <select
                    value={prefs[type] || 'both'}
                    onChange={e => setPrefs(p => ({ ...p, [type]: e.target.value }))}
                    className="text-xs border border-gray-300 rounded px-2 py-1 focus:border-ooosh-500 focus:outline-none"
                  >
                    {DELIVERY_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-gray-100">
              <button onClick={() => setShowPrefs(false)} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800">
                Cancel
              </button>
              <button onClick={savePreferences} disabled={savingPrefs}
                className="px-4 py-1.5 text-sm bg-ooosh-600 text-white rounded hover:bg-ooosh-700 transition-colors disabled:opacity-50">
                {savingPrefs ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Notification Row ─────────────────────────────────────────────── */

function NotificationRow({ notif, onMarkRead, onAcknowledge, onSnoozeClick, onNavigate, onRunAction }: {
  notif: Notification;
  onMarkRead: (id: string) => void;
  onAcknowledge: (id: string) => void;
  onSnoozeClick: (id: string) => void;
  onNavigate: (n: Notification) => void;
  onRunAction: (notifId: string, actionIndex: number) => Promise<void>;
}) {
  const [showThread, setShowThread] = useState(false);
  const [runningActionIdx, setRunningActionIdx] = useState<number | null>(null);
  const ps = PRIORITY_STYLES[notif.priority] || PRIORITY_STYLES.normal;
  const isFollowUp = notif.type === 'follow_up';
  // Any notification with an interaction_id is part of a thread (mentions,
  // replies, or any future thread-anchored notification). Replaces the
  // older isMention-only check that hid the View thread button on
  // low-priority "replied in a thread" notifications.
  const hasThread = !!notif.interaction_id;
  const isSnoozed = notif.snoozed_until && new Date(notif.snoozed_until) > new Date();
  const isAcknowledged = !!notif.acknowledged_at;
  const actions = notif.actions || [];

  return (
    <div
      className={`rounded-lg border p-4 transition-colors cursor-pointer ${ps.bg} ${
        !notif.is_read ? 'shadow-sm' : 'opacity-75'
      }`}
      onClick={() => {
        if (!notif.is_read) onMarkRead(notif.id);
        onNavigate(notif);
      }}
    >
      <div className="flex items-start gap-3">
        {/* Unread dot */}
        <div className="pt-1.5">
          {!notif.is_read ? (
            <div className={`w-2.5 h-2.5 rounded-full ${ps.dot}`} />
          ) : isAcknowledged ? (
            <svg className="w-3 h-3 text-green-500" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
          ) : (
            <div className="w-2.5 h-2.5 rounded-full bg-gray-200" />
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {ps.label && (
              <span className={`text-[10px] font-bold uppercase ${notif.priority === 'urgent' ? 'text-red-600' : 'text-amber-600'}`}>
                {ps.label}
              </span>
            )}
            <span className="text-[10px] text-gray-400 uppercase font-medium">
              {TYPE_LABELS[notif.type] || notif.type}
            </span>
            {notif.nudged_at && (
              <span className="text-[10px] text-amber-600 font-medium">Nudged</span>
            )}
            {isSnoozed && (
              <span className="text-[10px] text-blue-500 font-medium">
                Snoozed until {formatDate(notif.snoozed_until!)}
              </span>
            )}
          </div>

          <div className="text-sm font-medium text-gray-900 mt-0.5">{notif.title}</div>

          {/* Thread root preview — for "replied in a thread" re-notifies the
              card title is "Pete replied in a thread" but the content is
              Pete's REPLY. Surface a dim quote of what the thread is
              ABOUT so you don't have to expand to find out. */}
          {notif.thread_root_preview && notif.thread_root_id !== (notif.interaction_id || '') && (
            <div className="text-[11px] text-gray-400 mt-1 pl-2 border-l-2 border-gray-200 italic line-clamp-2">
              {notif.thread_root_author ? <span className="not-italic font-medium">{notif.thread_root_author}: </span> : null}
              {notif.thread_root_preview.length > 160
                ? notif.thread_root_preview.slice(0, 160) + '…'
                : notif.thread_root_preview}
            </div>
          )}

          {notif.content && (
            <div className="text-xs text-gray-500 mt-0.5 line-clamp-2">{notif.content}</div>
          )}

          {notif.source_first_name && (
            <div className="text-[11px] text-gray-400 mt-1">
              From {notif.source_first_name} {notif.source_last_name || ''}
            </div>
          )}

          {isFollowUp && notif.due_date && (
            <div className={`text-[11px] mt-1 font-medium ${
              new Date(notif.due_date) <= new Date() ? 'text-red-600' : 'text-blue-600'
            }`}>
              Due: {formatDate(notif.due_date)}
            </div>
          )}
        </div>

        {/* Time + Actions */}
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className="text-[10px] text-gray-400">{formatTimeAgo(notif.created_at)}</span>

          <div className="flex items-center gap-1 mt-1 flex-wrap justify-end" onClick={e => e.stopPropagation()}>
            {/* Inline actions — run server-side, acknowledge on success */}
            {!isAcknowledged && actions.map((act, i) => (
              <button
                key={i}
                onClick={async () => {
                  if (runningActionIdx !== null) return;
                  setRunningActionIdx(i);
                  try { await onRunAction(notif.id, i); }
                  finally { setRunningActionIdx(null); }
                }}
                disabled={runningActionIdx !== null}
                className="text-[10px] text-ooosh-700 bg-ooosh-50 border border-ooosh-300 px-2 py-0.5 rounded hover:bg-ooosh-100 transition-colors disabled:opacity-50 font-medium"
                title={act.success_message}
              >
                {runningActionIdx === i ? '…' : act.label}
              </button>
            ))}
            {hasThread && (
              <button
                onClick={() => {
                  if (!showThread && !notif.is_read) onMarkRead(notif.id);
                  setShowThread(!showThread);
                }}
                className={`text-[10px] border px-2 py-0.5 rounded transition-colors ${
                  showThread
                    ? 'bg-ooosh-100 text-ooosh-700 border-ooosh-300'
                    : 'text-ooosh-600 hover:text-ooosh-700 border-ooosh-200 hover:bg-ooosh-50'
                }`}
              >
                {showThread ? 'Hide thread' : 'View thread'}
              </button>
            )}
            {!isAcknowledged && (
              <button
                onClick={() => onAcknowledge(notif.id)}
                className="text-[10px] text-green-600 hover:text-green-700 border border-green-200 px-2 py-0.5 rounded hover:bg-green-50 transition-colors"
                title="Mark as dealt with"
              >
                Done
              </button>
            )}
            <button
              onClick={() => onSnoozeClick(notif.id)}
              className="text-[10px] text-blue-600 hover:text-blue-700 border border-blue-200 px-2 py-0.5 rounded hover:bg-blue-50 transition-colors"
              title="Snooze"
            >
              Snooze
            </button>
          </div>
        </div>
      </div>

      {/* Expanded thread view (replaces the old single-line reply input) */}
      {showThread && hasThread && (
        <div className="mt-3 pt-3 border-t border-gray-200" onClick={e => e.stopPropagation()}>
          <ThreadView
            interactionId={notif.interaction_id!}
            onAcknowledge={!isAcknowledged ? () => onAcknowledge(notif.id) : undefined}
            onSnooze={() => onSnoozeClick(notif.id)}
          />
        </div>
      )}
    </div>
  );
}

/* ── Sent List ────────────────────────────────────────────────────── */

function SentList({ items, onNudge, onNavigate }: {
  items: SentNotification[];
  onNudge: (id: string) => void;
  onNavigate: (n: SentNotification) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="text-center py-12">
        <div className="text-4xl mb-2">{'\u2709\uFE0F'}</div>
        <p className="text-gray-400">No sent mentions yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {items.map(item => (
        <div
          key={item.id}
          className="rounded-lg border border-gray-200 bg-white p-4 cursor-pointer hover:bg-gray-50 transition-colors"
          onClick={() => onNavigate(item)}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-gray-900">{item.title}</div>
              {item.content && (
                <div className="text-xs text-gray-500 mt-0.5 line-clamp-1">{item.content}</div>
              )}

              <div className="flex items-center gap-2 mt-2">
                <span className="text-xs text-gray-500">
                  To: {item.recipient_first_name} {item.recipient_last_name}
                </span>
                <span className="text-[10px] text-gray-400">{formatTimeAgo(item.created_at)}</span>
              </div>
            </div>

            <div className="flex flex-col items-end gap-1 shrink-0" onClick={e => e.stopPropagation()}>
              {/* Read status */}
              {item.is_read ? (
                <span className="text-[10px] text-green-600 font-medium flex items-center gap-1">
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                  Read {item.read_at ? formatTimeAgo(item.read_at) : ''}
                </span>
              ) : (
                <span className="text-[10px] text-gray-400">Unread</span>
              )}

              {item.acknowledged_at && (
                <span className="text-[10px] text-green-600 font-medium">Acknowledged</span>
              )}

              {/* Nudge button */}
              {!item.is_read && (
                <button
                  onClick={() => onNudge(item.id)}
                  className="text-[10px] text-amber-600 hover:text-amber-700 border border-amber-200 px-2 py-0.5 rounded hover:bg-amber-50 transition-colors mt-1"
                >
                  {item.nudged_at ? 'Nudge again' : 'Nudge'}
                </button>
              )}

              {item.nudged_at && (
                <span className="text-[10px] text-amber-500">Nudged {formatTimeAgo(item.nudged_at)}</span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
