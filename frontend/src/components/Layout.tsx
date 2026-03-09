import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuthStore } from '../hooks/useAuthStore';
import GlobalSearch from './GlobalSearch';

const navItems = [
  { path: '/', label: 'Command Centre' },
  { path: '/people', label: 'People' },
  { path: '/organisations', label: 'Organisations' },
  { path: '/venues', label: 'Venues' },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

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
                {navItems.map((item) => (
                  <Link
                    key={item.path}
                    to={item.path}
                    className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                      location.pathname === item.path || (item.path !== '/' && location.pathname.startsWith(item.path))
                        ? 'bg-ooosh-600 text-white'
                        : 'text-ooosh-100 hover:bg-ooosh-700 hover:text-white'
                    }`}
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
            </div>
            <div className="flex items-center gap-3">
              <GlobalSearch />
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
              {navItems.map((item) => (
                <Link
                  key={item.path}
                  to={item.path}
                  onClick={() => setMobileMenuOpen(false)}
                  className={`block px-3 py-2 rounded text-sm font-medium transition-colors ${
                    location.pathname === item.path || (item.path !== '/' && location.pathname.startsWith(item.path))
                      ? 'bg-ooosh-600 text-white'
                      : 'text-ooosh-100 hover:bg-ooosh-700 hover:text-white'
                  }`}
                >
                  {item.label}
                </Link>
              ))}
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
