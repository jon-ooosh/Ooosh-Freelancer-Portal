import { useState, useRef, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../hooks/useAuthStore';
import GlobalSearch from './GlobalSearch';
import NotificationBell from './NotificationBell';

interface NavItem {
  path: string;
  label: string;
  children?: { path: string; label: string; roles?: string[] }[];
}

const navItems: NavItem[] = [
  {
    path: '/address-book',
    label: 'Address Book',
    children: [
      { path: '/people', label: 'People' },
      { path: '/organisations', label: 'Organisations' },
      { path: '/venues', label: 'Venues' },
      { path: '/data-cleanup', label: 'Data Cleanup', roles: ['admin', 'manager'] },
    ],
  },
  {
    path: '/jobs-menu',
    label: 'Jobs',
    children: [
      { path: '/pipeline?newEnquiry=1', label: 'New Enquiry' },
      { path: '/pipeline', label: 'Enquiries' },
      { path: '/jobs', label: 'Upcoming & Out Now' },
    ],
  },
  {
    path: '/operations-menu',
    label: 'Operations',
    children: [
      { path: '/operations/transport', label: 'Crew & Transport' },
    ],
  },
  {
    path: '/vehicles-menu',
    label: 'Vehicles',
    children: [
      { path: '/vehicles', label: 'Dashboard' },
      { path: '/drivers', label: 'Drivers' },
      { path: '/vehicles/fleet', label: 'Fleet' },
      { path: '/vehicles/allocations', label: 'Allocations' },
      { path: '/vehicles/prep', label: 'Prep' },
      { path: '/vehicles/issues', label: 'Issues' },
      { path: '/vehicles/fleet-map', label: 'Fleet Map' },
      { path: '/vehicles/settings', label: 'Settings' },
    ],
  },
];

function NavDropdown({ item, isActive, userRole }: { item: NavItem; isActive: boolean; userRole?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const visibleChildren = item.children?.filter(c => !c.roles || (userRole && c.roles.includes(userRole)));

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`px-3 py-1.5 rounded text-sm font-medium transition-colors flex items-center gap-1 ${
          isActive
            ? 'bg-ooosh-600 text-white'
            : 'text-ooosh-100 hover:bg-ooosh-700 hover:text-white'
        }`}
      >
        {item.label}
        <svg className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && visibleChildren && visibleChildren.length > 0 && (
        <div className="absolute top-full left-0 mt-1 w-48 max-h-[70vh] overflow-y-auto bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
          {visibleChildren.map((child) => (
            <Link
              key={child.path}
              to={child.path}
              onClick={() => setOpen(false)}
              className="block px-4 py-2 text-sm text-gray-700 hover:bg-ooosh-50 hover:text-ooosh-700 transition-colors"
            >
              {child.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function UserAvatar({ size = 'sm' }: { size?: 'sm' | 'md' | 'lg' }) {
  const user = useAuthStore((s) => s.user);
  const sizeClasses = { sm: 'w-7 h-7 text-xs', md: 'w-9 h-9 text-sm', lg: 'w-16 h-16 text-xl' };
  const initials = `${user?.first_name?.[0] || ''}${user?.last_name?.[0] || ''}`.toUpperCase();

  if (user?.avatar_url) {
    return (
      <img
        src={`/api/files/download?key=${encodeURIComponent(user.avatar_url)}`}
        alt={`${user.first_name} ${user.last_name}`}
        className={`${sizeClasses[size]} rounded-full object-cover ring-2 ring-ooosh-400`}
      />
    );
  }

  return (
    <div className={`${sizeClasses[size]} rounded-full bg-ooosh-600 flex items-center justify-center font-semibold text-white ring-2 ring-ooosh-400`}>
      {initials}
    </div>
  );
}

function UserMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const isAdmin = user?.role === 'admin' || user?.role === 'manager';

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-2 py-1 rounded hover:bg-ooosh-700 transition-colors"
      >
        <UserAvatar size="sm" />
        <span className="hidden sm:inline text-sm text-ooosh-100 max-w-[120px] truncate">
          {user?.first_name}
        </span>
        <svg className={`hidden sm:block w-3 h-3 text-ooosh-300 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-56 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
          {/* User info header */}
          <div className="px-4 py-3 border-b border-gray-100">
            <p className="text-sm font-medium text-gray-900">{user?.first_name} {user?.last_name}</p>
            <p className="text-xs text-gray-500 truncate">{user?.email}</p>
          </div>

          {/* Menu items */}
          <button
            onClick={() => { setOpen(false); navigate('/profile'); }}
            className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-ooosh-50 hover:text-ooosh-700 transition-colors flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            My Profile
          </button>

          {isAdmin && (
            <button
              onClick={() => { setOpen(false); navigate('/settings'); }}
              className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-ooosh-50 hover:text-ooosh-700 transition-colors flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Settings
            </button>
          )}

          <div className="border-t border-gray-100 my-1" />

          <button
            onClick={() => { setOpen(false); logout(); }}
            className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  function isItemActive(item: NavItem): boolean {
    if (item.children) {
      return item.children.some((child) => {
        const childPath = child.path.split('?')[0]; // Strip query params for matching
        return location.pathname === childPath || location.pathname.startsWith(childPath + '/');
      });
    }
    const itemPath = item.path.split('?')[0];
    return location.pathname === itemPath || (itemPath !== '/' && location.pathname.startsWith(itemPath));
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top nav */}
      <header className="bg-ooosh-800 text-white shadow-lg relative z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            <div className="flex items-center gap-6">
              <Link to="/" className="flex items-center gap-2">
                <img src="/favicon-32x32.png" alt="Ooosh" className="h-7 w-7" />
                <span className="text-lg font-bold tracking-tight">Ooosh</span>
              </Link>
              <nav className="hidden md:flex gap-1">
                {navItems.map((item) =>
                  item.children ? (
                    <NavDropdown key={item.path} item={item} isActive={isItemActive(item)} userRole={user?.role} />
                  ) : (
                    <Link
                      key={item.path}
                      to={item.path}
                      className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                        isItemActive(item)
                          ? 'bg-ooosh-600 text-white'
                          : 'text-ooosh-100 hover:bg-ooosh-700 hover:text-white'
                      }`}
                    >
                      {item.label}
                    </Link>
                  )
                )}
              </nav>
            </div>
            <div className="flex items-center gap-2">
              <GlobalSearch />
              <NotificationBell />
              <UserMenu />
              {/* Mobile hamburger */}
              <button
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                className="md:hidden p-1 text-ooosh-200 hover:text-white"
              >
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  {mobileMenuOpen ? (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                  )}
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Mobile menu */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-ooosh-700">
            <div className="px-4 py-3 space-y-1">
              {navItems.map((item) =>
                item.children ? (
                  <div key={item.path}>
                    <div className="px-3 py-2 text-xs font-semibold text-ooosh-400 uppercase tracking-wider">
                      {item.label}
                    </div>
                    {item.children.map((child) => (
                      <Link
                        key={child.path}
                        to={child.path}
                        onClick={() => setMobileMenuOpen(false)}
                        className={`block pl-6 pr-3 py-2 rounded text-sm font-medium transition-colors ${
                          location.pathname === child.path || location.pathname.startsWith(child.path + '/')
                            ? 'bg-ooosh-600 text-white'
                            : 'text-ooosh-100 hover:bg-ooosh-700 hover:text-white'
                        }`}
                      >
                        {child.label}
                      </Link>
                    ))}
                  </div>
                ) : (
                  <Link
                    key={item.path}
                    to={item.path}
                    onClick={() => setMobileMenuOpen(false)}
                    className={`block px-3 py-2 rounded text-sm font-medium transition-colors ${
                      isItemActive(item)
                        ? 'bg-ooosh-600 text-white'
                        : 'text-ooosh-100 hover:bg-ooosh-700 hover:text-white'
                    }`}
                  >
                    {item.label}
                  </Link>
                )
              )}
              <div className="border-t border-ooosh-700 pt-2 mt-2">
                <Link
                  to="/profile"
                  onClick={() => setMobileMenuOpen(false)}
                  className="block px-3 py-2 rounded text-sm font-medium text-ooosh-100 hover:bg-ooosh-700 hover:text-white transition-colors"
                >
                  My Profile
                </Link>
                {(user?.role === 'admin' || user?.role === 'manager') && (
                  <Link
                    to="/settings"
                    onClick={() => setMobileMenuOpen(false)}
                    className="block px-3 py-2 rounded text-sm font-medium text-ooosh-100 hover:bg-ooosh-700 hover:text-white transition-colors"
                  >
                    Settings
                  </Link>
                )}
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-sm text-ooosh-200">
                    {user?.first_name} {user?.last_name}
                  </span>
                  <button
                    onClick={() => { logout(); setMobileMenuOpen(false); }}
                    className="text-sm text-red-300 hover:text-white transition-colors"
                  >
                    Sign out
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </header>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  );
}

export { UserAvatar };
