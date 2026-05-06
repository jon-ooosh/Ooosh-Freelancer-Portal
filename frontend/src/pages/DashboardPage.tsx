import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import type { OperationsData, BacklineOverview } from '../components/dashboard/types';
import { StatCard } from '../components/dashboard/v2/primitives';
import { SECTIONS } from '../components/dashboard/v2/registry';
import { applyOrder } from '../components/dashboard/v2/sections';
import { useDensity, useTheme, useSectionOrder } from '../components/dashboard/v2/usePrefs';

function getDateStr() {
  return new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function formatLastRefresh(d: Date): string {
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export default function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  const [data, setData] = useState<OperationsData | null>(null);
  const [backline, setBackline] = useState<BacklineOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [, setTick] = useState(0);
  const loadedDateRef = useRef<string>(new Date().toDateString());

  const [density, setDensity] = useDensity();
  const [theme, setTheme] = useTheme();
  const [order] = useSectionOrder();

  const orderedSections = useMemo(() => applyOrder(SECTIONS, order), [order]);

  const loadData = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    try {
      const [opsData, blData] = await Promise.all([
        api.get<OperationsData>('/dashboard/operations'),
        api.get<{ data: BacklineOverview }>('/backline/overview').catch(() => null),
      ]);
      setData(opsData);
      if (blData) setBackline(blData.data);
      setLastRefresh(new Date());
      loadedDateRef.current = new Date().toDateString();
    } catch (err) {
      console.error('Dashboard load failed:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    const interval = setInterval(() => {
      setTick(t => t + 1);
      const now = new Date();
      const currentDateStr = now.toDateString();
      if (loadedDateRef.current !== currentDateStr) loadData();
    }, 60_000);
    return () => clearInterval(interval);
  }, [loadData]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        const now = new Date();
        const currentDateStr = now.toDateString();
        const stale = lastRefresh && (now.getTime() - lastRefresh.getTime() > 5 * 60_000);
        if (loadedDateRef.current !== currentDateStr || stale) loadData();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [loadData, lastRefresh]);

  if (loading) {
    return (
      <div className="dash-v2 max-w-[1440px] mx-auto px-5 py-8">
        <div className="text-gray-500">Loading…</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="dash-v2 max-w-[1440px] mx-auto px-5 py-8">
        <div className="text-red-600">Failed to load dashboard.</div>
      </div>
    );
  }

  const stats = data.stat_cards;
  const userName = user?.first_name || 'there';

  return (
    <div
      className="dash-v2 max-w-[1440px] mx-auto px-5 py-6 space-y-5"
      data-density={density}
      data-theme={theme}
      style={{ background: 'var(--op-bg)', color: 'var(--op-text)' }}
    >
      {/* Greeting + refresh */}
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="op-h1">{getGreeting()}, {userName}</div>
          <div className="text-sm text-gray-500 mt-0.5">{getDateStr()}</div>
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-500">
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block rounded-full"
              style={{ width: 6, height: 6, background: 'var(--op-green)' }}
            />
            Updated {lastRefresh ? formatLastRefresh(lastRefresh) : '—'}
          </span>
          <button
            onClick={() => loadData(true)}
            disabled={refreshing}
            className="px-2.5 py-1 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-50"
          >
            {refreshing ? '⟳ Refreshing…' : '⟳ Refresh'}
          </button>
          {/* Density toggle */}
          <select
            value={density}
            onChange={(e) => setDensity(e.target.value as typeof density)}
            className="px-2 py-1 border border-gray-200 rounded bg-white"
            aria-label="Density"
          >
            <option value="compact">Compact</option>
            <option value="regular">Regular</option>
            <option value="comfy">Comfy</option>
          </select>
          {/* Theme toggle */}
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="px-2 py-1 rounded border border-gray-200 hover:bg-gray-50"
            aria-label="Toggle theme"
            title="Toggle theme"
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </div>
      </header>

      {/* Stat row — each card click-throughs to its filtered list view */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard
          value={stats.on_hire_count}
          label="On hire"
          accent="green"
          sparkline={stats.on_hire_spark}
          to="/jobs?status=5&time=out_now"
        />
        <StatCard
          value={stats.going_out_count}
          label="Going out today"
          accent="purple"
          to="/jobs?status=2,3,4,5,8&time=out_now"
        />
        <StatCard
          value={stats.coming_back_count}
          label="Coming back"
          accent="blue"
          to="/jobs?status=5&time=out_now"
        />
        <StatCard
          value={stats.overdue_count}
          label="Overdue returns"
          accent="red"
          to="/jobs?overdue=1"
        />
        <StatCard
          value={stats.chases_due_count}
          label="Chases due"
          accent="amber"
          to="/pipeline?chase=overdue"
        />
        <StatCard
          value={stats.open_enquiries_count}
          label="Open enquiries"
          accent="purple"
          to="/pipeline"
        />
      </div>

      {/* Sections (registry-driven) */}
      {orderedSections.map(({ id, component: Comp }) => (
        <Comp key={id} data={data} backline={backline} refresh={loadData} />
      ))}

      {/* Footer aux nav */}
      <div className="text-center text-xs text-gray-400 pt-4">
        Need something else? <Link to="/jobs" className="underline">All jobs</Link> · <Link to="/people" className="underline">People</Link> · <Link to="/operations/transport" className="underline">Operations</Link>
      </div>
    </div>
  );
}
