/**
 * The band-standing rehearsal "setup" fields — the single source of truth shared
 * by the Job Detail rehearsal card and the Org Rehearsals tab so the two surfaces
 * can't drift. `key` is BOTH the organisation_rehearsal_profile column name AND
 * the per-hire override key (rehearsal_job_details.overrides), so a field can be
 * saved as the band's usual (profile) or a one-off for this hire (overrides).
 *
 * Genuinely per-hire fields (cars / drop-off / notes) are NOT here — they have no
 * band counterpart and live only on the job.
 */
export interface RehearsalSetupField {
  key:
    | 'pa_monitoring'
    | 'usual_backline'
    | 'room_setup'
    | 'mic_list'
    | 'power_notes'
    | 'desk'
    | 'load_in_access'
    | 'regular_contact';
  label: string;
  placeholder?: string;
}

export const REHEARSAL_SETUP_FIELDS: RehearsalSetupField[] = [
  { key: 'pa_monitoring', label: 'PA & monitoring', placeholder: 'What PA / monitoring — wedges, IEMs, mix quirks…' },
  { key: 'usual_backline', label: 'Backline from us', placeholder: 'What they hire from us vs bring' },
  { key: 'room_setup', label: 'Room setup', placeholder: 'How they like the room laid out — backline positions, their own layout…' },
  { key: 'mic_list', label: 'Mics', placeholder: 'Mics they usually ask for' },
  { key: 'power_notes', label: 'Power / distro', placeholder: 'Power / distro needs' },
  { key: 'desk', label: 'In-house desk', placeholder: 'Which in-house digital desk they use' },
  { key: 'load_in_access', label: 'Load-in / access', placeholder: 'Early in, late finish, loading…' },
  { key: 'regular_contact', label: 'Regular contact', placeholder: 'TM / engineer + how they like to be reached' },
];

export type RehearsalSetupKey = RehearsalSetupField['key'];
