/**
 * Sanity-check scanners — dispatch + return.
 *
 * Two related scanners, both deferred + de-duped:
 *
 *   • runDispatchSanityScan — finds jobs at pipeline_status='dispatched'
 *     whose HH `status` column is still < 5 after a 30-min grace window
 *     (one full polling-sync cycle, so the cached HH copy has had time to
 *     refresh). Fires ONCE per dispatch via
 *     `jobs.under_dispatch_warned_at` and pushes the warning to info@.
 *
 *   • runReturnedBookedOutScan — finds jobs at pipeline_status='returned'
 *     that still have `vehicle_hire_assignments` rows in booked_out/active
 *     after a 20-min grace. Fires ONCE per transition into 'returned' via
 *     `jobs.returned_bookedout_warned_at`. Email is built by
 *     `buildAndSendReturnedBookedOutAlert` (de-dupes drivers per van).
 *
 *   • runBookedOutNoTimestampScan — tripwire for `vehicle_hire_assignments`
 *     stuck at booked_out with `booked_out_at IS NULL` for >3h. Should be
 *     impossible post the Jun 2026 book-out fix; a hit signals a regression
 *     that reintroduced a timestamp-less book-out (the RX73TBZ 16057↔16149
 *     mis-attribution state). One alert per job, deduped via a notes marker.
 *
 *   • runBookedSplitScan — proactive escalation alarm for the "confirmed in
 *     OP but never Booked in HireHop" split-brain (job 16513). A HireHop 327
 *     storm can make the post-payment status-push fail silently, leaving a job
 *     at pipeline_status='confirmed' (or further) while jobs.status stays < 2
 *     in HireHop. The booked-status reconciler (services/booked-status-
 *     reconciler.ts) heals these silently on the 30-min sync, but if HireHop
 *     stays unreachable the job sits stuck with no one told. This scanner
 *     emails jon@ ONCE per stuck job after a 2-hour grace, deduped via
 *     `jobs.booked_split_alerted_at` (migration 189). Scoped on `status < 2`
 *     so a legit last-minute booking racing confirmed→prepping→dispatched
 *     (where HH status climbs to >= 2) never trips it. The marker is cleared
 *     in-scan once the job recovers (status >= 2) or goes terminal.
 *
 *   • runStuckOnHireScan — detection scanner for the multi-van book-out
 *     scramble (docs/MULTI-VAN-BOOKOUT-SCRAMBLE.md §6). Finds vehicles
 *     projected `hire_status='On Hire'` with NO live booked_out/active
 *     assignment row — the fingerprint of the scramble (the 2nd van's rows had
 *     their vehicle_id overwritten to the other van, so the van reads On Hire
 *     but owns no assignment and can't be checked in). Alerts jon@ ONCE per
 *     stuck van, deduped via `fleet_vehicles.stuck_onhire_alerted_at` (marker
 *     cleared in syncFleetHireStatus when the van leaves On Hire).
 *
 * The pipeline_status markers are cleared on transitions out of their
 * respective pipeline_status so a re-entered state can warn afresh — handled in
 * routes/pipeline.ts and routes/webhooks.ts wherever pipeline_status
 * transitions are written.
 */
import { query } from '../config/database';
import { emailService } from './email-service';
import { getFrontendUrl } from '../config/app-urls';
import { HH_STATUS_LABELS } from './auto-dispatch';
import { buildAndSendReturnedBookedOutAlert } from './vehicle-emails';
import { isWithinBusinessHours } from './completion-chaser';
import { getFromR2 } from '../config/r2';

// Grace window before a started-but-not-completed van leg is flagged. A
// book-out / collection walkaround is ~30 min; 3h means something's genuinely
// stalled (or the freelancer bounced off the handoff — the Lewis case).
const STALLED_LEG_HOURS = 3;

