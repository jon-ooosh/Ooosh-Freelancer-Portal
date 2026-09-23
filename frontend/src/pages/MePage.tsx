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
import MyTimePage from './MyTimePage';
import MyTasksPage from './MyTasksPage';
import MyReviewPage from './MyReviewPage';
import StaffDocumentsPage from './StaffDocumentsPage';
import ProfilePage from './ProfilePage';

const TABS = [
  { id: 'time', label: 'My Time' },
  { id: 'todo', label: 'My To Do' },
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
  const active: TabId = TABS.some(t => t.id === raw) ? (raw as TabId) : 'time';

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

  return (
    <div>
      <div className="border-b border-gray-200 mb-4">
        <nav className="flex gap-1 -mb-px" aria-label="Me">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => select(t.id)}
              aria-current={active === t.id ? 'page' : undefined}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                active === t.id
                  ? 'border-ooosh-600 text-ooosh-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
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
