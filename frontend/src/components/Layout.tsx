import { useState, useRef, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuthStore } from '../hooks/useAuthStore';
import GlobalSearch from './GlobalSearch';
import NotificationBell from './NotificationBell';

interface NavItem {
  path: string;
  label: string;
  children?: { path: string; label: string }[];
}

const navItems: NavItem[] = [
  {
    path: '/address-book',
    label: 'Address Book',
    children: [
      { path: '/people', label: 'People' },
      { path: '/organisations', label: 'Organisations' },
      { path: '/venues', label: 'Venues' },
    ],
  },
  {
    path: '/jobs-menu',
    label: 'Jobs',
    children: [
      { path: '/pipeline', label: 'Enquiries' },
      { path: '/jobs', label: 'Upcoming & Out' },
    ],
  },
  {
    path: '/vehicles-menu',
    label: 'Vehicles',
    children: [
      { path: '/vehicles', label: 'Dashboard' },
      { path: '/vehicles/fleet', label: 'Fleet' },
      { path: '/vehicles/book-out', label: 'Book Out' },
      { path: '/vehicles/check-in', label: 'Check In' },
      { path: '/vehicles/allocations', label: 'Allocations' },
      { path: '/vehicles/prep', label: 'Prep' },
      { path: '/vehicles/issues', label: 'Issues' },
      { path: '/vehicles/fleet-map', label: 'Fleet Map' },
      { path: '/vehicles/settings', label: 'Settings' },
    ],
  },
];

const adminNavItems: NavItem[] = [
  { path: '/settings', label: 'Settings' },
];

function NavDropdown({ item, isActive }: { item: NavItem; isActive: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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
      {open && item.children && (
        <div className="absolute top-full left-0 mt-1 w-48 max-h-[70vh] overflow-y-auto bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
          {item.children.map((child) => (
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

export default function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const isAdmin = user?.role === 'admin' || user?.role === 'manager';
  const allNavItems = isAdmin ? [...navItems, ...adminNavItems] : navItems;

  function isItemActive(item: NavItem): boolean {
    if (item.children) {
      return item.children.some(
        (child) => location.pathname === child.path || location.pathname.startsWith(child.path + '/')
      );
    }
    return location.pathname === item.path || (item.path !== '/' && location.pathname.startsWith(item.path));
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top nav */}
      <header className="bg-ooosh-800 text-white shadow-lg">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            <div className="flex items-center gap-6">
              <Link to="/" className="flex items-center gap-2">
                <img src="/favicon-32x32.png" alt="Ooosh" className="h-7 w-7" />
                <span className="text-lg font-bold tracking-tight">Ooosh</span>
              </Link>
              <nav className="hidden md:flex gap-1">
                {allNavItems.map((item) =>
                  item.children ? (
                    <NavDropdown key={item.path} item={item} isActive={isItemActive(item)} />
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
            <div className="flex items-center gap-3">
              <GlobalSearch />
              <NotificationBell />
              <span className="hidden sm:inline text-sm text-ooosh-200">
                {user?.first_name} {user?.last_name}
              </span>
              <button
                onClick={logout}
                className="hidden sm:inline text-sm text-ooosh-200 hover:text-white transition-colors"
              >
                Sign out
              </button>
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
              {allNavItems.map((item) =>
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
              <div className="border-t border-ooosh-700 pt-2 mt-2 flex items-center justify-between">
                <span className="text-sm text-ooosh-200">
                  {user?.first_name} {user?.last_name}
                </span>
                <button
                  onClick={() => { logout(); setMobileMenuOpen(false); }}
                  className="text-sm text-ooosh-200 hover:text-white transition-colors"
                >
                  Sign out
                </button>
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
