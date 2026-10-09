/**
 * "Me" — one destination for the three personal pages.
 *
 * My Time, My Documents and My Profile were three separate items in the avatar
 * menu answering the same question ("my stuff"), which made the menu long and
 * made none of them easy to find. They are now tabs on one page.
 *
 * THE PAGES THEMSELVES ARE UNTOUCHED. Each is a prop-less default export, so
 * this is a shell that mounts them — not a rewrite. That keeps the change cheap
 * and reversible, and means a later visual pass has one place to restyle.
 *
 * The old paths (/staff/me, /staff/documents, /profile) still work and redirect
 * here. They are NOT decorative: `notifications.action_url` holds them for rows
 * already in the database, and emails already in people's inboxes link to them.
 * Removing them would break links we have already sent.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { displayFirstName, displayInitials } from '../lib/displayName';
import MyTimePage from './MyTimePage';
import MyTasksPage, { countDueNow } from './MyTasksPage';
import MyReviewPage from './MyReviewPage';
import StaffDocumentsPage, { countDocsWaiting } from './StaffDocumentsPage';
import ProfilePage from './ProfilePage';

// To Do first and the default (jon, Sep 2026): it's the daily one. Every old
// link names its tab explicitly (/staff/me → ?tab=time), so moving the default
// strands nothing.
const TABS = [
  { id: 'todo', label: 'To Do' },
  { id: 'time', label: 'My Time' },
  // Only when there IS one — a review is a once-a-year thing and does not earn
  // permanent space beside the tabs people use weekly. The notification that
  // announces a review links straight here, so it is never the only way in.
  { id: 'review', label: 'My Review' },
  { id: 'documents', label: 'Documents' },
  { id: 'profile', label: 'Profile' },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** Today in the person's own timezone — see localIso() in MyTimePage. */
function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function MePage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const active: TabId = TABS.some(t => t.id === raw) ? (raw as TabId) : 'todo';

  // One cheap call decides whether the review tab is shown at all. Failure is
  // silent and simply hides it: this is decoration on a page whose other four
  // tabs must keep working regardless.
  const [hasReview, setHasReview] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.get<{ data: unknown | null }>('/staff-calendar/me/review')
      .then(res => { if (!cancelled) setHasReview(!!res.data); })
      .catch(() => { /* no review, or no staff record — either way, no tab */ });
    return () => { cancelled = true; };
  }, []);

  // Counts on the tabs: to-dos due today or overdue, and documents waiting to
  // be signed or confirmed. Refetched when the tab changes, so ticking things
  // off and moving on leaves the badge right. Decoration only — a failure
  // hides the badge rather than showing a wrong number. The rules for what
  // counts live beside each page (countDueNow / countDocsWaiting) so the badge
  // and the page cannot disagree.
  const [badges, setBadges] = useState<{ todo: number; documents: number }>({ todo: 0, documents: 0 });
  useEffect(() => {
    let cancelled = false;
    const today = localToday();
    api.get<{ data: Parameters<typeof countDueNow>[0] }>('/staff-tasks/mine')
      .then(res => { if (!cancelled) setBadges(b => ({ ...b, todo: countDueNow(res.data ?? [], today) })); })
      .catch(() => { if (!cancelled) setBadges(b => ({ ...b, todo: 0 })); });
    api.get<{ data: Parameters<typeof countDocsWaiting>[0] }>('/staff-documents/mine')
      .then(res => { if (!cancelled) setBadges(b => ({ ...b, documents: countDocsWaiting(res.data) })); })
      .catch(() => { if (!cancelled) setBadges(b => ({ ...b, documents: 0 })); });
    return () => { cancelled = true; };
  }, [active]);

  // On a phone the tab strip scrolls sideways; keep the active tab in view.
  // Set scrollLeft directly rather than scrollIntoView, which also scrolls the
  // PAGE, and only when the active tab or the strip's width changes, so it
  // never fights somebody scrolling the strip themselves.
  const navRef = useRef<HTMLElement>(null);
  const [navWidth, setNavWidth] = useState(0);
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setNavWidth(nav.clientWidth));
    ro.observe(nav);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const nav = navRef.current;
    const btn = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !btn || nav.scrollWidth <= nav.clientWidth) return;
    // The nav is `relative`, so offsetLeft is already measured from its edge.
    nav.scrollLeft = Math.max(0, btn.offsetLeft - 8);
    // hasReview and the badges too: the review tab and the counts arrive a
    // moment after mount and widen the strip, pushing the active tab out of view.
  }, [active, navWidth, hasReview, badges.todo, badges.documents]);

  // Always show it when it is the tab being asked for, so the notification's
  // deep link cannot land on a tab that has been hidden.
  const tabs = TABS.filter(t => t.id !== 'review' || hasReview || active === 'review');

  // In the URL rather than in state, so a notification or an email can deep-link
  // straight to the right tab and a browser Back button behaves.
  function select(tab: TabId) {
    const next = new URLSearchParams(params);
    next.set('tab', tab);
    setParams(next, { replace: true });
  }

  const user = useAuthStore(s => s.user);
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening';
  const today = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div className="flex items-center gap-3 min-w-0">
          <div className="hidden sm:flex w-12 h-12 shrink-0 rounded-full bg-ooosh-600 text-white items-center justify-center text-[17px] font-semibold">
            {displayInitials(user)}
          </div>
          <div className="min-w-0">
            <h1 className="text-[21px] sm:text-2xl font-semibold text-gray-900 tracking-[-0.01em]">
              {greeting}, {displayFirstName(user)}
            </h1>
            <p className="mt-0.5 text-sm text-gray-500">{today} · your time, documents and profile</p>
          </div>
        </div>

        {/* A segmented control on a desktop; on a phone the same buttons become
            a strip of pills that scrolls sideways rather than wrapping. */}
        <nav aria-label="Me" ref={navRef}
          className="relative w-full sm:w-auto flex gap-1.5 sm:gap-1 overflow-x-auto scrollbar-hide sm:bg-white sm:border sm:border-gray-200 sm:rounded-[10px] sm:p-1">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => select(t.id)}
              aria-current={active === t.id ? 'page' : undefined}
              className={`shrink-0 whitespace-nowrap px-3 py-[7px] sm:px-3.5 sm:py-2 rounded-full sm:rounded-[7px] text-[13px] sm:text-sm transition-colors ${
                active === t.id
                  ? 'bg-ooosh-600 text-white font-semibold'
                  : 'bg-white sm:bg-transparent border border-gray-200 sm:border-0 text-gray-600 font-medium hover:text-gray-900 sm:hover:bg-gray-50'
              }`}
            >
              {t.label}
              {(t.id === 'todo' || t.id === 'documents') && badges[t.id] > 0 && (
                <span className={`ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[11px] font-bold ${
                  active === t.id ? 'bg-white text-ooosh-600' : 'bg-amber-100 text-amber-800'}`}>
                  {badges[t.id]}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* Mounted, not routed: switching tabs must not remount the whole page or
          each one would refetch every time you glance at another. */}
      {active === 'time' && <MyTimePage />}
      {active === 'todo' && <MyTasksPage />}
      {active === 'review' && <MyReviewPage />}
      {active === 'documents' && <StaffDocumentsPage />}
      {active === 'profile' && <ProfilePage />}
    </div>
  );
}
