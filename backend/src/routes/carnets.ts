/**
 * ATA Carnet management — routes.
 *
 * Slice 1 (foundation): read-only endpoints to validate that the HH-derived
 * carnet records are being created. Full CRUD, the public client request form,
 * GMR management, send-timing and PDF generation land in later slices.
 *
 * See docs/CARNET-SPEC.md.
 */
import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';

const router = Router();

router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

// GET /api/carnets — Operations overview list (both modes).
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { mode, status, q } = req.query as { mode?: string; status?: string; q?: string };
    const conditions: string[] = ['j.is_deleted = false'];
    const params: unknown[] = [];

    if (mode) { params.push(mode); conditions.push(`c.mode = $${params.length}`); }
    if (status) { params.push(status); conditions.push(`c.status = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      conditions.push(`(j.job_name ILIKE $${params.length} OR j.client_name ILIKE $${params.length} OR j.hh_job_number::text ILIKE $${params.length})`);
    }

    const result = await query(
      `SELECT c.id, c.job_id, c.mode, c.status, c.format, c.custody_location,
              c.carnet_start_date, c.carnet_expiry_date, c.chase_date,
              c.form_sent_at, c.form_submitted_at, c.created_at, c.updated_at,
              j.hh_job_number, j.job_name, j.client_name, j.job_date,
              (SELECT COUNT(*) FROM carnet_gmrs g WHERE g.carnet_id = c.id) AS gmr_count,
              (SELECT COUNT(*) FROM carnet_gmrs g WHERE g.carnet_id = c.id AND g.status = 'sent') AS gmr_sent_count
       FROM job_carnets c
       JOIN jobs j ON j.id = c.job_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY j.job_date ASC NULLS LAST, c.created_at DESC`,
      params
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('[carnets] list error:', err);
    res.status(500).json({ error: 'Failed to load carnets' });
  }
});

// GET /api/carnets/by-job/:jobId — the carnet (+ GMRs) for a single job.
router.get('/by-job/:jobId', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT * FROM job_carnets WHERE job_id = $1 AND status <> 'cancelled' LIMIT 1`,
      [req.params.jobId]
    );
    if (result.rows.length === 0) return res.json({ data: null });
    const carnet = result.rows[0];
    const gmrs = await query(
      `SELECT * FROM carnet_gmrs WHERE carnet_id = $1 ORDER BY sort_order, crossing_date NULLS LAST, created_at`,
      [carnet.id]
    );
    res.json({ data: { ...carnet, gmrs: gmrs.rows } });
  } catch (err) {
    console.error('[carnets] by-job error:', err);
    res.status(500).json({ error: 'Failed to load carnet' });
  }
});

// GET /api/carnets/:id — single carnet + GMRs.
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(`SELECT * FROM job_carnets WHERE id = $1`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Carnet not found' });
    const carnet = result.rows[0];
    const gmrs = await query(
      `SELECT * FROM carnet_gmrs WHERE carnet_id = $1 ORDER BY sort_order, crossing_date NULLS LAST, created_at`,
      [carnet.id]
    );
    res.json({ data: { ...carnet, gmrs: gmrs.rows } });
  } catch (err) {
    console.error('[carnets] get error:', err);
    res.status(500).json({ error: 'Failed to load carnet' });
  }
});

export default router;
