import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { guidesForPath } from '../lib/helpGuides';

/**
 * The "?" in the header (help/README.md): the guides about the page you are on, and a
 * way to all of them. A guide opened from here is told which page it came from, so its
 * steps can link straight back to the right tab of the same job.
 */
export default function HelpButton() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const here = guidesForPath(pathname);

  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button" onClick={() => setOpen((o) => !o)} aria-label="Help" title="Help: how to do things in OP" aria-expanded={open}
        className="w-8 h-8 rounded-full border border-ooosh-300 text-ooosh-100 hover:bg-ooosh-700 hover:text-white text-sm font-bold grid place-items-center"
      >?</button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 max-w-[90vw] z-40 bg-white border border-gray-200 rounded-xl shadow-lg text-left">
          <div className="px-4 pt-3 pb-1 text-xs font-semibold text-gray-500 uppercase tracking-wider">
            {here.length ? 'How to, on this page' : 'Help'}
          </div>
          {here.length === 0 && <p className="px-4 pb-2 text-sm text-gray-600">No guide for this page yet.</p>}
          <ul>
            {here.map((g) => (
              <li key={g.slug}>
                <Link to={`/help/${g.slug}?from=${encodeURIComponent(pathname)}`} className="block px-4 py-2 text-sm text-ooosh-700 font-semibold hover:bg-gray-50">
                  {g.title}
                </Link>
              </li>
            ))}
          </ul>
          <Link to="/help" className="block border-t border-gray-100 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 rounded-b-xl">All guides and search</Link>
        </div>
      )}
    </div>
  );
}
