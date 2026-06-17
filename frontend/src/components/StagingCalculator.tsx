/**
 * Staging Calculator — OP-native wrappers around the embedded vanilla-JS tool.
 *
 * StagingCalculatorModal: full-screen modal hosting the calculator in an iframe
 *   (served same-origin from /staging-calculator.html). On a successful push the
 *   embedded app posts a `staging-complete` message; we surface it to the parent
 *   so it can reveal the Staging tab.
 *
 * StagingTab: appears on Job Detail only once a staging plan exists. Lists each
 *   plan's 3D preview short-link with Copy + Open + Share-with-freelancer + Delete.
 */
import { useEffect, useState, useCallback } from 'react';
import { api } from '../services/api';

export interface StagingPlan {
  id: string;
  job_id: string | null;
  hh_job_number: number | null;
  slug: string;
  summary: string | null;
  three_d_url: string | null;
  share_with_freelancer: boolean;
  created_at: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Modal — embeds the calculator
// ─────────────────────────────────────────────────────────────────────────

export function StagingCalculatorModal({
  hhJobNumber,
  onClose,
  onComplete,
}: {
  hhJobNumber: number | null | undefined;
  onClose: () => void;
  onComplete: (planId: string | null) => void;
}) {
  const src = hhJobNumber ? `/staging-calculator.html?job=${hhJobNumber}` : '/staging-calculator.html';

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      if (e.data && e.data.type === 'staging-complete') {
        onComplete(e.data.planId ?? null);
      }
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('message', onMessage);
    };
  }, [onClose, onComplete]);

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex flex-col" role="dialog" aria-modal="true">
      <div className="flex items-center justify-between bg-white px-4 py-2 border-b border-gray-200">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
          <span className="text-base">🏗️</span>
          Staging Calculator{hhJobNumber ? ` — Job #${hhJobNumber}` : ''}
        </div>
        <button
          onClick={onClose}
          className="px-3 py-1.5 text-sm rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700"
        >
          Close ✕
        </button>
      </div>
      <iframe
        title="Staging Calculator"
        src={src}
        className="flex-1 w-full bg-white"
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Tab — lists the saved 3D plans
// ─────────────────────────────────────────────────────────────────────────

export function StagingTab({ jobId }: { jobId: string }) {
  const [plans, setPlans] = useState<StagingPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ data: StagingPlan[] }>(`/staging/plans/${jobId}`);
      setPlans(res.data || []);
    } catch {
      setPlans([]);
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => { load(); }, [load]);

  async function toggleShare(plan: StagingPlan) {
    const next = !plan.share_with_freelancer;
    setPlans((p) => p.map((x) => (x.id === plan.id ? { ...x, share_with_freelancer: next } : x)));
    try {
      await api.patch(`/staging/plans/${plan.id}`, { share_with_freelancer: next });
    } catch {
      // revert on failure
      setPlans((p) => p.map((x) => (x.id === plan.id ? { ...x, share_with_freelancer: !next } : x)));
    }
  }

  async function remove(plan: StagingPlan) {
    if (!window.confirm('Delete this staging plan? The 3D preview link will stop working. Items already added to HireHop are not affected.')) return;
    try {
      await api.delete(`/staging/plans/${plan.id}`);
      setPlans((p) => p.filter((x) => x.id !== plan.id));
    } catch {
      window.alert('Failed to delete staging plan.');
    }
  }

  async function copy(plan: StagingPlan) {
    if (!plan.three_d_url) return;
    try {
      await navigator.clipboard.writeText(plan.three_d_url);
      setCopiedId(plan.id);
      setTimeout(() => setCopiedId((c) => (c === plan.id ? null : c)), 2000);
    } catch {
      window.prompt('Copy this link:', plan.three_d_url);
    }
  }

  if (loading) return <div className="text-sm text-gray-500 p-4">Loading staging plans…</div>;

  if (plans.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
        <p className="text-gray-500 text-sm">No staging plans yet.</p>
        <p className="text-gray-400 text-xs mt-1">Run the Staging Calculator from the Job Requirements tab — the 3D preview link will appear here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {plans.map((plan) => (
        <div key={plan.id} className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-base">🏗️</span>
                <span className="font-medium text-gray-900">{plan.summary || 'Staging plan'}</span>
                {plan.share_with_freelancer && (
                  <span className="text-[11px] font-semibold text-green-700 bg-green-100 rounded px-1.5 py-0.5">Shared</span>
                )}
              </div>
              <div className="text-xs text-gray-400 mt-0.5">
                Created {new Date(plan.created_at).toLocaleDateString('en-GB')}
              </div>
              {plan.three_d_url && (
                <a
                  href={plan.three_d_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block mt-2 text-sm text-ooosh-600 hover:underline break-all"
                >
                  {plan.three_d_url}
                </a>
              )}
            </div>
            <button
              onClick={() => remove(plan)}
              className="text-gray-300 hover:text-red-500 text-lg leading-none flex-shrink-0"
              title="Delete staging plan"
            >
              ✕
            </button>
          </div>

          <div className="flex flex-wrap gap-2 mt-3">
            {plan.three_d_url && (
              <>
                <a
                  href={plan.three_d_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 text-sm rounded-lg bg-ooosh-600 text-white hover:bg-ooosh-700"
                >
                  🧊 Open 3D preview
                </a>
                <button
                  onClick={() => copy(plan)}
                  className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
                >
                  {copiedId === plan.id ? '✅ Copied!' : '📋 Copy link'}
                </button>
              </>
            )}
            <button
              onClick={() => toggleShare(plan)}
              className={`px-3 py-1.5 text-sm rounded-lg border ${
                plan.share_with_freelancer
                  ? 'border-green-300 text-green-700 bg-green-50 hover:bg-green-100'
                  : 'border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
              title="Share this 3D preview with freelancers (e.g. crew building the stage)"
            >
              {plan.share_with_freelancer ? '✓ Shared with freelancers' : '🔗 Share with freelancers'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
