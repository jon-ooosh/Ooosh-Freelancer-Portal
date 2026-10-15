import { useEffect, useState } from 'react';
import { api } from '../services/api';

/**
 * Which of an address-book record's "secondary" tabs have anything in them.
 *
 * Asks each tab's OWN endpoint (the same one the tab loads) rather than a
 * separate count route, so "has content" can't drift from what the tab shows.
 * true = has rows, false = empty, missing key = still loading / failed.
 *
 * Used only to decide whether a tab sits in the main row or under "More" — an
 * empty tab is never hidden outright (see components/EntityTabs.tsx), so a
 * wrong answer here can't make data unreachable.
 */
export type TabPresence = Partial<Record<string, boolean>>;

type Probe = [tab: string, url: string, has: (r: any) => boolean];

const rows = (r: any) => Array.isArray(r?.data) && r.data.length > 0;

function probesFor(entity: 'person' | 'organisation', id: string, opts: { pcn?: boolean }): Probe[] {
  if (entity === 'organisation') {
    return [
      ['excess', `/excess/by-org/${id}`, (r) => (r?.history || []).length > 0],
      ['issues', `/problems/by-organisation/${id}`, rows],
      ['held', `/holding/by-org/${id}`, rows],
      ['storage', `/storage/by-organisation/${id}`, (r) => (r?.data?.tenancies || []).length + (r?.data?.waiting || []).length > 0],
      ['rehearsal', `/rehearsals/profile/${id}`, (r) => !!r?.data],
      ['pcns', `/pcns/by-org/${id}`, rows],
      ['ooh', `/ooh-return/by-organisation/${id}`, (r) => (r?.data?.totalIncidents || 0) > 0],
    ];
  }
  return [
    ['excess', `/excess/by-person/${id}`, (r) => (r?.history || []).length > 0],
    ['held', `/holding/by-person/${id}`, rows],
    ['storage', `/storage/by-person/${id}`, (r) => (r?.data?.tenancies || []).length + (r?.data?.waiting || []).length > 0],
    ...(opts.pcn ? [['pcn', `/pcns/by-person/${id}`, rows] as Probe] : []),
  ];
}

export function useTabPresence(entity: 'person' | 'organisation', id: string | undefined, opts: { pcn?: boolean } = {}): TabPresence {
  const [presence, setPresence] = useState<TabPresence>({});
  const pcn = !!opts.pcn;

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    for (const [tab, url, has] of probesFor(entity, id, { pcn })) {
      api.get<any>(url)
        .then((r) => { if (!cancelled) setPresence((cur) => ({ ...cur, [tab]: has(r) })); })
        .catch(() => { /* unknown → the tab stays under More, still reachable */ });
    }
    return () => { cancelled = true; };
  }, [entity, id, pcn]);

  return presence;
}
