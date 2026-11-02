import type { Metadata, Viewport } from 'next'
import { DM_Sans } from 'next/font/google'
import './globals.css'
import { MuteBanner } from '@/components/MuteBanner'

// DM Sans, as the hire form and payment portal (Oct 2026 refresh). Variable,
// with the optical-size axis the design uses.
const dmSans = DM_Sans({ subsets: ['latin'], axes: ['opsz'], variable: '--font-dm-sans', display: 'swap' })

export const metadata: Metadata = {
  title: 'Ooosh Freelancer Portal',
  description: 'Manage your jobs with Ooosh Tours',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Ooosh Portal',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#f6f4f2',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={dmSans.variable}>
      <body className="font-sans antialiased bg-hf-page text-hf-ink">
        <MuteBanner />
        {children}
      </body>
    </html>
  )
}
