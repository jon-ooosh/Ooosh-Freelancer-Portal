/**
 * HireHop Job Sync Service
 *
 * Reads jobs from HireHop via search_list.php and syncs them into the Ooosh jobs table.
 * - Fetches active jobs (statuses 0-8) paginated
 * - Upserts into jobs table, matched by hh_job_number
 * - Links to existing organisations/venues via external_id_map
 * - Respects HireHop rate limits (max 60/min, 3/sec → 5s delay per page as recommended)
 */
import { query, getClient } from '../config/database';
import { hireHopGet } from '../config/hirehop';

// HireHop status code → human-readable name
const HH_JOB_STATUS_MAP: Record<number, string> = {
  0: 'Enquiry',
  1: 'Provisional',
  2: 'Booked',
  3: 'Prepped',
  4: 'Part Dispatched',
  5: 'Dispatched',
  6: 'Returned Incomplete',
  7: 'Returned',
  8: 'Requires Attention',
  9: 'Cancelled',
  10: 'Not Interested',
  11: 'Completed',
};

// Active statuses worth syncing (not dead/done)
const HH_ACTIVE_STATUSES = [0, 1, 2, 3, 4, 5, 6, 7, 8];

// ── HireHop search_list response types ───────────────────────────────────

interface HHJobRow {
  ID: string;           // Prefixed: "j123" for jobs, "p123" for projects
  kind: number;         // 1 = job, 6 = project
  NUMBER: number;       // The actual job/project number
  COLOUR: string;       // Hex colour
  CLIENT: string;       // Customer name
  CLIENT_REF: string;   // Client reference
  COMPANY: string;      // Company name
  CREATE_DATE: string;  // UTC datetime
  OUT_DATE: string;     // Local outgoing datetime
  JOB_DATE: string;     // Local start datetime
  JOB_END: string;      // Local end datetime
  RETURN_DATE: string;  // Local return datetime
  JOB_NAME: string;     // Job name
  VENUE: string;        // Delivery address name
  JOB_TYPE: string;     // Job type
  DEPOT: number;        // Depot ID
  STATUS: number;       // Status code (float in API, we use integer part)
  CREATE_USER: string;  // Creator name
  MANAGER: string;      // Manager 1 name
  MANAGER2: string;     // Manager 2 name
  MONEY: number;        // Money owed/owing
  CUSTOM_INDEX: string;
  CUSTOM_FIELDS: string; // JSON
  INVOICED: number;
}

interface HHSearchResponse {
  page: number;
  total: number;
  totalRecords: number;
  data: HHJobRow[];
  error?: string | number;
}

// ── Fetch active jobs from HireHop (paginated) ──────────────────────────

