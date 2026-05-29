import type { ComponentType } from 'react';
import type { OperationsData, BacklineOverview } from '../types';

/**
 * Dashboard section registry.
 *
 * Each section is registered once; the page composer walks this array (after
 * applying the user's saved ordering, if any) and renders sections in order.
 *
 * ──────────────────────────────────────────────────────────────────────
 *  Adding a new section (e.g. "Carnets due", "Open damage cases", etc.):
 *
 *  1. Build the component as a self-contained block under
 *     frontend/src/components/dashboard/v2/sections/<YourSection>.tsx.
 *     It accepts `DashboardSectionProps` and renders inside `<section>`.
 *
 *  2. Add a SectionId entry, then push to SECTIONS below with:
 *       defaultOrder — where it sits in the default page order
 *       pinnable     — whether the user can reorder it
 *       width        — 'full' or 'half' (used by future drag UI)
 *
 *  3. If the section produces "needs human action" rows (overdue carnets,
 *     unresolved damage, etc.) — add a bucket to NeedsAttention rather than
 *     building a parallel "things to action" surface. All overdue signals
 *     funnel through Needs Attention.
 *
 *  4. If the new module has its own per-job state that should appear in the
 *     Today block's progress strip (e.g. a 'carnet' status pip), update the
 *     STRIP_MAPPING in backend/src/services/job-progress-strip.ts and add
 *     the new ProgressStripCategory key.
 * ──────────────────────────────────────────────────────────────────────
 */

export type SectionId = 'needs' | 'ontoday' | 'today' | 'up' | 'ops' | 'pipeline' | 'activity';

export interface DashboardSectionProps {
  data: OperationsData;
  backline: BacklineOverview | null;
  refresh: () => void;
}

export interface DashboardSection {
  id: SectionId;
  title: string;
  component: ComponentType<DashboardSectionProps>;
  defaultOrder: number;
  pinnable: boolean;
  width: 'full' | 'half';
}

/**
 * Apply a user's saved section order to the registry. `needs` is always first
 * regardless of preferences (it's the most action-critical block).
 */
export function applyOrder(sections: DashboardSection[], userOrder: string[] | null): DashboardSection[] {
  if (!userOrder || userOrder.length === 0) {
    return [...sections].sort((a, b) => a.defaultOrder - b.defaultOrder);
  }
  const index = new Map(sections.map(s => [s.id as string, s]));
  const ordered: DashboardSection[] = [];
  // Pin needs first
  const needs = index.get('needs');
  if (needs) { ordered.push(needs); index.delete('needs'); }
  // Then user-selected order (skip unknown ids)
  for (const id of userOrder) {
    const s = index.get(id);
    if (s && s.id !== 'needs') { ordered.push(s); index.delete(id); }
  }
  // Then any newly-added sections the user hasn't seen yet (in default order)
  const remaining = Array.from(index.values()).sort((a, b) => a.defaultOrder - b.defaultOrder);
  return [...ordered, ...remaining];
}
