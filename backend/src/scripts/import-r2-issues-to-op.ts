/**
 * One-shot import: legacy R2-blob vehicle issues → OP job_issues table.
 *
 * The legacy /api/vehicles/save-issue path wrote VehicleIssue JSON to
 * `issues/{REG}/{id}.json` in R2, with a fleet-wide `issues/_index.json`.
 * Stage 3 (May 2026) replaced this with OP-backed job_issues. PrepPage /
 * CheckInPage / NewIssuePage have been repointed for NEW issues, but
 * historical R2 data sits stranded until this script runs.
 *
 * DEDUP MODEL — the whole point of running this:
 *   Repeated flags of the same component on the same van (e.g. "Fire
 *   extinguisher: Problem" × 5 on RX22SWJ) collapse into ONE OP row
 *   with the legacy entries folded into a `reflagged` event timeline.
 *   The matching key is (vehicle_id, component_key, status-group)
 *   where status-group splits open vs resolved (we don't reopen a
 *   closed issue just because a new one was flagged later).
 *
 * The dedup logic mirrors the runtime auto-create endpoint
 * (POST /api/problems/auto-create) so the historical data ends up
 * shaped the same way a future re-flag would have produced.
 *
 * Photos: legacy issues carry photo URLs pointing at `issues/{REG}/{id}/N.jpg`
 * in R2's public bucket. Migrating those into job_issue_files would
 * involve re-uploading to the private files/ bucket, which is more
 * work than the value warrants for ~40 historical issues. We preserve
 * the URLs in the imported issue's description so staff can still find
 * them — and the legacy R2 keys keep serving until the public bucket
 * is cleared in a future house-cleaning pass.
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/import-r2-issues-to-op.ts                # dry-run
 *   npx tsx src/scripts/import-r2-issues-to-op.ts --commit       # apply
 *   npx tsx src/scripts/import-r2-issues-to-op.ts --commit --vehicle RX22SWJ
 *                                                                # one reg only
 *   npx tsx src/scripts/import-r2-issues-to-op.ts --reset --commit
 *                                                                # WIPE any
 *                                                                # previously-imported
 *                                                                # OP issues
 *                                                                # (metadata.imported_from_r2
 *                                                                # = true on the
 *                                                                # 'created' event)
 *                                                                # then re-import.
 *                                                                # Use when re-running
 *                                                                # to fix a botched run.
 *
 * IDEMPOTENCY:
 *   Without --reset the script is NOT idempotent — re-running with --commit
 *   on the same data will create a SECOND set of OP rows for everything it
 *   sees, because the in-script dedup grouping only collapses blobs within
 *   one invocation, not across runs. If you suspect that's happened, run
 *   with --reset --commit to wipe + start over. The diagnostic this catches:
 *
 *     SELECT fv.reg, ji.component_key, COUNT(*) AS dupes
 *     FROM job_issues ji
 *     LEFT JOIN fleet_vehicles fv ON fv.id = ji.vehicle_id
 *     WHERE ji.source_module = 'vehicle'
 *     GROUP BY 1, 2
 *     HAVING COUNT(*) > 1;
 *
 *   Multiple rows with the same (reg, component_key) and the same
 *   legacy_seed_id on their 'created' events = a double-imported run.
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';
import { listR2Objects, getFromR2 } from '../config/r2';

dotenv.config();

const args = process.argv.slice(2);
const commit = args.includes('--commit');
const reset = args.includes('--reset');
const vehicleArgIdx = args.indexOf('--vehicle');
const vehicleFilter = vehicleArgIdx >= 0 ? args[vehicleArgIdx + 1]?.toUpperCase() : null;

// ── Legacy → OP mapping helpers (server-side mirror of frontend
// op-issue-mapping.ts). Kept duplicated so this script is self-contained
// and doesn't depend on frontend modules.

function mapLegacyComponentToKey(component: string | null | undefined, summary: string): string {
  const c = (component || '').toLowerCase().trim();
  // Curated stable keys for the high-volume recurring items.
  if (c === 'fire extinguisher' || /fire extinguisher/i.test(summary)) return 'fire_extinguisher';
  if (c === 'bodywork panels' || /bodywork/i.test(summary)) return 'bodywork_panels';
  if (c === 'windscreen') return 'windscreen';
  if (c === 'wing mirror' || c === 'mirrors' || c === 'wing mirror left' || c === 'wing mirror right') return 'wing_mirror';
  if (c === 'windows') return 'windows';
  if (c === 'seat belts') return 'seat_belts';
  if (c === 'seats') return 'seats';
  if (c === 'tyres') return 'tyres';
  if (c === 'wheels/rims' || c === 'wheels') return 'wheels';
  if (c === 'brakes') return 'brakes';
  if (c === 'engine') return 'engine';
  if (c === 'exhaust') return 'exhaust';
  if (c === 'suspension') return 'suspension';
  if (c === 'steering') return 'steering';
  if (c === 'gearbox') return 'gearbox';
  if (c === 'lights') return 'lights';
  if (c === 'battery') return 'battery';
  if (c === 'eml') return 'warning_lights';
  if (c === 'heating/ac') return 'climate';
  if (c === 'doors') return 'doors';
  if (c === 'locks') return 'locks';
  if (c === 'bumpers') return 'bumpers';
  if (c === 'interior trim') return 'interior_trim';
  if (c === 'floor') return 'floor';
  if (c === 'entertainment') return 'entertainment';
  // Fall through — slugify whatever's there.
  return c.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'other';
}

function mapLegacyCategoryToOpCategory(category: string | null | undefined): string {
  const c = (category || '').toLowerCase();
  if (c.includes('mechanical') || c.includes('electrical') || c.includes('tyre')) return 'broken';
  if (c.includes('bodywork') || c.includes('interior')) return 'damaged';
  return 'other';
}

function mapLegacySeverity(severity: string | null | undefined): 'low' | 'normal' | 'urgent' {
  const s = (severity || '').toLowerCase();
  if (s === 'critical' || s === 'high') return 'urgent';
  if (s === 'low') return 'low';
  return 'normal';
}

// Pick the worst severity in a group. urgent > normal > low.
function severityRank(s: string): number {
  if (s === 'urgent') return 2;
  if (s === 'normal') return 1;
  return 0;
}

interface LegacyActivity {
  id?: string;
  timestamp?: string;
  author?: string;
  action?: string;
  note?: string;
}

interface LegacyIssue {
  id: string;
  vehicleReg: string;
  vehicleId?: string;
  category?: string;
  component?: string;
  severity?: string;
  summary: string;
  status?: string;  // 'Open' | 'In Progress' | 'Resolved' | etc.
  reportedBy?: string;
  reportedAt: string;
  reportedDuring?: string;
  resolvedAt?: string | null;
  mileageAtReport?: number | null;
  hireHopJob?: string | null;
  photos?: string[];
  activity?: LegacyActivity[];
}

async function readR2Json<T>(key: string): Promise<T | null> {
  try {
    const resp = await getFromR2(key);
    if (!resp.Body) return null;
    const text = await resp.Body.transformToString('utf-8');
    return JSON.parse(text) as T;
  } catch (err: unknown) {
    const code = (err as { name?: string })?.name;
    if (code === 'NoSuchKey') return null;
    throw err;
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    console.log(`Mode: ${commit ? 'COMMIT (will write)' : 'DRY RUN (no changes)'}${reset ? ' + RESET' : ''}`);
    if (vehicleFilter) console.log(`Filter: vehicleReg = ${vehicleFilter}`);
    console.log('');

    // ── 0. Reset previously-imported rows (when --reset is set) ──
    //
    // Finds every job_issues row whose 'created' event has
    // metadata.imported_from_r2 = true and deletes it. The CASCADE on
    // job_issue_events / job_issue_files takes care of the child rows.
    // Without --reset the script ADDS to the existing table, which —
    // combined with the cross-run dedup gap — leads to doubled imports
    // on re-runs. With --reset it's a clean slate.
    //
    // Honours --vehicle: only resets rows for that vehicle if a filter
    // is set, so you can re-import a single vehicle without nuking the
    // rest of the fleet.
    if (reset) {
      console.log('Reset mode — wiping previously-imported issues…');
      const conditions: string[] = [
        `EXISTS (
           SELECT 1 FROM job_issue_events e
           WHERE e.issue_id = ji.id
             AND e.event_type = 'created'
             AND e.metadata->>'imported_from_r2' = 'true'
         )`,
      ];
      const params: unknown[] = [];
      if (vehicleFilter) {
        params.push(vehicleFilter);
        conditions.push(`ji.vehicle_id IN (SELECT id FROM fleet_vehicles WHERE UPPER(reg) = UPPER($${params.length}))`);
      }
      const countResult = await client.query(
        `SELECT COUNT(*)::int AS n FROM job_issues ji WHERE ${conditions.join(' AND ')}`,
        params
      );
      const toDelete = countResult.rows[0].n as number;
      console.log(`  Found ${toDelete} previously-imported issue(s) to wipe`);

      if (toDelete > 0) {
        if (commit) {
          const del = await client.query(
            `DELETE FROM job_issues ji WHERE ${conditions.join(' AND ')}`,
            params
          );
          console.log(`  Deleted ${del.rowCount} row(s) (events + files cascaded)`);
        } else {
          console.log('  (dry run — re-run with --commit to actually wipe)');
        }
      }
      console.log('');
    }

    // ── 1. Discover all legacy issue blobs ──
    console.log('Scanning R2 for legacy issue blobs…');
    const prefix = vehicleFilter ? `issues/${vehicleFilter}/` : 'issues/';
    const objects = await listR2Objects(prefix);
    const issueKeys = objects
      .map(o => o.Key)
      .filter((k): k is string => Boolean(k))
      .filter(k => k.endsWith('.json') && !k.endsWith('/_index.json'));
    console.log(`  Found ${issueKeys.length} legacy issue blob(s)\n`);

    if (issueKeys.length === 0) {
      console.log('Nothing to import. Done.');
      return;
    }

    // ── 2. Load all blobs ──
    const issues: LegacyIssue[] = [];
    for (const key of issueKeys) {
      const issue = await readR2Json<LegacyIssue>(key);
      if (issue && issue.id && issue.vehicleReg) issues.push(issue);
    }
    console.log(`Loaded ${issues.length} valid legacy issue(s)\n`);

    // ── 3. Resolve vehicle reg → fleet_vehicles.id ──
    const regs = Array.from(new Set(issues.map(i => i.vehicleReg.toUpperCase())));
    const regRows = await client.query(
      `SELECT id, reg FROM fleet_vehicles WHERE UPPER(reg) = ANY($1::text[])`,
      [regs]
    );
    const regToId: Map<string, string> = new Map();
    for (const row of regRows.rows) {
      regToId.set(String(row.reg).toUpperCase(), row.id);
    }
    const missingRegs = regs.filter(r => !regToId.has(r));
    if (missingRegs.length > 0) {
      console.warn(`Warning: ${missingRegs.length} reg(s) not in fleet_vehicles — those issues will be skipped:`);
      for (const r of missingRegs) console.warn(`  - ${r}`);
      console.warn('');
    }

    // ── 4. Group by (vehicle_id, component_key, open-or-closed) ──
    // status-group splits open from resolved so we don't fold a resolved
    // historical row into a still-open one (or vice versa). Within each
    // group, the entries collapse into one OP row.
    type GroupKey = string;
    const groups: Map<GroupKey, LegacyIssue[]> = new Map();
    for (const issue of issues) {
      const vehicleId = regToId.get(issue.vehicleReg.toUpperCase());
      if (!vehicleId) continue;
      const componentKey = mapLegacyComponentToKey(issue.component, issue.summary);
      const isResolved = (issue.status || '').toLowerCase() === 'resolved' || !!issue.resolvedAt;
      const groupKey = `${vehicleId}::${componentKey}::${isResolved ? 'resolved' : 'open'}`;
      const arr = groups.get(groupKey) || [];
      arr.push(issue);
      groups.set(groupKey, arr);
    }

    console.log(`${issues.length} legacy issue(s) → ${groups.size} deduped OP group(s)`);
    const dedupSavings = issues.length - groups.size;
    if (dedupSavings > 0) {
      console.log(`  (collapses ${dedupSavings} duplicate flag(s) into reflag-event timelines)`);
    }
    console.log('');

    // ── 5. Insert each group ──
    let createdCount = 0;
    let skippedCount = 0;
    let eventCount = 0;

    // Find a service user to attribute imports to. Falls back to any
    // admin if the migration 031 service user UUID isn't present.
    const systemUserResult = await client.query(
      `SELECT id FROM users WHERE id = '00000000-0000-0000-0000-000000000000'
       UNION ALL
       SELECT id FROM users WHERE role = 'admin' AND is_active = true
       LIMIT 1`
    );
    if (systemUserResult.rowCount === 0) {
      console.error('No system / admin user found to attribute imports to. Aborting.');
      return;
    }
    const importUserId = systemUserResult.rows[0].id;
    console.log(`Importing as user ${importUserId}\n`);

    for (const [groupKey, groupIssues] of groups) {
      // Parse the group key
      const [vehicleId, componentKey, statusGroup] = groupKey.split('::');
      const isResolvedGroup = statusGroup === 'resolved';

      // Sort group chronologically (oldest first). The earliest entry
      // becomes the seed; later entries become reflag events.
      const sorted = [...groupIssues].sort((a, b) =>
        (a.reportedAt || '').localeCompare(b.reportedAt || '')
      );
      const primary = sorted[0];
      if (!primary) continue;

      // Aggregate fields
      const worstSeverity = sorted.reduce<'low' | 'normal' | 'urgent'>(
        (acc, i) => {
          const s = mapLegacySeverity(i.severity);
          return severityRank(s) > severityRank(acc) ? s : acc;
        },
        'low'
      );
      const category = mapLegacyCategoryToOpCategory(primary.category);

      // Compose description: primary summary + any photo URLs preserved.
      const photoUrls = sorted.flatMap(i => i.photos || []);
      const descLines: string[] = [];
      if (photoUrls.length > 0) {
        descLines.push('');
        descLines.push(`Legacy photos (${photoUrls.length}):`);
        for (const url of photoUrls) descLines.push(`  ${url}`);
      }
      const description = descLines.join('\n') || null;

      // Status: keep open if open in legacy. If multiple legacy rows
      // and any was Open, treat the group as open (was_existing logic).
      const status = isResolvedGroup ? 'resolved' : 'open';

      // resolved_at: pick the latest resolvedAt from the group (only
      // meaningful when isResolvedGroup).
      const resolvedAt = isResolvedGroup
        ? sorted.reduce<string | null>((acc, i) => {
            const r = i.resolvedAt || null;
            if (!r) return acc;
            if (!acc) return r;
            return r > acc ? r : acc;
          }, null)
        : null;

      console.log(`Group: vehicle=${vehicleId.slice(0, 8)}… component=${componentKey} status=${status} count=${groupIssues.length}`);
      console.log(`  Primary: "${primary.summary.slice(0, 60)}"`);

      if (!commit) {
        skippedCount++;
        continue;
      }

      // Insert the OP issue. created_at = primary.reportedAt to
      // preserve the historical timestamp.
      await client.query('BEGIN');
      try {
        const insertResult = await client.query(
          `INSERT INTO job_issues (
             job_id, vehicle_id, component_key,
             category, source_module, severity, status, summary, description,
             reported_by, watchers,
             created_at, updated_at, resolved_at
           ) VALUES (
             NULL, $1, $2,
             $3, 'vehicle', $4, $5, $6, $7,
             $8, '{}'::uuid[],
             $9, $10, $11
           )
           RETURNING id`,
          [
            vehicleId, componentKey,
            category, worstSeverity, status, primary.summary.slice(0, 250), description,
            importUserId,
            primary.reportedAt, primary.reportedAt, resolvedAt,
          ]
        );
        const opIssueId = insertResult.rows[0].id;

        // 'created' event for the primary
        await client.query(
          `INSERT INTO job_issue_events (issue_id, event_type, body, metadata, created_by, created_at)
           VALUES ($1, 'created', $2, $3, $4, $5)`,
          [
            opIssueId, primary.summary,
            JSON.stringify({
              imported_from_r2: true,
              legacy_id: primary.id,
              legacy_reported_by: primary.reportedBy,
              legacy_reported_during: primary.reportedDuring,
              legacy_mileage: primary.mileageAtReport,
              legacy_hh_job: primary.hireHopJob,
            }),
            importUserId, primary.reportedAt,
          ]
        );
        eventCount++;

        // Copy activity entries from the primary as comment events
        for (const a of primary.activity || []) {
          if (!a.note) continue;
          const eventBody = a.author ? `${a.author}: ${a.note}` : a.note;
          await client.query(
            `INSERT INTO job_issue_events (issue_id, event_type, body, metadata, created_by, created_at)
             VALUES ($1, 'comment', $2, $3, $4, $5)`,
            [
              opIssueId, eventBody,
              JSON.stringify({ imported_from_r2: true, legacy_activity_id: a.id, legacy_action: a.action }),
              importUserId, a.timestamp || primary.reportedAt,
            ]
          );
          eventCount++;
        }

        // Subsequent legacy issues in the group → 'reflagged' events
        for (let i = 1; i < sorted.length; i++) {
          const dupe = sorted[i]!;
          const eventBody = `Re-flagged: ${dupe.summary}${dupe.reportedBy ? ` (${dupe.reportedBy})` : ''}`;
          await client.query(
            `INSERT INTO job_issue_events (issue_id, event_type, body, metadata, created_by, created_at)
             VALUES ($1, 'reflagged', $2, $3, $4, $5)`,
            [
              opIssueId, eventBody,
              JSON.stringify({
                imported_from_r2: true,
                legacy_id: dupe.id,
                legacy_reported_by: dupe.reportedBy,
                legacy_reported_during: dupe.reportedDuring,
                legacy_summary: dupe.summary,
              }),
              importUserId, dupe.reportedAt,
            ]
          );
          eventCount++;

          // Folding the duplicate's activity entries in too
          for (const a of dupe.activity || []) {
            if (!a.note) continue;
            const ev = a.author ? `${a.author}: ${a.note}` : a.note;
            await client.query(
              `INSERT INTO job_issue_events (issue_id, event_type, body, metadata, created_by, created_at)
               VALUES ($1, 'comment', $2, $3, $4, $5)`,
              [
                opIssueId, ev,
                JSON.stringify({ imported_from_r2: true, legacy_activity_id: a.id, legacy_action: a.action, from_dupe: dupe.id }),
                importUserId, a.timestamp || dupe.reportedAt,
              ]
            );
            eventCount++;
          }
        }

        // resolved event if applicable
        if (isResolvedGroup) {
          await client.query(
            `INSERT INTO job_issue_events (issue_id, event_type, body, metadata, created_by, created_at)
             VALUES ($1, 'resolved', $2, $3, $4, $5)`,
            [opIssueId, 'Resolved (legacy import)', JSON.stringify({ imported_from_r2: true }), importUserId, resolvedAt || primary.reportedAt]
          );
          eventCount++;
        }

        await client.query('COMMIT');
        createdCount++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  FAILED:`, err);
      }
    }

    console.log('');
    console.log('Summary:');
    console.log(`  Legacy issues scanned:   ${issues.length}`);
    console.log(`  Skipped (missing reg):   ${issues.length - issues.filter(i => regToId.has(i.vehicleReg.toUpperCase())).length}`);
    console.log(`  Deduped OP groups:       ${groups.size}`);
    if (commit) {
      console.log(`  OP issues created:       ${createdCount}`);
      console.log(`  Events written:          ${eventCount}`);
    } else {
      console.log(`  Would create:            ${skippedCount}`);
      console.log('\n(Re-run with --commit to apply.)');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
