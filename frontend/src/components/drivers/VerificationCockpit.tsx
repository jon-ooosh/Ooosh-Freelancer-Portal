/**
 * Stage tracker + "what needs doing" — the top of the driver cockpit.
 *
 * Both come straight from GET /api/drivers/:id/verification-state, which is
 * derived from the SAME validity engine the hire-form router uses. So this shows
 * staff where the driver actually is in their own journey, rather than a second
 * opinion assembled from the same columns by different rules — which is exactly
 * how the router and the staff UI came to disagree (job 16291).
 */

export type StageState = 'done' | 'todo' | 'blocked' | 'not_required';

export interface VerificationStage {
  key: string;
  label: string;
  state: StageState;
  detail: string | null;
}

export interface VerificationAction {
  severity: 'red' | 'amber' | 'info';
  message: string;
  kind: string;
  slot?: string;
}

export interface DriverVerificationState {
  stages: VerificationStage[];
  actions: VerificationAction[];
  allClear: boolean;
}

const STAGE_MARK: Record<StageState, { icon: string; ring: string; text: string }> = {
  done:         { icon: '✓', ring: 'bg-green-100 text-green-700 border-green-300', text: 'text-gray-700' },
  todo:         { icon: '○', ring: 'bg-gray-100 text-gray-400 border-gray-300',    text: 'text-gray-400' },
  blocked:      { icon: '!', ring: 'bg-amber-100 text-amber-700 border-amber-400', text: 'text-amber-800' },
  not_required: { icon: '–', ring: 'bg-gray-50 text-gray-300 border-gray-200',     text: 'text-gray-300' },
};

export function StageTracker({ stages }: { stages: VerificationStage[] }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
      <h3 className="text-sm font-semibold text-gray-700 mb-1">Hire form progress</h3>
      <p className="text-xs text-gray-400 mb-4">
        Where this driver has got to &mdash; the same view their own form is working from.
      </p>
      {/* Horizontal scroll rather than wrap: the sequence is the meaning. */}
      <div className="flex gap-1 overflow-x-auto pb-1">
        {stages.map((stage, i) => {
          const mark = STAGE_MARK[stage.state];
          return (
            <div key={stage.key} className="flex items-start gap-1 flex-shrink-0">
              <div className="flex flex-col items-center gap-1 w-[5.5rem]">
                <span className={`w-7 h-7 rounded-full border flex items-center justify-center text-sm font-semibold ${mark.ring}`}>
                  {mark.icon}
                </span>
                <span className={`text-[11px] font-medium text-center leading-tight ${mark.text}`}>
                  {stage.label}
                </span>
                {stage.detail && stage.state !== 'not_required' && (
                  <span className="text-[10px] text-gray-400 text-center leading-tight">{stage.detail}</span>
                )}
              </div>
              {i < stages.length - 1 && (
                <span className="text-gray-200 mt-3 select-none" aria-hidden>→</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const SEVERITY: Record<VerificationAction['severity'], { box: string; dot: string; label: string }> = {
  red:   { box: 'border-red-200 bg-red-50',     dot: 'text-red-600',   label: 'text-red-900' },
  amber: { box: 'border-amber-200 bg-amber-50', dot: 'text-amber-600', label: 'text-amber-900' },
  info:  { box: 'border-gray-200 bg-gray-50',   dot: 'text-gray-400',  label: 'text-gray-700' },
};

export function WhatNeedsDoing({ state, onAction }: {
  state: DriverVerificationState;
  onAction: (action: VerificationAction) => void;
}) {
  if (state.allClear && state.actions.length === 0) {
    return (
      <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
        ✓ Nothing outstanding &mdash; this driver&rsquo;s paperwork is complete and in date.
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">What needs doing?</h3>
      <ul className="space-y-2">
        {state.actions.map((action, i) => {
          const tone = SEVERITY[action.severity];
          const actionable = action.kind !== 'none';
          return (
            <li key={i} className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 ${tone.box}`}>
              <span className={`text-sm ${tone.dot}`} aria-hidden>
                {action.severity === 'red' ? '✕' : action.severity === 'amber' ? '⚠' : 'ℹ'}
              </span>
              <span className={`text-sm flex-1 min-w-[12rem] ${tone.label}`}>{action.message}</span>
              {actionable && (
                <button
                  type="button"
                  onClick={() => onAction(action)}
                  className="text-xs font-medium text-ooosh-700 hover:text-ooosh-800 underline whitespace-nowrap"
                >
                  {ACTION_LABEL[action.kind] || 'Go to it'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = {
  compare_identity: 'Compare photos',
  set_date: 'Add the date',
  replace_document: 'Replace document',
  send_hire_form: 'Send hire form',
  resolve_referral: 'Resolve referral',
};