export async function fetchActiveHireHopJobs(): Promise<HHJobRow[]> {
  const allJobs: HHJobRow[] = [];
  let page = 1;
  const rows = 100; // Max per page

  // Only fetch active statuses
  const statusFilter = HH_ACTIVE_STATUSES.join(',');

  while (true) {
    const result = await hireHopGet<HHSearchResponse>('/php_functions/search_list.php', {
      jobs: 1,
      status: statusFilter,
      page,
      rows,
    });

    if (!result.success || !result.data) {
      throw new Error(`Failed to fetch HireHop jobs page ${page}: ${result.error}`);
    }

    const data = result.data;

    if (data.error) {
      throw new Error(`HireHop search error: ${data.error}`);
    }

    // Filter to jobs only (kind=1), skip projects (kind=6)
    const jobs = data.data.filter(j => j.kind === 1);
    allJobs.push(...jobs);

    console.log(`[HH Job Sync] Fetched page ${page}/${data.total} (${jobs.length} jobs, ${allJobs.length} total)`);

    if (page >= data.total) break;
    page++;

    // Rate limit: 5 second delay between pages as recommended by HH docs
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  return allJobs;
}

// ── Sync jobs into Ooosh ─────────────────────────────────────────────────

export interface JobSyncResult {
  jobsCreated: number;
  jobsUpdated: number;
  clientsLinked: number;
  venuesLinked: number;
  errors: string[];
  total: number;
}

export async function syncJobsFromHireHop(userId: string): Promise<JobSyncResult> {
  const result: JobSyncResult = {
    jobsCreated: 0,
    jobsUpdated: 0,
    clientsLinked: 0,
    venuesLinked: 0,
    errors: [],
    total: 0,
  };

  const jobs = await fetchActiveHireHopJobs();
  result.total = jobs.length;

  console.log(`[HH Job Sync] Processing ${jobs.length} active jobs`);

  // Pre-load all HireHop org mappings for client linking
  const orgMappings = await query(
    `SELECT external_id, entity_id FROM external_id_map
     WHERE external_system = 'hirehop' AND entity_type = 'organisations'`
  );
  const orgMap = new Map<string, string>();
  for (const row of orgMappings.rows) {
    orgMap.set(row.external_id, row.entity_id);
  }

  // Process jobs in batches to manage transactions
  for (const job of jobs) {
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const jobNumber = job.NUMBER;
      const statusCode = Math.floor(job.STATUS); // Integer part of status
      const statusName = HH_JOB_STATUS_MAP[statusCode] || `Unknown (${statusCode})`;

      // Check if job already exists
      const existing = await client.query(
        `SELECT id FROM jobs WHERE hh_job_number = $1`,
        [jobNumber]
      );

      // Try to link client org via external_id_map
      // We don't have CLIENT_ID from search_list, so match by company name
      let clientOrgId: string | null = null;
      if (job.COMPANY) {
        // Try exact match on org name first
        const orgMatch = await client.query(
          `SELECT id FROM organisations
           WHERE lower(name) = lower($1) AND is_deleted = false
           LIMIT 1`,
          [job.COMPANY.trim()]
        );
        if (orgMatch.rows.length > 0) {
          clientOrgId = orgMatch.rows[0].id;
          result.clientsLinked++;
        }
      }

      // Try to link venue
      let venueId: string | null = null;
      if (job.VENUE) {
        const venueMatch = await client.query(
          `SELECT id FROM venues
           WHERE lower(name) = lower($1) AND is_deleted = false
           LIMIT 1`,
          [job.VENUE.trim()]
        );
        if (venueMatch.rows.length > 0) {
          venueId = venueMatch.rows[0].id;
          result.venuesLinked++;
        }
      }

      if (existing.rows.length > 0) {
        // Update existing job — HH-owned fields only (never overwrite pipeline fields)
        await client.query(
          `UPDATE jobs SET
             job_name = $1, job_type = $2, status = $3, status_name = $4,
             colour = $5, client_id = COALESCE($6, client_id),
             client_name = $7, company_name = $8, client_ref = $9,
             venue_id = COALESCE($10, venue_id), venue_name = $11,
             out_date = $12, job_date = $13, job_end = $14, return_date = $15,
             created_date = $16, manager1_name = $17, manager2_name = $18,
             custom_index = $19, job_value = $20, hh_status = $3,
             updated_at = NOW()
           WHERE hh_job_number = $21`,
          [
            job.JOB_NAME || null,
            job.JOB_TYPE || null,
            statusCode,
            statusName,
            job.COLOUR || null,
            clientOrgId,
            job.CLIENT || null,
            job.COMPANY || null,
            job.CLIENT_REF || null,
            venueId,
            job.VENUE || null,
            job.OUT_DATE || null,
            job.JOB_DATE || null,
            job.JOB_END || null,
            job.RETURN_DATE || null,
            job.CREATE_DATE || null,
            job.MANAGER || null,
            job.MANAGER2 || null,
            job.CUSTOM_INDEX || null,
            job.MONEY || null,
            jobNumber,
          ]
        );
        result.jobsUpdated++;
      } else {
        // Create new job — set pipeline_status based on HH status
        const initialPipelineStatus =
          statusCode === 0 ? 'new_enquiry' :
          statusCode === 1 ? 'provisional' :
          statusCode >= 2 && statusCode <= 8 ? 'confirmed' :
          statusCode === 9 || statusCode === 10 ? 'lost' :
          statusCode === 11 ? 'confirmed' : 'new_enquiry';

        const jobResult = await client.query(
          `INSERT INTO jobs (
             hh_job_number, job_name, job_type, status, status_name,
             colour, client_id, client_name, company_name, client_ref,
             venue_id, venue_name, out_date, job_date, job_end, return_date,
             created_date, manager1_name, manager2_name, custom_index, created_by,
             job_value, hh_status, pipeline_status, pipeline_status_changed_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
             $22, $4, $23, NOW()
           ) RETURNING id`,
          [
            jobNumber,
            job.JOB_NAME || null,
            job.JOB_TYPE || null,
            statusCode,
            statusName,
            job.COLOUR || null,
            clientOrgId,
            job.CLIENT || null,
            job.COMPANY || null,
            job.CLIENT_REF || null,
            venueId,
            job.VENUE || null,
            job.OUT_DATE || null,
            job.JOB_DATE || null,
            job.JOB_END || null,
            job.RETURN_DATE || null,
            job.CREATE_DATE || null,
            job.MANAGER || null,
            job.MANAGER2 || null,
            job.CUSTOM_INDEX || null,
            userId,
            job.MONEY || null,
            initialPipelineStatus,
          ]
        );

        // Map in external_id_map
        await client.query(
          `INSERT INTO external_id_map (entity_type, entity_id, external_system, external_id)
           VALUES ('jobs', $1, 'hirehop', $2)
           ON CONFLICT (entity_type, entity_id, external_system) DO UPDATE SET
             external_id = $2, synced_at = NOW()`,
          [jobResult.rows[0].id, String(jobNumber)]
        );
        result.jobsCreated++;
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      const errMsg = `Job ${job.NUMBER} (${job.JOB_NAME}): ${err}`;
      console.error(`[HH Job Sync] Error:`, errMsg);
      result.errors.push(errMsg);
    } finally {
      client.release();
    }
  }

  console.log(`[HH Job Sync] Complete:`, {
    jobsCreated: result.jobsCreated,
    jobsUpdated: result.jobsUpdated,
    clientsLinked: result.clientsLinked,
    venuesLinked: result.venuesLinked,
    errors: result.errors.length,
  });

  return result;
}

/**
 * Preview what jobs would be synced (dry run)
 */
export async function previewHireHopJobSync(): Promise<{
  totalActiveJobs: number;
  alreadySynced: number;
  newJobs: number;
  byStatus: Record<string, number>;
  sample: Array<{ number: number; name: string; client: string; status: string; date: string }>;
}> {
  const jobs = await fetchActiveHireHopJobs();

  // Count already synced
  const synced = await query(
    `SELECT COUNT(*) FROM jobs`
  );

  // Get existing job numbers
  const existingNumbers = await query(
    `SELECT hh_job_number FROM jobs`
  );
  const existingSet = new Set(existingNumbers.rows.map(r => r.hh_job_number));

  const newJobs = jobs.filter(j => !existingSet.has(j.NUMBER));

  // Count by status
  const byStatus: Record<string, number> = {};
  for (const job of jobs) {
    const statusCode = Math.floor(job.STATUS);
    const statusName = HH_JOB_STATUS_MAP[statusCode] || `Unknown (${statusCode})`;
    byStatus[statusName] = (byStatus[statusName] || 0) + 1;
  }

  return {
    totalActiveJobs: jobs.length,
    alreadySynced: parseInt(synced.rows[0].count),
    newJobs: newJobs.length,
    byStatus,
    sample: jobs.slice(0, 10).map(j => ({
      number: j.NUMBER,
      name: j.JOB_NAME,
      client: j.COMPANY || j.CLIENT,
      status: HH_JOB_STATUS_MAP[Math.floor(j.STATUS)] || `${j.STATUS}`,
      date: j.JOB_DATE,
    })),
  };
}
