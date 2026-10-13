/**
 * CloseOutSignpost — what the Overview's Post-Hire › Invoice card shows now the
 * close-out lives on the Money tab (redesign, Oct 2026). One pill, one line, the
 * five steps as a thin bar, and "Open in Money →". No actions of its own: the Money
 * panel is the one place things are done, so the two can't drift apart.
 */
import { useEffect, useState } from 'react';
import { useAuthStore } from '../hooks/useAuthStore';
import { hasManagerRole } from '../lib/roles';
import { CloseOutPlan, loadCloseOutPlan, subscribeCloseOutPlan, closeOutView, shortLine, TONE, money } from '../lib/closeOutPlan';

export default function CloseOutSignpost({ jobId, onOpenMoney }: { jobId: string; onOpenMoney?: () => void }) {
  const isManager = hasManagerRole(useAuthStore(s => s.user)?.role);
  const [plan, setPlan] = useState<CloseOutPlan | null>(null);

  useEffect(() => {
    const unsub = subscribeCloseOutPlan(jobId, setPlan);
    loadCloseOutPlan(jobId).then(setPlan).catch(() => undefined);
    return unsub;
  }, [jobId]);

  if (!plan) return <div className="mt-1 text-xs text-gray-400">Reading HireHop…</div>;
  const view = closeOutView(plan, { isManager });

  const parts: string[] = [];
  if (plan.invoices.length === 1) parts.push(plan.invoices[0].number);
  else if (plan.invoices.length > 1) parts.push(`${plan.invoices.length} invoices`);
  if (view.stage === 'blocked') parts.push(shortLine(view.blockers[0]));
  else if (view.owing >= 0.005) parts.push(`${money(view.owing)} due`);
  else if (view.credit >= 0.005) parts.push(`${money(view.credit)} in credit`);
  parts.push(`${view.stepsDone} of 5 steps`);

  return (
    <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`font-semibold px-2 py-0.5 rounded-full ${TONE[view.tone].pill}`}>{view.pill}</span>
          <span className="text-gray-600">{parts.join(' · ')}</span>
        </div>
        <div className="mt-1.5 grid grid-cols-5 gap-1 w-40">
          {view.steps.map((st, i) => (
            <i key={i} className={`h-1 rounded ${st === 'done' ? 'bg-green-500' : st === 'error' ? 'bg-red-500' : st === 'warn' ? 'bg-amber-400' : st === 'current' ? 'bg-ooosh-300' : 'bg-gray-200'}`} />
          ))}
        </div>
      </div>
      {onOpenMoney && (
        <button onClick={onOpenMoney} className="text-xs font-semibold text-ooosh-600 hover:text-ooosh-800">Open in Money →</button>
      )}
    </div>
  );
}
