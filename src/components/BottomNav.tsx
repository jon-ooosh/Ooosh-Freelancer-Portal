'use client'

/**
 * The portal's bottom navigation: Jobs · Earnings · Resources · Settings (order
 * unchanged). Oct 2026 refresh: white 94% with a top border, four equal columns,
 * the active tab's icon in a plum pill.
 */

import Link from 'next/link'
import { Briefcase, PoundSterling, BookOpen, Settings } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

type Tab = 'jobs' | 'earnings' | 'resources' | 'settings'

const TABS: { key: Tab; href: string; label: string; Icon: LucideIcon }[] = [
  { key: 'jobs', href: '/dashboard', label: 'Jobs', Icon: Briefcase },
  { key: 'earnings', href: '/earnings', label: 'Earnings', Icon: PoundSterling },
  { key: 'resources', href: '/resources', label: 'Resources', Icon: BookOpen },
  { key: 'settings', href: '/settings', label: 'Settings', Icon: Settings },
]

export default function BottomNav({ active }: { active: Tab }) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-20 bg-white/[0.94] backdrop-blur border-t border-hf-border safe-bottom">
      <div className="max-w-lg mx-auto px-3 pt-2 pb-2 grid grid-cols-4">
        {TABS.map(({ key, href, label, Icon }) => {
          const on = key === active
          return (
            <Link
              key={key}
              href={href}
              aria-current={on ? 'page' : undefined}
              className={`h-[54px] flex flex-col items-center justify-center gap-1 ${on ? 'text-hf-link' : 'text-hf-muted hover:text-hf-body'}`}
            >
              <span className={`w-[52px] h-[30px] rounded-full flex items-center justify-center ${on ? 'bg-hf-tint' : ''}`}>
                <Icon size={22} strokeWidth={1.8} />
              </span>
              <span className={`text-[12px] ${on ? 'font-bold' : 'font-medium'}`}>{label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
