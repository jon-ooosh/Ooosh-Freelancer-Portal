/**
 * The four job dates (Out → Start → End → Return) — THE frontend rules for
 * editing them, shared by the Job Detail date editor and the "Quote another
 * option" modal so the two can't drift. Backend twin: `validateJobDateTimes`
 * in routes/pipeline.ts (same rules, same messages).
 *
 * Linking: Out follows Start while they're equal; Return follows End while
 * they're equal (the chain icons on Job Detail). Moving Start past End pushes
 * End (and a linked Return) to the next day; a value that would cross its
 * neighbour the wrong way is refused rather than silently reordered.
 */

export interface JobDateSet {
  out_date: string;
  job_date: string;
  job_end: string;
  return_date: string;
}

export interface JobDateLinks {
  outLinked: boolean;
  returnLinked: boolean;
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

/** Which links to start with, from the job's current values (equal = linked). */
export function initialDateLinks(d: JobDateSet): JobDateLinks {
  return {
    outLinked: !!d.job_date && d.out_date === d.job_date,
    returnLinked: !!d.job_end && d.return_date === d.job_end,
  };
}

/**
 * Apply one field change with the cascade rules. Returns the next date set, or
 * null when the change is refused (it would cross a neighbour the wrong way).
 */
export function cascadeJobDate(
  prev: JobDateSet,
  field: keyof JobDateSet,
  val: string,
  links: JobDateLinks,
): JobDateSet | null {
  const next = { ...prev };
  switch (field) {
    case 'out_date': {
      if (val && prev.job_date && val > prev.job_date) return null;
      next.out_date = val;
      if (links.outLinked && val) {
        next.job_date = val;
        if (!next.job_end || next.job_end <= val) {
          const nextDay = addDays(val, 1);
          next.job_end = nextDay;
          if (links.returnLinked) next.return_date = nextDay;
        }
      }
      return next;
    }
    case 'job_date': {
      next.job_date = val;
      if (links.outLinked) {
        next.out_date = val;
      } else if (next.out_date && next.out_date > val) {
        next.out_date = val;
      }
      if (val && (!next.job_end || next.job_end < val)) {
        const nextDay = addDays(val, 1);
        next.job_end = nextDay;
        if (links.returnLinked) next.return_date = nextDay;
      }
      return next;
    }
    case 'job_end': {
      if (val && prev.job_date && val < prev.job_date) return null;
      next.job_end = val;
      if (links.returnLinked) {
        next.return_date = val;
      } else if (next.return_date && next.return_date < val) {
        next.return_date = val;
      }
      return next;
    }
    case 'return_date': {
      if (val && prev.job_end && val < prev.job_end) return null;
      next.return_date = val;
      if (links.returnLinked) next.job_end = val;
      return next;
    }
  }
  return next;
}

/**
 * Validate ordering of out/start/end/return datetimes. Returns a friendly
 * error string if invalid, or null if OK / insufficient data to check.
 */
export function validateDateTimeOrdering(v: {
  out_date: string; job_date: string; job_end: string; return_date: string;
  out_time: string; start_time: string; end_time: string; return_time: string;
}): string | null {
  const ms = (date: string, time: string): number => {
    if (!date) return NaN;
    const t = (time || '09:00').slice(0, 5);
    return Date.parse(`${date}T${t}:00Z`);
  };
  const oMs = ms(v.out_date, v.out_time);
  const sMs = ms(v.job_date, v.start_time);
  const eMs = ms(v.job_end, v.end_time);
  const rMs = ms(v.return_date, v.return_time);
  // Out > Start is allowed on the same calendar day (e.g. charge starts 09:00,
  // client collects at 15:00 — Outgoing here means the physical handover time).
  // Cross-day Out-after-Start stays blocked: the inbound HH sync would clobber
  // out_date back to job_date on the next pull (HH never sees the user's
  // intended later date because we clamp on push), so we don't expose that case.
  if (!isNaN(oMs) && !isNaN(sMs) && oMs > sMs && v.out_date !== v.job_date) {
    return 'Outgoing date must be on or before Job Start date.';
  }
  if (!isNaN(sMs) && !isNaN(eMs) && sMs > eMs) {
    return 'Job Start date/time must be on or before Job End date/time.';
  }
  if (!isNaN(eMs) && !isNaN(rMs) && eMs > rMs) {
    return 'Job End date/time must be on or before Returning date/time.';
  }
  return null;
}
