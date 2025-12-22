import { redirect } from 'next/navigation'

export default function Home() {
  // For now, redirect to login page
  // Later, this will check for session and redirect appropriately
  redirect('/login')
}
