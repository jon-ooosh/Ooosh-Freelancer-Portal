import { useEffect, useState } from 'react';
import { api } from '../../services/api';

/**
 * What the capture form's Jobs table says about each job: the quote, what's
 * been spent so far, and whether it recharges its running costs (which sets the
 * "who pays" default for fuel, parking and travel). One fetch per job, kept for
 * as long as the form is open. Costs so far leave out the cost being edited.
 */
export interface JobInfo {
  loaded: boolean;
  /** What the client was quoted (transport & crew quotes). */
  clientQuoted: number;
  hasQuotes: boolean;
  /** Everything already on the job (its share of split costs), before this one. */
  costsSoFar: number;
  rechargesRunningCosts: boolean;
  /** The quote's expenses marked to recharge ("Fuel", "Tolls"…). */
  rechargeExpected: string[];
}

const EXP_LABELS: Record<string, string> = {
  fuel: 'Fuel', parking: 'Parking', tolls: 'Tolls', transport_out: 'Transport', transport_back: 'Transport',
  hotel: 'Hotel', pd: 'Per Diem', other: 'Other',
};

type QuoteRow = {
  client_fee: number | null; status: string | null;
  expenses?: Array<{ type?: string; chargeMode?: string; includedInCharge?: boolean }> | string;
};

export function useJobInfo(jobIds: string[], excludeCostId: string | null): Record<string, JobInfo> {
  const [info, setInfo] = useState<Record<string, JobInfo>>({});
  const key = [...new Set(jobIds)].sort().join(',');

  useEffect(() => {
    const wanted = key ? key.split(',') : [];
    const missing = wanted.filter((id) => !info[id]);
    if (!missing.length) return;
    // Mark them as asked for, so a re-render doesn't ask twice.
    setInfo((prev) => {
      const next = { ...prev };
      for (const id of missing) next[id] = { loaded: false, clientQuoted: 0, hasQuotes: true, costsSoFar: 0, rechargesRunningCosts: false, rechargeExpected: [] };
      return next;
    });
    for (const jobId of missing) {
      Promise.all([
        api.get<{ data: QuoteRow[] }>(`/quotes?job_id=${jobId}`).catch(() => ({ data: [] as QuoteRow[] })),
        api.get<{ data: Array<{ id: string; amount_gross: number | null }>; recharge_running_costs?: boolean }>(`/costs/by-job/${jobId}`)
          .catch(() => ({ data: [] as Array<{ id: string; amount_gross: number | null }>, recharge_running_costs: false })),
      ]).then(([quotesRes, costsRes]) => {
        const quotes = (quotesRes.data || []).filter((q) => q.status !== 'cancelled');
        const recharge = new Set<string>();
        for (const q of quotes) {
          let arr: Array<{ type?: string; chargeMode?: string; includedInCharge?: boolean }> = [];
          try { arr = Array.isArray(q.expenses) ? q.expenses : (typeof q.expenses === 'string' && q.expenses ? JSON.parse(q.expenses) : []); } catch { arr = []; }
          for (const e of arr) {
            const mode = e?.chargeMode ?? (e?.includedInCharge === false ? 'not_included' : 'included');
            if (mode === 'recharge') recharge.add(EXP_LABELS[String(e?.type)] || String(e?.type || 'Other'));
          }
        }
        const costs = (costsRes.data || []).filter((c) => c.id !== excludeCostId);
        setInfo((prev) => ({
          ...prev,
          [jobId]: {
            loaded: true,
            clientQuoted: quotes.reduce((s, q) => s + Number(q.client_fee || 0), 0),
            hasQuotes: quotes.length > 0,
            costsSoFar: Math.round(costs.reduce((s, c) => s + Number(c.amount_gross || 0), 0) * 100) / 100,
            rechargesRunningCosts: costsRes.recharge_running_costs === true,
            rechargeExpected: [...recharge],
          },
        }));
      });
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return info;
}
