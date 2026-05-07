/**
 * Prove what HireHop returns for JOB_NAME on a sub-job (one belonging to a Project).
 *
 * Hypothesis: search_list.php and webhooks return "<Project> ► <JobName>"
 * (display string), while job_data.php returns just the leaf "<JobName>".
 * If true, the fix is to strip the prefix on inbound parse.
 *
 * Run on the server:
 *   cd /var/www/ooosh-portal/backend
 *   npx ts-node src/scripts/check-hh-job-name.ts 15471 15467 15563
 *
 * The numbers are HH job numbers — pass any sample of sub-jobs and a
 * top-level job for comparison. 15471/15467 are TGE26 sub-jobs that
 * were clobbered today; 15563 (Puma Blue) is a top-level job that held.
 */
import { hhBroker } from '../services/hirehop-broker';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: npx ts-node src/scripts/check-hh-job-name.ts <jobNumber> [<jobNumber>...]');
    process.exit(1);
  }

  console.log('Comparing HireHop endpoints for each job:\n');

  for (const arg of args) {
    const jobNumber = parseInt(arg, 10);
    if (Number.isNaN(jobNumber)) {
      console.warn(`Skipping non-numeric arg: ${arg}`);
      continue;
    }

    console.log(`── HH job #${jobNumber} ──────────────────────────────`);

    // 1. job_data.php — single job by ID
    const detail = await hhBroker.get<Record<string, unknown>>(
      '/api/job_data.php',
      { job: jobNumber },
      { priority: 'high', cacheTTL: 0, skipCache: true }
    );

    if (!detail.success || !detail.data) {
      console.log(`  job_data.php:        ERROR — ${detail.error || 'no data'}`);
    } else {
      const d = detail.data as Record<string, unknown>;
      console.log(`  job_data.php JOB_NAME:        ${JSON.stringify(d.JOB_NAME)}`);
      // Look for any other field that might carry project info
      const projectish = Object.keys(d).filter((k) =>
        /project|parent|path|tree|group/i.test(k)
      );
      if (projectish.length > 0) {
        for (const k of projectish) {
          console.log(`  job_data.php ${k}: ${JSON.stringify(d[k])}`);
        }
      } else {
        console.log('  (no project/parent fields in job_data.php response)');
      }
    }

    // 2. search_list.php filtered to this single job — what the sync sees
    const search = await hhBroker.get<{ data?: Array<Record<string, unknown>> }>(
      '/php_functions/search_list.php',
      { jobs: 1, query: String(jobNumber), rows: 5, page: 1 },
      { priority: 'high', cacheTTL: 0, skipCache: true }
    );

    if (!search.success || !search.data) {
      console.log(`  search_list.php:     ERROR — ${search.error || 'no data'}`);
    } else {
      const rows = (search.data as { data?: Array<Record<string, unknown>> }).data || [];
      const match = rows.find((r) => Number(r.NUMBER) === jobNumber);
      if (!match) {
        console.log(`  search_list.php:     no row matched (got ${rows.length} rows)`);
      } else {
        console.log(`  search_list.php JOB_NAME:     ${JSON.stringify(match.JOB_NAME)}`);
      }
    }

    console.log('');
  }

  console.log('Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Script error:', err);
  process.exit(1);
});
