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
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { displayFirstName, displayInitials } from '../lib/displayName';
import MyTimePage from './MyTimePage';
import MyTasksPage from './MyTasksPage';
import MyReviewPage from './MyReviewPage';
import StaffDocumentsPage from './StaffDocumentsPage';
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
            <h1 className="text-xl sm:text-2xl font-semibold text-gray-900 tracking-[-0.01em]">
              {greeting}, {displayFirstName(user)}
            </h1>
            <p className="mt-0.5 text-sm text-gray-500">{today} · your time, documents and profile</p>
          </div>
        </div>

        {/* A segmented control on a desktop; on a phone the same buttons become
            a strip of pills that scrolls sideways rather than wrapping. */}
        <nav aria-label="Me"
          className="w-full sm:w-auto flex gap-1.5 sm:gap-1 overflow-x-auto scrollbar-hide sm:bg-white sm:border sm:border-gray-200 sm:rounded-[10px] sm:p-1">
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
