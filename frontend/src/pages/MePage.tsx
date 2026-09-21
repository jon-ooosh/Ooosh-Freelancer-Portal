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
import { useSearchParams } from 'react-router-dom';
import MyTimePage from './MyTimePage';
import StaffDocumentsPage from './StaffDocumentsPage';
import ProfilePage from './ProfilePage';

const TABS = [
  { id: 'time', label: 'My Time' },
  { id: 'documents', label: 'Documents' },
  { id: 'profile', label: 'Profile' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function MePage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const active: TabId = TABS.some(t => t.id === raw) ? (raw as TabId) : 'time';

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
          {TABS.map(t => (
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
      {active === 'documents' && <StaffDocumentsPage />}
      {active === 'profile' && <ProfilePage />}
    </div>
  );
}