/**
 * "Started but not completed" scanner (§7.3). Finds quotes where a freelancer
 * RESOLVED a book-out / check-in token (van_leg_started_at stamped) but no
 * vehicle event ever completed the van leg (van_leg_done_at still NULL) after
 * the grace window. Alerts info@ ONCE per quote (deduped via
 * van_leg_alert_sent_at) so staff learn before an 11am client chase (Lewis, HH
 * 15933). Business hours only. info@-only, matching the sibling scanners (no
 * bell fanout — deliberate, to avoid the spam pattern those replaced).
 */
export async function runFreelancerLegStalledScan(): Promise<{ checked: number; warned: number }> {
  if (!isWithinBusinessHours()) return { checked: 0, warned: 0 };

  const candidates = await query(
    `SELECT q.id, q.job_type, q.venue_name, q.van_leg_started_at,
            j.id AS job_id, j.hh_job_number, j.job_name,
            p.first_name, p.last_name, p.email AS freelancer_email
       FROM quotes q
       LEFT JOIN jobs j ON j.id = q.job_id
       LEFT JOIN LATERAL (
         SELECT pe.first_name, pe.last_name, pe.email
           FROM quote_assignments qa
           JOIN people pe ON pe.id = qa.person_id
          WHERE qa.quote_id = q.id AND qa.status NOT IN ('declined', 'cancelled')
          ORDER BY qa.created_at
          LIMIT 1
       ) p ON true
      WHERE q.van_leg_started_at IS NOT NULL
        AND q.van_leg_done_at IS NULL
        AND q.van_leg_alert_sent_at IS NULL
        AND COALESCE(q.ops_status, 'todo') NOT IN ('completed', 'cancelled')
        AND q.is_deleted = false
        AND q.van_leg_started_at < NOW() - INTERVAL '${STALLED_LEG_HOURS} hours'
      ORDER BY q.van_leg_started_at ASC
      LIMIT 50`
  );

  let warned = 0;
  const frontendUrl = getFrontendUrl();

  for (const row of candidates.rows) {
    try {
      const jobRef = row.hh_job_number
        ? `J-${row.hh_job_number}`
        : (row.job_name || row.venue_name || 'Unknown job');
      const freelancer = `${row.first_name || ''} ${row.last_name || ''}`.trim()
        || row.freelancer_email || 'a freelancer';
      const hoursAgo = Math.round((Date.now() - new Date(row.van_leg_started_at).getTime()) / (1000 * 60 * 60));
      const direction = row.job_type === 'collection' ? 'collection (check-in)' : 'delivery (book-out)';
      const opJobUrl = row.job_id ? `${frontendUrl}/jobs/${row.job_id}` : frontendUrl;

      // Stamp marker FIRST (stamp-first, like the sibling scanners) so a
      // transient send-failure doesn't re-fire on the next scan.
      await query(
        `UPDATE quotes SET van_leg_alert_sent_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [row.id]
      );

      const result = await emailService.sendRaw({
        to: 'info@oooshtours.co.uk',
        subject: `[Ops] Van ${direction} started but not completed — ${jobRef}`,
        html: `
          <h2 style="margin:0 0 12px;font-size:18px;color:#b45309;">Van leg started but not completed</h2>
          <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
            <strong>${freelancer}</strong> started the ${direction} for
            <strong>${jobRef}</strong>${row.venue_name ? ` (${row.venue_name})` : ''}
            about <strong>${hoursAgo}h</strong> ago, but the van hasn't been
            ${row.job_type === 'collection' ? 'checked in' : 'booked out'} yet.
          </p>
          <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
            They may have bounced off the handoff or hit a problem. Worth a quick
            call before the client chases.
          </p>
          <p style="margin:0;font-size:13px;">
            <a href="${opJobUrl}" style="color:#7B5EA7;">Open the job in OP</a>
          </p>
        `,
        variant: 'internal',
      });
      if (result.success) warned++;
      else console.warn(`[sanity-scanner] stalled-leg alert send failed for ${jobRef}:`, result);
    } catch (err) {
      console.error(`[sanity-scanner] stalled-leg scan error for quote ${row.id}:`, err);
    }
  }

  return { checked: candidates.rows.length, warned };
}

/**
 * Find dispatched jobs whose HH status is still pre-Dispatched (< 5)
 * after a 30-min grace window. Sends one warning per job, stamps marker.
 */
export async function runDispatchSanityScan(): Promise<{ checked: number; warned: number }> {
  const candidates = await query(
    `SELECT id, hh_job_number, job_name, status, pipeline_status_changed_at
     FROM jobs
     WHERE pipeline_status = 'dispatched'
       AND status IS NOT NULL
       AND status < 5
       AND under_dispatch_warned_at IS NULL
       AND pipeline_status_changed_at IS NOT NULL
       AND pipeline_status_changed_at < NOW() - INTERVAL '30 minutes'
       AND is_deleted = false
     ORDER BY pipeline_status_changed_at ASC
     LIMIT 50`
  );

  let warned = 0;
  const frontendUrl = getFrontendUrl();

  for (const job of candidates.rows) {
    try {
      const hhStatus: number = job.status;
      const hhStatusLabel = HH_STATUS_LABELS[hhStatus] || `Status ${hhStatus}`;
      const jobRef = job.hh_job_number
        ? `J-${job.hh_job_number}`
        : (job.job_name || 'Unknown job');
      const opJobUrl = `${frontendUrl}/jobs/${job.id}`;
      const hhJobUrl = job.hh_job_number
        ? `https://myhirehop.com/job.php?id=${job.hh_job_number}`
        : '';

      // Stamp the marker FIRST so a transient send-failure doesn't cause
      // the next scan to re-fire. The cost is "one rare email that
      // didn't actually send" vs "duplicate emails on every scan if a
      // template/SMTP issue persists" — the latter is the spam pattern
      // we're trying to eliminate, so stamp-first wins.
      await query(
        `UPDATE jobs SET under_dispatch_warned_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [job.id]
      );

      const result = await emailService.send('under_dispatched_warning', {
        to: 'info@oooshtours.co.uk',
        variables: {
          jobRef,
          jobName: job.job_name || '',
          jobNumber: job.hh_job_number ? String(job.hh_job_number) : '',
          source: 'Sanity scanner (30-min post-dispatch check)',
          actorLabel: 'scheduler',
          hhStatusLabel,
          hhStatusCode: String(hhStatus),
          opJobUrl,
          hhJobUrl,
        },
      });

      if (result.success) {
        warned++;
      } else {
        console.warn(`[sanity-scanner] dispatch warning send failed for ${jobRef}:`, result);
      }
    } catch (err) {
      console.error(`[sanity-scanner] dispatch scan error for job ${job.id}:`, err);
    }
  }

  return { checked: candidates.rows.length, warned };
}

/**
 * Find returned jobs that still have booked_out/active assignment rows
 * after a 20-min grace window. Sends one de-duped-by-vehicle warning
 * per job, stamps marker.
 */
export async function runReturnedBookedOutScan(): Promise<{ checked: number; warned: number }> {
  const candidates = await query(
    `SELECT j.id
     FROM jobs j
     WHERE j.pipeline_status = 'returned'
       AND j.returned_bookedout_warned_at IS NULL
       AND j.pipeline_status_changed_at IS NOT NULL
       AND j.pipeline_status_changed_at < NOW() - INTERVAL '20 minutes'
       AND j.is_deleted = false
       AND EXISTS (
         SELECT 1 FROM vehicle_hire_assignments vha
         WHERE vha.job_id = j.id
           AND vha.status IN ('booked_out', 'active')
       )
     ORDER BY j.pipeline_status_changed_at ASC
     LIMIT 50`
  );

  let warned = 0;

  for (const job of candidates.rows) {
    try {
      // Stamp BEFORE sending — see rationale in dispatch scanner above.
      await query(
        `UPDATE jobs SET returned_bookedout_warned_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [job.id]
      );

      const result = await buildAndSendReturnedBookedOutAlert({
        jobId: job.id,
        triggerSource: 'Sanity scanner (20-min post-return check)',
      });
      if (result.sent) warned++;
    } catch (err) {
      console.error(`[sanity-scanner] returned-bookedout scan error for job ${job.id}:`, err);
    }
  }

  return { checked: candidates.rows.length, warned };
}

/**
 * Tripwire: vehicle_hire_assignments stuck at status='booked_out' with
 * booked_out_at NULL for > 3 hours.
 *
 * Since the Jun 2026 book-out fix (hire-forms PATCH stamps booked_out_at on
 * every booked_out transition) this state should be IMPOSSIBLE. A hit means a
 * code path has regressed and reintroduced a timestamp-less book-out — the
 * exact state that fools the check-in job-resolver into picking a stale
 * book-out from a previous hire and silently strands the real one (RX73TBZ,
 * jobs 16057↔16149). This catches it in hours instead of days.
 *
 * One alert per job (multi-driver hires share a van). Dedup via a notes
 * marker — consistent with this table's other row-level markers
 * ([Suspended: …], [Auto-cancelled: …]) — so no migration is needed. The
 * 3-hour grace is generous: a legitimate book-out gets booked_out_at stamped
 * synchronously in the PATCH, so nothing real should ever linger this long.
 * Stamp-first, like the scanners above.
 */
const NO_TS_MARKER = '[Tripwire: booked_out missing timestamp — alerted]';

export async function runBookedOutNoTimestampScan(): Promise<{ checked: number; warned: number }> {
  const candidates = await query(
    `SELECT vha.id, vha.hirehop_job_id, fv.reg
       FROM vehicle_hire_assignments vha
       LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      WHERE vha.status = 'booked_out'
        AND vha.booked_out_at IS NULL
        AND vha.status_changed_at < NOW() - INTERVAL '3 hours'
        AND (vha.notes IS NULL OR vha.notes NOT LIKE $1)
      ORDER BY vha.status_changed_at ASC
      LIMIT 100`,
    [`%${NO_TS_MARKER}%`]
  );

  if (candidates.rows.length === 0) return { checked: 0, warned: 0 };

  // Group rows per job so a multi-driver hire produces one alert, not N.
  const byJob = new Map<string, { reg: string | null; rowIds: string[] }>();
  for (const r of candidates.rows) {
    const key = r.hirehop_job_id != null ? String(r.hirehop_job_id) : `unlinked:${r.id}`;
    if (!byJob.has(key)) byJob.set(key, { reg: r.reg, rowIds: [] });
    byJob.get(key)!.rowIds.push(r.id);
  }

  let warned = 0;

  for (const [jobKey, info] of byJob) {
    try {
      // Stamp the marker on every row in the group FIRST — same stamp-first
      // rationale as the scanners above (a transient send failure must not
      // re-fire on the next scan).
      await query(
        `UPDATE vehicle_hire_assignments
            SET notes = CASE WHEN notes IS NULL OR notes = '' THEN $2
                             ELSE notes || E'\\n' || $2 END,
                updated_at = NOW()
          WHERE id = ANY($1::uuid[])`,
        [info.rowIds, NO_TS_MARKER]
      );

      const hhJob = jobKey.startsWith('unlinked:') ? null : jobKey;
      const jobRef = hhJob ? `HH #${hhJob}` : '(no HH job linked)';
      const regLabel = info.reg || '(no vehicle linked)';
      const hhJobUrl = hhJob ? `https://myhirehop.com/job.php?id=${hhJob}` : '';

      const html = `
        <p><strong>Data-integrity tripwire: book-out with no timestamp.</strong></p>
        <p>${info.rowIds.length} hire assignment row(s) on <strong>${jobRef}</strong>
        (vehicle <strong>${regLabel}</strong>) are <code>status='booked_out'</code> but
        <code>booked_out_at IS NULL</code>, and have been for over 3 hours.</p>
        <p>Since the Jun 2026 book-out fix this should be impossible. A hit means a
        code path has regressed and reintroduced a timestamp-less book-out — the
        state that lets a check-in mis-attribute a hire to the wrong job
        (RX73TBZ / 16057↔16149). Please investigate the affected book-out flow.</p>
        ${hhJobUrl ? `<p><a href="${hhJobUrl}">Open job in HireHop</a></p>` : ''}
        <p style="color:#888;font-size:12px">Sanity scanner — 3-hour booked_out-without-timestamp check.</p>
      `;

      const result = await emailService.sendRaw({
        to: 'info@oooshtours.co.uk',
        subject: `⚠ Book-out with no timestamp — ${jobRef} (${regLabel})`,
        html,
      });
      if (result.success) warned++;
      else console.warn(`[sanity-scanner] booked_out-no-ts alert send failed for ${jobRef}:`, result);
    } catch (err) {
      console.error(`[sanity-scanner] booked_out-no-ts scan error for job ${jobKey}:`, err);
    }
  }

  return { checked: candidates.rows.length, warned };
}

// Operationally past-confirmed pipeline statuses. In all of these, HireHop
// should be at status >= 2 (Booked). A job in one of these with jobs.status < 2
// is the "confirmed in OP, never Booked in HH" split-brain (job 16513). Enquiry
// stages (new_enquiry/quoting/paused/provisional) are legitimately < 2, and
// lost/cancelled are terminal — both excluded.
const BOOKED_SPLIT_STATUSES = [
  'confirmed',
  'prepping',
  'prepped',
  'dispatched',
  'returned_incomplete',
  'returned',
  'completed',
];

/**
 * Escalation alarm for the OP↔HireHop "Booked" split-brain (job 16513).
 *
 * Finds jobs OP believes are past-confirmed (BOOKED_SPLIT_STATUSES) but HireHop
 * never received the Booked push for (jobs.status < 2), stuck for over 2 hours
 * (pipeline_status_changed_at grace). The booked-status reconciler retries the
 * push every 30-min sync; this alarm only fires when that keeps failing (a
 * persistent HireHop outage), so a genuinely stuck job surfaces instead of
 * sitting silent.
 *
 * The `status < 2` guard is what keeps a legitimate last-minute booking racing
 * confirmed→prepping→dispatched from tripping this: once the HH push lands and
 * status climbs to >= 2, the job drops out of the candidate set.
 *
 * One alert per stuck job — deduped via `jobs.booked_split_alerted_at`, stamped
 * FIRST (a transient send failure must not re-fire on the next sweep). The
 * marker is cleared in-scan for any job that has recovered (status >= 2) or gone
 * terminal (lost/cancelled), so a re-stuck job can warn afresh. Recipient is
 * jon@ (a data-integrity anomaly he wants to action), matching runStuckOnHireScan.
 */
export async function runBookedSplitScan(): Promise<{ checked: number; warned: number }> {
  // Clear the marker for any job that's no longer stuck — the exact inverse of
  // the candidate condition below (minus grace), so a recovered/terminal job is
  // released and can re-alert if it ever gets stuck again.
  await query(
    `UPDATE jobs
        SET booked_split_alerted_at = NULL, updated_at = NOW()
      WHERE booked_split_alerted_at IS NOT NULL
        AND NOT (pipeline_status = ANY($1::text[]) AND COALESCE(status, 0) < 2)`,
    [BOOKED_SPLIT_STATUSES]
  );

  const candidates = await query(
    `SELECT id, hh_job_number, job_name, pipeline_status, status
       FROM jobs
      WHERE pipeline_status = ANY($1::text[])
        AND COALESCE(status, 0) < 2
        AND hh_job_number IS NOT NULL
        AND booked_split_alerted_at IS NULL
        AND pipeline_status_changed_at IS NOT NULL
        AND pipeline_status_changed_at < NOW() - INTERVAL '2 hours'
        AND is_deleted = false
      ORDER BY pipeline_status_changed_at ASC
      LIMIT 50`,
    [BOOKED_SPLIT_STATUSES]
  );

  if (candidates.rows.length === 0) return { checked: 0, warned: 0 };

  let warned = 0;
  const frontendUrl = getFrontendUrl();

  for (const job of candidates.rows) {
    try {
      const hhNum: number | null = job.hh_job_number;
      const jobRef = hhNum ? `HH #${hhNum}` : (job.job_name || 'Unknown job');
      const opJobUrl = `${frontendUrl}/jobs/${job.id}`;
      const hhJobUrl = hhNum ? `https://myhirehop.com/job.php?id=${hhNum}` : '';

      // Stamp the marker FIRST — stamp-first, like the sibling scanners.
      await query(
        `UPDATE jobs SET booked_split_alerted_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [job.id]
      );

      const html = `
        <p><strong>Booking not registered in HireHop — OP↔HireHop split-brain.</strong></p>
        <p><strong>${jobRef}</strong>${job.job_name ? ` (${job.job_name})` : ''} has been
        <code>pipeline_status='${job.pipeline_status}'</code> in OP for over 2 hours, but
        HireHop still shows it at status <strong>${job.status ?? 0}</strong> (below Booked).</p>
        <p>This is the job-16513 pattern: the post-payment "Booked" push to HireHop failed
        (typically a 327 rate-limit storm) and the retry keeps failing. The booked-status
        reconciler retries every 30-min sync, so a persistent alert means HireHop is likely
        unreachable or the push is being rejected — please check HireHop and, if needed, set
        the job to Booked manually.</p>
        ${hhJobUrl ? `<p><a href="${hhJobUrl}">Open job in HireHop</a> · ` : '<p>'}<a href="${opJobUrl}">Open job in OP</a></p>
        <p style="color:#888;font-size:12px">Sanity scanner — confirmed in OP, not Booked in HireHop (2h+).</p>
      `;

      const result = await emailService.sendRaw({
        to: 'jon@oooshtours.co.uk',
        subject: `⚠ Booking not in HireHop — ${jobRef}`,
        html,
      });
      if (result.success) warned++;
      else console.warn(`[sanity-scanner] booked-split alert send failed for ${jobRef}:`, result);
    } catch (err) {
      console.error(`[sanity-scanner] booked-split scan error for job ${job.id}:`, err);
    }
  }

  return { checked: candidates.rows.length, warned };
}

/**
 * Best-effort: read the van's most recent book-out event from R2 and return its
 * HireHop job number. The stuck van's live DB assignment points at its PREVIOUS
 * hire (the scramble overwrote the current-hire rows' vehicle_id to the other
 * van), so we can't get the CURRENT job from the DB — the book-out event is the
 * only record of which job the van actually went out on. Returns null on any
 * failure; the alert fires without the number rather than blocking on it.
 */
async function lookupStuckOnHireJob(reg: string): Promise<string | null> {
  try {
    const key = `vehicle-events/${reg.toUpperCase()}/_index.json`;
    const resp = await getFromR2(key);
    if (!resp?.Body) return null;
    const text = await resp.Body.transformToString('utf-8');
    const index = JSON.parse(text) as { events?: Array<Record<string, unknown>> };
    const events = Array.isArray(index.events) ? index.events : [];
    const bookOuts = events
      .filter((e) => String(e.eventType || '').toLowerCase().replace(/[^a-z]/g, '') === 'bookout')
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const latest = bookOuts[0];
    const hh = latest?.hireHopJob;
    return hh != null && String(hh).trim() !== '' ? String(hh).trim() : null;
  } catch {
    return null;
  }
}

/**
 * Detection scanner for the multi-van book-out scramble
 * (docs/MULTI-VAN-BOOKOUT-SCRAMBLE.md §6). Finds vehicles projected
 * `hire_status='On Hire'` that have NO live booked_out/active assignment row —
 * the fingerprint of the scramble (the 2nd van booked out on a job wins every
 * shared row's vehicle_id, so the FIRST van's rows point at the other van and
 * the van is left projected On Hire while owning no assignment, un-checkin-able).
 *
 * Detection mirrors syncFleetHireStatus's "has a live assignment" definition
 * EXACTLY (booked_out/active, excluding rows whose linked job is lost/cancelled
 * via the dual job match), so "no live row" == "syncFleetHireStatus would NOT
 * keep this On Hire". That also catches any other drift where the fleet
 * projection is stale (e.g. the only booked_out row sits on a since-dead job) —
 * a legitimate bonus, self-corrects on the next sync (which demotes to Prep
 * Needed and clears the marker).
 *
 * Alerts jon@ ONCE per stuck van — deduped via
 * fleet_vehicles.stuck_onhire_alerted_at, stamped FIRST (a transient send
 * failure must not re-fire on the next scan). The marker is CLEARED in
 * syncFleetHireStatus whenever the van leaves On Hire. Recipient is jon@ (NOT
 * info@) — this is a data-integrity anomaly he wants to action, not general ops
 * noise.
 */
export async function runStuckOnHireScan(): Promise<{ checked: number; warned: number }> {
  const candidates = await query(
    `SELECT fv.id, fv.reg
       FROM fleet_vehicles fv
      WHERE fv.hire_status = 'On Hire'
        AND COALESCE(fv.is_active, true) = true
        AND fv.stuck_onhire_alerted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM vehicle_hire_assignments vha
           WHERE vha.vehicle_id = fv.id
             AND vha.status IN ('booked_out', 'active')
             AND NOT EXISTS (
               SELECT 1 FROM jobs j
                WHERE ((vha.job_id IS NOT NULL AND j.id = vha.job_id)
                       OR (vha.job_id IS NULL AND j.hh_job_number = vha.hirehop_job_id))
                  AND j.pipeline_status IN ('lost', 'cancelled')
             )
        )
      ORDER BY fv.reg ASC
      LIMIT 100`
  );

  if (candidates.rows.length === 0) return { checked: 0, warned: 0 };

  let warned = 0;
  const frontendUrl = getFrontendUrl();

  for (const row of candidates.rows) {
    try {
      const reg: string = row.reg || '(no reg)';

      // Stamp the marker FIRST — stamp-first, like the sibling scanners.
      await query(
        `UPDATE fleet_vehicles SET stuck_onhire_alerted_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [row.id]
      );

      const hhJob = await lookupStuckOnHireJob(reg);
      const jobLabel = hhJob ? `HH #${hhJob}` : '(could not resolve the current job — see R2 event history)';
      const hhJobUrl = hhJob ? `https://myhirehop.com/job.php?id=${hhJob}` : '';
      const vehicleUrl = `${frontendUrl}/vehicles/fleet/${row.id}`;

      const html = `
        <p><strong>Van stuck "On Hire" with no live assignment — likely the multi-van book-out scramble.</strong></p>
        <p>Vehicle <strong>${reg}</strong> reads <code>hire_status='On Hire'</code> but has NO
        <code>booked_out</code>/<code>active</code> hire assignment row. On a multi-van "everyone drives
        everything" job, a second van's book-out can overwrite the first van's shared rows' <code>vehicle_id</code>,
        leaving this van projected On Hire while owning no assignment — so it can't be checked in.</p>
        <p>Best-guess current job: <strong>${jobLabel}</strong>.</p>
        <p>Fix per <code>docs/MULTI-VAN-BOOKOUT-SCRAMBLE.md</code> — re-create the missing per-van assignment
        row (mileage from the book-out event) so the van can be checked in, then verify photos/PDF.</p>
        ${hhJobUrl ? `<p><a href="${hhJobUrl}">Open job in HireHop</a> · ` : '<p>'}<a href="${vehicleUrl}">Open vehicle in OP</a></p>
        <p style="color:#888;font-size:12px">Detection scanner — On Hire without a live assignment.</p>
      `;

      const result = await emailService.sendRaw({
        to: 'jon@oooshtours.co.uk',
        subject: `⚠ Van stuck On Hire, no assignment — ${reg}${hhJob ? ` (HH #${hhJob})` : ''}`,
        html,
      });
      if (result.success) warned++;
      else console.warn(`[sanity-scanner] stuck-on-hire alert send failed for ${reg}:`, result);
    } catch (err) {
      console.error(`[sanity-scanner] stuck-on-hire scan error for vehicle ${row.id}:`, err);
    }
  }

  return { checked: candidates.rows.length, warned };
}
