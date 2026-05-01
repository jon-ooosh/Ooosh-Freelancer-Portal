import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DashboardSectionProps } from '../sections';
import type { ScheduleJob } from '../../types';
import { Card, ProgressBar, ProgressStrip, SectionHd } from '../primitives';
import {
  EMPTY_STRIP, JobProgressStrip, STRIP_LABELS, StripPhase, stripPercent,
} from '../progress-strip';
import { api } from '../../../../services/api';

function formatTime(t: string | null | undefined): string {
  if (!t) return '—';
  return t.slice(0, 5);
}

function jobLine(j: ScheduleJob): string {
  const number = j.hh_job_number ? `#${j.hh_job_number} ` : '';
  const name = j.job_name || j.client_name || 'Untitled';
  return `${number}${j.client_name ?? j.company_name ?? ''} — ${name}`.replace(/^ — /, '');
}

function JobRow({
  job, phase, strip,
}: { job: ScheduleJob; phase: StripPhase; strip: JobProgressStrip }) {
  const pct = stripPercent(strip);
  const labels = STRIP_LABELS[phase];
  const time = phase === 'pre_hire' ? formatTime(job.out_time) : formatTime(job.return_time);
  return (
    <div className="grid grid-cols-[60px_1fr_120px] gap-3 py-3 border-t" style={{ borderColor: 'var(--op-border)' }}>
      <div className="op-num text-sm font-medium text-gray-700 pt-0.5">{time}</div>
      <div>
        <Link
          to={`/jobs/${job.id}`}
          className="block text-sm font-medium text-gray-900 hover:text-purple-700 transition leading-tight"
        >
          {jobLine(job)}
        </Link>
        {job.venue_name && (
          <div className="text-xs text-gray-500 mt-0.5">{job.venue_name}</div>
        )}
        <div className="mt-2">
          <ProgressStrip strip={strip} labels={labels} />
        </div>
      </div>
      <div className="pt-2">
        <ProgressBar
          done={pct.done}
          wip={pct.wip}
          total={pct.total}
          color={pct.pct >= 100 ? 'green' : pct.wip > 0 ? 'amber' : 'green'}
        />
      </div>
    </div>
  );
}

export default function Today({ data }: DashboardSectionProps) {
  const goingOut = data.today.going_out;
  const returning = data.today.returning;

  const [strips, setStrips] = useState<Record<string, JobProgressStrip>>({});

  useEffect(() => {
    const jobs = [
      ...goingOut.map(j => ({ id: j.id, phase: 'pre_hire' as const })),
      ...returning.map(j => ({ id: j.id, phase: 'post_hire' as const })),
    ];
    if (jobs.length === 0) { setStrips({}); return; }
    let cancelled = false;
    api.post<{ data: Record<string, JobProgressStrip> }>('/dashboard/job-progress', { jobs })
      .then(r => { if (!cancelled) setStrips(r.data); })
      .catch(() => { /* leave empty — strips fall back to EMPTY_STRIP */ });
    return () => { cancelled = true; };
  }, [goingOut, returning]);

  const tomorrowOut = data.tomorrow.going_out_count;
  const tomorrowBack = data.tomorrow.returning_count;

  return (
    <Card as="section">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Going Out */}
        <div>
          <SectionHd
            eyebrow={<span className="inline-flex items-center gap-2">
              <span className="inline-block rounded-full" style={{ width: 8, height: 8, background: 'var(--op-purple)' }} />
              Going Out Today
            </span>}
            action={<span className="op-num text-xs text-gray-500">{goingOut.length} jobs</span>}
          />
          {goingOut.length === 0 ? (
            <div className="text-sm text-gray-500 py-4">Nothing leaving today.</div>
          ) : (
            <div>
              {goingOut.map(j => (
                <JobRow key={j.id} job={j} phase="pre_hire" strip={strips[j.id] || EMPTY_STRIP} />
              ))}
            </div>
          )}
          <div className="flex items-center justify-between text-xs text-gray-500 pt-3 mt-3 border-t" style={{ borderColor: 'var(--op-border)' }}>
            <span>Tomorrow: {tomorrowOut} going out</span>
            <Link to="/jobs" className="font-medium" style={{ color: 'var(--op-purple)' }}>
              View full schedule →
            </Link>
          </div>
        </div>

        {/* Returning */}
        <div className="lg:border-l lg:pl-6" style={{ borderColor: 'var(--op-border)' }}>
          <SectionHd
            eyebrow={<span className="inline-flex items-center gap-2">
              <span className="inline-block rounded-full" style={{ width: 8, height: 8, background: 'var(--op-green)' }} />
              Returning Today
            </span>}
            action={<span className="op-num text-xs text-gray-500">{returning.length} jobs</span>}
          />
          {returning.length === 0 ? (
            <div className="text-sm text-gray-500 py-4">Nothing coming back today.</div>
          ) : (
            <div>
              {returning.map(j => (
                <JobRow key={j.id} job={j} phase="post_hire" strip={strips[j.id] || EMPTY_STRIP} />
              ))}
            </div>
          )}
          <div className="flex items-center justify-between text-xs text-gray-500 pt-3 mt-3 border-t" style={{ borderColor: 'var(--op-border)' }}>
            <span>Tomorrow: {tomorrowBack} coming back</span>
            <Link to="/jobs/returns" className="font-medium" style={{ color: 'var(--op-purple)' }}>
              View full schedule →
            </Link>
          </div>
        </div>
      </div>
    </Card>
  );
}
