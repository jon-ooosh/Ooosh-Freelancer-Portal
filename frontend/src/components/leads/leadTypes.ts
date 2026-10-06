/** Shapes and labels shared by the Leads page and its modals. */

export interface LeadContact {
  contact_type: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  source: string | null;
  confidence: string;
}

export interface MatchCandidate {
  id: string;
  name: string;
  type: string | null;
  similarity: number | null;
  via?: 'org_name' | 'job_name';
  job_count?: number;
  sample_job_name?: string | null;
}

export interface ClientHistory {
  org_id: string;
  org_name: string;
  scope: 'org' | 'band_jobs';
  enquiries: number;
  booked: number;
  open: number;
  lost: number;
  cancelled: number;
  /** Our cold outreach that got no reply — not a loss. Absent on older snapshots. */
  outreach_no_reply?: number;
  lost_reasons: { reason: string; count: number }[];
  last_enquiry: string | null;
  last_booked: string | null;
  booked_value: number;
  retros: { great: number; ok: number; issues: number };
  do_not_hire: boolean;
  working_terms: string | null;
}

export interface KnownContact {
  person_id: string;
  name: string;
  email: string;
  orgs: string | null;
  job_count: number;
}

export interface Lead {
  id: string;
  artist_name: string;
  uk_date_count: number;
  first_date: string | null;
  last_date: string | null;
  venues: string[];
  relevance_score: number | null;
  client_tier: number | null;
  origin_country: string | null;
  is_international: boolean | null;
  reasoning: string | null;
  ai_summary: string | null;
  stream: 'cold' | 'warm';
  match_confidence: 'exact' | 'partial' | 'none';
  match_candidates: MatchCandidate[];
  match_via: 'org_name' | 'job_name' | 'created' | null;
  matched_organisation_id: string | null;
  matched_org_name: string | null;
  client_history: ClientHistory | null;
  known_contacts: KnownContact[];
  contacts: LeadContact[];
  status: string;
  status_reason: string | null;
  status_note: string | null;
  converted_job_id: string | null;
  converted_job_number: number | null;
  converted_job_name: string | null;
  converted_job_status: string | null;
  prev_lead_id: string | null;
  prev_status: string | null;
  prev_status_reason: string | null;
  prev_status_note: string | null;
  prev_first_date: string | null;
  prev_last_date: string | null;
  prev_converted_job_id: string | null;
  updated_at: string;
}

/** Dismiss reasons — keys match the backend's DISMISS_REASONS. */
export const DISMISS_REASONS: { key: string; label: string; hint: string }[] = [
  { key: 'not_a_fit', label: 'Not a fit — don’t show this band again', hint: 'Hides this tour and any future ones.' },
  { key: 'timing', label: 'Too close / already sorted for this tour', hint: 'Their next tour will still show up.' },
  { key: 'next_time', label: 'Not this time — flag their next tour', hint: 'Their next tour shows up with your note on it.' },
  { key: 'already_handled', label: 'Already in touch / handled elsewhere', hint: 'Just this tour.' },
  { key: 'other', label: 'Other', hint: 'Add a note so the next person knows why.' },
];

/** Labels for every reason a lead can be hidden — staff dismiss reasons and the AI's skip reasons. */
export const REASON_LABEL: Record<string, string> = {
  not_a_fit: 'Not a fit',
  timing: 'Too close / sorted this tour',
  next_time: 'Not this time',
  already_handled: 'Already handled',
  other: 'Other',
  tribute: 'AI: tribute act',
  comedy: 'AI: comedy',
  too_big: 'AI: too big',
  dj: 'AI: DJ',
  not_music: 'AI: not music',
  electronic: 'AI: electronic',
  theatre: 'AI: theatre',
  unknown_insufficient_data: 'AI: not enough data',
  skipped: 'AI: skipped',
};

export const fmtDate = (d: string | null): string => {
  if (!d) return '—';
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? '—' : x.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
};

export const fmtDateYear = (d: string | null): string => {
  if (!d) return '—';
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? '—' : x.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
