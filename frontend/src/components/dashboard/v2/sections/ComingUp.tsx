import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DashboardSectionProps } from '../sections';
import type { UpcomingEvent } from '../../types';
import { Card, SectionHd } from '../primitives';

interface DayBucket {
  date: Date;
  iso: string;
  out: UpcomingEvent[];
  back: UpcomingEvent[];
}

function buildDays(events: UpcomingEvent[]): DayBucket[] {
  const days: DayBucket[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < 14; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const iso = d.toISOString().split('T')[0];
    days.push({ date: d, iso, out: [], back: [] });
  }
  for (const ev of events) {
    const evDate = new Date(ev.event_date);
    evDate.setHours(0, 0, 0, 0);
    const iso = evDate.toISOString().split('T')[0];
    const day = days.find(d => d.iso === iso);
    if (!day) continue;
    if (ev.event_type === 'departure') day.out.push(ev);
    else day.back.push(ev);
  }
  return days;
}

function fmtDOW(d: Date): string {
  return d.toLocaleDateString('en-GB', { weekday: 'short' }).toUpperCase();
}
function fmtDay(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric' });
}
function fmtFull(d: Date): string {
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
function isToday(d: Date): boolean {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return d.getTime() === t.getTime();
}

export default function ComingUp({ data }: DashboardSectionProps) {
  const days = useMemo(() => buildDays(data.upcoming_events || []), [data.upcoming_events]);
  const [selected, setSelected] = useState<string>(() => days[0]?.iso || '');

  const max = Math.max(1, ...days.map(d => Math.max(d.out.length, d.back.length)));

  const selectedDay = days.find(d => d.iso === selected) || days[0];

  return (
    <Card as="section">
      <SectionHd
        eyebrow="Coming Up"
        title="Next 14 days"
        sub="Tap any day to focus."
        action={<Link to="/jobs" className="text-xs font-medium" style={{ color: 'var(--op-purple)' }}>View all jobs →</Link>}
      />

      {/* Heat strip — 7 cols on mobile, 14 on tablet+ */}
      <div className="op-heatstrip">
        {days.map((d) => {
          const isSel = d.iso === selected;
          const isT = isToday(d.date);
          return (
            <button
              key={d.iso}
              onClick={() => setSelected(d.iso)}
              className={`flex flex-col items-stretch text-left rounded-md p-2 transition border ${
                isSel ? 'border-purple-300 bg-purple-50' : 'border-transparent hover:bg-gray-50'
              }`}
            >
              <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 leading-tight">
                {fmtDOW(d.date)}
              </div>
              <div className={`op-num text-base font-semibold leading-tight ${isT ? 'text-purple-700' : 'text-gray-900'}`}>
                {fmtDay(d.date)}
              </div>
              {/* Stacked bars */}
              <div className="mt-2 flex items-end gap-0.5 h-6">
                <div
                  className="flex-1 rounded-sm"
                  style={{
                    background: 'var(--op-purple)',
                    height: `${(d.out.length / max) * 100}%`,
                    minHeight: d.out.length > 0 ? 2 : 0,
                  }}
                  title={`${d.out.length} going out`}
                />
                <div
                  className="flex-1 rounded-sm"
                  style={{
                    background: 'var(--op-green)',
                    height: `${(d.back.length / max) * 100}%`,
                    minHeight: d.back.length > 0 ? 2 : 0,
                  }}
                  title={`${d.back.length} returning`}
                />
              </div>
              <div className="text-[10px] text-gray-400 mt-1 op-num">
                {d.out.length + d.back.length || '—'}
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-3 text-[11px] text-gray-500 mt-3">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block rounded-sm" style={{ width: 8, height: 8, background: 'var(--op-purple)' }} />
          Going out
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block rounded-sm" style={{ width: 8, height: 8, background: 'var(--op-green)' }} />
          Returning
        </span>
      </div>

      {/* Day detail */}
      {selectedDay && (selectedDay.out.length + selectedDay.back.length > 0) && (
        <div className="mt-5 pt-4 border-t" style={{ borderColor: 'var(--op-border)' }}>
          <div className="text-sm font-medium mb-3">
            {fmtFull(selectedDay.date)}
            <span className="text-gray-500 font-normal ml-2">
              {selectedDay.out.length} going out · {selectedDay.back.length} returning
            </span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-sm">
            <div>
              <div className="op-eyebrow mb-2" style={{ color: 'var(--op-purple)' }}>Going Out</div>
              {selectedDay.out.length === 0 ? (
                <div className="text-gray-500 text-sm">—</div>
              ) : (
                <ul className="space-y-1">
                  {selectedDay.out.map(ev => (
                    <li key={`out-${ev.id}`}>
                      <Link to={`/jobs/${ev.id}`} className="hover:text-purple-700">
                        ▸ {ev.client_name || ev.company_name || 'Unknown'} — {ev.job_name || 'Untitled'}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="op-eyebrow mb-2" style={{ color: 'var(--op-green)' }}>Returning</div>
              {selectedDay.back.length === 0 ? (
                <div className="text-gray-500 text-sm">—</div>
              ) : (
                <ul className="space-y-1">
                  {selectedDay.back.map(ev => (
                    <li key={`back-${ev.id}`}>
                      <Link to={`/jobs/${ev.id}`} className="hover:text-green-700">
                        ◂ {ev.client_name || ev.company_name || 'Unknown'} — {ev.job_name || 'Untitled'}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
