/** Shared helpers for Command Centre dashboard */

export function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

export function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function formatDayDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

export function formatPrepTime(mins: number): string {
  if (mins === 0) return '-';
  const rounded = Math.ceil(mins / 15) * 15;
  if (rounded < 60) return `${rounded}m`;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

export function daysAgo(dateStr: string): number {
  const diff = Date.now() - new Date(dateStr).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

export function jobDisplayName(job: { job_name?: string | null; client_name?: string | null; company_name?: string | null }): string {
  return job.job_name || job.client_name || job.company_name || 'Untitled';
}

export const PIPELINE_LABELS: Record<string, string> = {
  new_enquiry: 'Enquiries',
  quoting: 'Quoting',
  chasing: 'Chasing',
  paused: 'Paused',
  provisional: 'Provisional',
};

export const PIPELINE_COLOURS: Record<string, string> = {
  new_enquiry: 'bg-blue-500',
  quoting: 'bg-cyan-500',
  chasing: 'bg-amber-500',
  paused: 'bg-gray-400',
  provisional: 'bg-purple-500',
};
