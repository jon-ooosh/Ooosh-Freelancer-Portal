import { Router, Response } from 'express';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { isHireHopConfigured } from '../config/hirehop';
import { previewHireHopSync, syncContactsFromHireHop } from '../services/hirehop-sync';
import { query } from '../config/database';

const router = Router();
router.use(authenticate);
router.use(authorize('admin', 'manager'));

// GET /api/hirehop/status — check if HireHop is configured
router.get('/status', async (_req: AuthRequest, res: Response) => {
  res.json({
    configured: isHireHopConfigured(),
    domain: process.env.HIREHOP_DOMAIN || 'myhirehop.com',
  });
});

// GET /api/hirehop/preview — preview what would be synced (dry run)
router.get('/preview', async (_req: AuthRequest, res: Response) => {
  try {
    if (!isHireHopConfigured()) {
      res.status(400).json({ error: 'HireHop not configured. Set HIREHOP_API_TOKEN in .env' });
      return;
    }

    const preview = await previewHireHopSync();
    res.json(preview);
  } catch (error) {
    console.error('HireHop preview error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Preview failed' });
  }
});

// POST /api/hirehop/sync — run the contact sync from HireHop
router.post('/sync', async (req: AuthRequest, res: Response) => {
  try {
    if (!isHireHopConfigured()) {
      res.status(400).json({ error: 'HireHop not configured. Set HIREHOP_API_TOKEN in .env' });
      return;
    }

    const result = await syncContactsFromHireHop(req.user!.id);
    res.json(result);
  } catch (error) {
    console.error('HireHop sync error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Sync failed' });
  }
});

// GET /api/hirehop/mappings — show synced records
router.get('/mappings', async (_req: AuthRequest, res: Response) => {
  try {
    const mappings = await query(
      `SELECT
         eim.entity_type, eim.external_id as hirehop_id, eim.synced_at,
         CASE
           WHEN eim.entity_type = 'people' THEN (SELECT CONCAT(p.first_name, ' ', p.last_name) FROM people p WHERE p.id = eim.entity_id)
           WHEN eim.entity_type = 'organisations' THEN (SELECT o.name FROM organisations o WHERE o.id = eim.entity_id)
           WHEN eim.entity_type = 'venues' THEN (SELECT v.name FROM venues v WHERE v.id = eim.entity_id)
           ELSE NULL
         END as name
       FROM external_id_map eim
       WHERE eim.external_system = 'hirehop' OR eim.external_system = 'hirehop_venue'
       ORDER BY eim.synced_at DESC
       LIMIT 100`
    );

    const counts = await query(
      `SELECT entity_type, COUNT(*) as count
       FROM external_id_map
       WHERE external_system IN ('hirehop', 'hirehop_venue')
       GROUP BY entity_type`
    );

    res.json({
      mappings: mappings.rows,
      counts: counts.rows,
    });
  } catch (error) {
    console.error('Mappings error:', error);
    res.status(500).json({ error: 'Failed to load mappings' });
  }
});

export default router;
