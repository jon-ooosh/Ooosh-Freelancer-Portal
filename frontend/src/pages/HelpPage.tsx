import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { GUIDES, type Guide, canSeeHelp, guideBySlug, guideDate, guideImage, searchGuides, stepLink } from '../lib/helpGuides';

/**
 * Help — the staff "How do I…?" guides (help/README.md). `/help` is the list with a
 * search box; `/help/:slug` is one guide. Every guide has the same parts in the same
 * order, so staff learn where to look: use this when · not when · the steps with a
 * picture each · what happens next · if it looks wrong.
 */
export default function HelpPage() {
  const { slug } = useParams<{ slug: string }>();
  const role = useAuthStore((s) => s.user?.role);
  // Not released to everyone yet (helpGuides.ts canSeeHelp) - a link somebody was sent
  // lands here rather than on a half-written set of guides.
  if (!canSeeHelp(role)) {
    return <div className="max-w-xl mx-auto p-6 text-sm text-gray-600">The Help guides are not open to everyone yet. Ask Jon if you need one.</div>;
  }
  return slug ? <GuideView key={slug} slug={slug} /> : <GuideList />;
}

function GuideList() {
  const [q, setQ] = useState('');
  const found = useMemo(() => searchGuides(q), [q]);
  const areas = useMemo(() => Array.from(new Set(found.map((g) => g.area))), [found]);
  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900">Help</h1>
      <p className="text-sm text-gray-600 mt-1">How to do things in OP, step by step. More guides are added as they are written.</p>
      <input
        value={q} onChange={(e) => setQ(e.target.value)} autoFocus
        placeholder="What are you trying to do? e.g. overpaid, cancel, refund"
        className="mt-4 w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
      />
      {found.length === 0 && (
        <p className="mt-6 text-sm text-gray-600">
          No guide matches that yet. Ask a manager, and tell Jon it's missing so it gets written.
        </p>
      )}
      {areas.map((area) => (
        <section key={area} className="mt-6">
          <h2 className="text-lg font-bold text-gray-900 mb-2">{area}</h2>
          <ul className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
            {found.filter((g) => g.area === area).map((g) => (
              <li key={g.slug}>
                <Link to={`/help/${g.slug}`} className="block px-4 py-3 hover:bg-gray-50">
                  <span className="font-semibold text-ooosh-700">{g.title}</span>
                  <span className="block text-sm text-gray-600 mt-0.5">{g.summary}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function GuideView({ slug }: { slug: string }) {
  const [params] = useSearchParams();
  const from = params.get('from');
  const guide = guideBySlug(slug);
  if (!guide) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <p className="text-sm text-gray-700">That guide doesn't exist (it may have been renamed).</p>
        <Link to="/help" className="text-sm text-ooosh-600 hover:underline">See all guides</Link>
      </div>
    );
  }
  const guideLink = (s: string) => `/help/${s}${from ? `?from=${encodeURIComponent(from)}` : ''}`;
  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto">
      <Link to="/help" className="text-sm text-ooosh-600 hover:underline">All guides</Link>
      <h1 className="text-3xl font-bold text-gray-900 mt-2 leading-tight">{guide.title}</h1>
      <p className="text-xs text-gray-500 mt-1">{guide.area} · {guide.who} · checked {guideDate(guide.checked)}</p>
      <p className="text-[15px] text-gray-700 mt-3">{guide.summary}</p>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-green-200 bg-green-50 p-4">
          <h2 className="text-sm font-bold text-green-800 uppercase tracking-wide">Use this when</h2>
          <ul className="mt-2 space-y-1.5 text-sm text-gray-800 list-disc pl-5">
            {guide.useWhen.map((t) => <li key={t}>{t}</li>)}
          </ul>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <h2 className="text-sm font-bold text-amber-800 uppercase tracking-wide">Not when</h2>
          <ul className="mt-2 space-y-1.5 text-sm text-gray-800 list-disc pl-5">
            {guide.notWhen.map((n) => (
              <li key={n.text}>
                {n.text}
                {n.see && guideBySlug(n.see) && <> <Link to={guideLink(n.see)} className="text-ooosh-700 underline">See that guide</Link></>}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <h2 className="text-xl font-bold text-gray-900 mt-10">Steps</h2>
      <ol className="mt-3 space-y-6">
        {guide.steps.map((s, i) => {
          const img = guideImage(guide.slug, s.image);
          const link = stepLink(s.open, from);
          return (
            <li key={s.text} className="flex gap-3">
              <span className="flex-none w-7 h-7 rounded-full bg-ooosh-600 text-white text-sm font-bold grid place-items-center">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="text-base font-semibold text-gray-900">
                  {s.text}
                  {s.who && <span className="ml-2 align-middle text-[11px] font-semibold px-2 py-0.5 rounded-full bg-purple-100 text-purple-800">{s.who}</span>}
                </p>
                {s.detail && <p className="text-sm text-gray-600 mt-1">{s.detail}</p>}
                <p className="mt-1 flex flex-wrap gap-x-4 text-sm">
                  {link && <Link to={link.to} className="text-ooosh-700 font-semibold hover:underline">{link.label} →</Link>}
                  {s.see && guideBySlug(s.see) && <Link to={guideLink(s.see)} className="text-ooosh-700 font-semibold hover:underline">{guideBySlug(s.see)!.title} →</Link>}
                </p>
                {img && (
                  <a href={img} target="_blank" rel="noreferrer" title="Open the picture full size" className="block mt-2">
                    {/* Pictures are taken at double size so they stay sharp: show each at its real
                        size (half its pixels), never stretched to fill the column. */}
                    <img src={img} alt={`Step ${i + 1}: ${s.text}`} loading="lazy"
                      onLoad={(e) => { e.currentTarget.style.width = `${e.currentTarget.naturalWidth / 2}px`; }}
                      className="rounded-lg border border-gray-200 shadow-sm max-w-full h-auto" />
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <h2 className="text-xl font-bold text-gray-900 mt-10">What happens next</h2>
      <ul className="mt-2 space-y-1.5 text-sm text-gray-800 list-disc pl-5">
        {guide.next.map((t) => <li key={t}>{t}</li>)}
      </ul>

      <h2 className="text-xl font-bold text-gray-900 mt-10">If it looks wrong</h2>
      <dl className="mt-2 bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
        {guide.wrong.map((w) => (
          <div key={w.problem} className="px-4 py-3">
            <dt className="text-sm font-semibold text-gray-900">{w.problem}</dt>
            <dd className="text-sm text-gray-700 mt-0.5">{w.fix}</dd>
          </div>
        ))}
      </dl>

      {(guide.related ?? []).some((r) => guideBySlug(r)) && (
        <>
          <h2 className="text-xl font-bold text-gray-900 mt-10">Related</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {(guide.related ?? []).map((r) => guideBySlug(r)).filter((g): g is Guide => !!g).map((g) => (
              <li key={g.slug}><Link to={guideLink(g.slug)} className="text-ooosh-700 hover:underline">{g.title}</Link></li>
            ))}
          </ul>
        </>
      )}

      <GuideFeedback guide={guide} />
      <p className="text-xs text-gray-400 mt-6">{GUIDES.length} guide{GUIDES.length === 1 ? '' : 's'} so far.</p>
    </div>
  );
}

/**
 * "Something wrong on this page?" — guides live in the code, so nobody edits one here;
 * this tells the admins what is wrong and it is corrected with the next change.
 */
function GuideFeedback({ guide }: { guide: Guide }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  async function send() {
    if (!text.trim()) return;
    setState('sending');
    try {
      await api.post('/help/feedback', { slug: guide.slug, title: guide.title, message: text.trim() });
      setState('sent');
    } catch {
      setState('failed');
    }
  }
  if (state === 'sent') return <p className="mt-8 text-sm text-green-800">Thanks. Jon has been told, and the guide will be corrected.</p>;
  return (
    <div className="mt-8 border-t border-gray-200 pt-4">
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="text-sm text-ooosh-700 font-semibold hover:underline">
          Something wrong or missing on this page?
        </button>
      ) : (
        <div>
          <label htmlFor="guide-feedback" className="block text-sm font-semibold text-gray-900">What is wrong or missing?</label>
          <p className="text-xs text-gray-500">For example a step that no longer matches the screen, or a case this doesn't cover.</p>
          <textarea id="guide-feedback" rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)}
            className="mt-2 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          {state === 'failed' && <p className="text-sm text-red-600">That didn't send. Try again.</p>}
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => void send()} disabled={state === 'sending' || !text.trim()}
              className="px-4 py-2 text-sm bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700 disabled:opacity-50">
              {state === 'sending' ? 'Sending…' : 'Send'}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
