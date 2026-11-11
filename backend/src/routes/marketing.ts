/**
 * The Marketing page — admin only (docs/BUSINESS-FIGURES-SPEC.md §8, step 2).
 *
 *   GET   /placements            adverts, with scans / enquiries / bookings
 *   POST  /placements            add an advert
 *   PATCH /placements/:id        change one (status 'cancelled' instead of deleting)
 *   GET   /links                 tracked links, with the same counts
 *   POST  /links                 make one (code from the name unless given)
 *   PATCH /links/:id             repoint / pause / rename it (the code never changes — it's printed)
 *   GET   /links/:id/qr          { url, svg, png } for the artwork
 *
 * The public redirect is routes/go.ts.
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { validate, partialForUpdate } from '../middleware/validate';
import { query } from '../config/database';
import { CHANNELS, PLACEMENT_STATUSES, linkQr, listLinks, listPlacements, syncDueReminder } from '../services/marketing';
import { checkDestination, isValidCode, normaliseCode } from '../services/marketing-links';

const router = Router();
router.use(authenticate);
router.use(authorize('admin'));

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date (YYYY-MM-DD)');
const idParam = z.object({ id: z.string().guid() });

function fail(res: Response, where: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  // Our own checks throw plain messages meant for the person; database faults don't.
  if (/destination|code|already/i.test(msg)) {
    res.status(400).json({ error: msg });
    return;
  }
  console.error(`[marketing] ${where}:`, err);
  res.status(500).json({ error: 'Something went wrong — please try again.' });
}

// ── Adverts ────────────────────────────────────────────────────────────────

const placementSchema = z.object({
  name: z.string().trim().min(1).max(200),
  channel: z.enum(CHANNELS),
  supplier: z.string().trim().max(200).nullable().optional(),
  cost: z.number().min(0).max(1_000_000).nullable().optional(),
  startsOn: isoDate.nullable().optional(),
  endsOn: isoDate.nullable().optional(),
  nextDueOn: isoDate.nullable().optional(),
  nextDueNote: z.string().trim().max(200).nullable().optional(),
  proofReceivedOn: isoDate.nullable().optional(),
  artworkUrl: z.string().trim().max(2000).nullable().optional(),
  status: z.enum(PLACEMENT_STATUSES).optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const COLUMN: Record<string, string> = {
  name: 'name', channel: 'channel', supplier: 'supplier', cost: 'cost', startsOn: 'starts_on', endsOn: 'ends_on',
  nextDueOn: 'next_due_on', nextDueNote: 'next_due_note', proofReceivedOn: 'proof_received_on',
  artworkUrl: 'artwork_url', status: 'status', notes: 'notes',
};

router.get('/placements', async (_req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await listPlacements() });
  } catch (err) {
    fail(res, 'placements', err);
  }
});

router.post('/placements', validate(placementSchema), async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body as z.infer<typeof placementSchema>;
    const keys = Object.keys(COLUMN).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    const r = await query(
      `INSERT INTO marketing_placements (${keys.map((k) => COLUMN[k]).join(', ')}, created_by)
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}, $${keys.length + 1}) RETURNING id`,
      [...keys.map((k) => (b as Record<string, unknown>)[k] ?? null), req.user!.id],
    );
    const id = r.rows[0].id as string;
    await syncDueReminder(id, req.user!.id, req.user!.role);
    res.status(201).json({ data: { id } });
  } catch (err) {
    fail(res, 'placement create', err);
  }
});

router.patch('/placements/:id', validate(idParam, 'params'), validate(partialForUpdate(placementSchema)), async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body as Record<string, unknown>;
    const keys = Object.keys(COLUMN).filter((k) => k in b);
    if (keys.length === 0) {
      res.status(400).json({ error: 'Nothing to change' });
      return;
    }
    const r = await query(
      `UPDATE marketing_placements SET ${keys.map((k, i) => `${COLUMN[k]} = $${i + 1}`).join(', ')}, updated_at = NOW()
        WHERE id = $${keys.length + 1} RETURNING id`,
      [...keys.map((k) => b[k] ?? null), req.params.id],
    );
    if (!r.rows.length) {
      res.status(404).json({ error: 'Advert not found' });
      return;
    }
    if (keys.some((k) => ['nextDueOn', 'nextDueNote', 'name', 'status'].includes(k))) {
      await syncDueReminder(String(req.params.id), req.user!.id, req.user!.role);
    }
    res.json({ data: { id: req.params.id } });
  } catch (err) {
    fail(res, 'placement update', err);
  }
});

// ── Tracked links ──────────────────────────────────────────────────────────

const linkSchema = z.object({
  code: z.string().trim().max(80).optional(),
  label: z.string().trim().max(200).nullable().optional(),
  destination: z.string().trim().min(1).max(2000),
  placementId: z.string().guid().nullable().optional(),
  utmSource: z.string().trim().max(100).nullable().optional(),
  utmMedium: z.string().trim().max(100).nullable().optional(),
});
const linkUpdateSchema = z.object({
  label: z.string().trim().max(200).nullable().optional(),
  destination: z.string().trim().min(1).max(2000).optional(),
  placementId: z.string().guid().nullable().optional(),
  utmSource: z.string().trim().max(100).nullable().optional(),
  utmMedium: z.string().trim().max(100).nullable().optional(),
  isActive: z.boolean().optional(),
});

router.get('/links', async (_req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await listLinks() });
  } catch (err) {
    fail(res, 'links', err);
  }
});

router.post('/links', validate(linkSchema), async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body as z.infer<typeof linkSchema>;
    const destination = checkDestination(b.destination);
    const code = normaliseCode(b.code || b.label || '');
    if (!isValidCode(code)) {
      res.status(400).json({ error: 'Give the link a short code (letters, numbers and dashes), e.g. brighton-source-dec' });
      return;
    }
    const taken = await query(`SELECT 1 FROM marketing_links WHERE code = $1`, [code]);
    if (taken.rows.length) {
      res.status(400).json({ error: `The code "${code}" is already used — codes are printed, so each one is used once.` });
      return;
    }
    const r = await query(
      `INSERT INTO marketing_links (code, label, destination, placement_id, utm_source, utm_medium, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [code, b.label ?? null, destination, b.placementId ?? null, b.utmSource ?? null, b.utmMedium ?? null, req.user!.id],
    );
    res.status(201).json({ data: { id: r.rows[0].id, code } });
  } catch (err) {
    fail(res, 'link create', err);
  }
});

router.patch('/links/:id', validate(idParam, 'params'), validate(linkUpdateSchema), async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body as z.infer<typeof linkUpdateSchema>;
    const cols: Record<string, string> = {
      label: 'label', destination: 'destination', placementId: 'placement_id',
      utmSource: 'utm_source', utmMedium: 'utm_medium', isActive: 'is_active',
    };
    const keys = Object.keys(cols).filter((k) => k in b);
    if (!keys.length) {
      res.status(400).json({ error: 'Nothing to change' });
      return;
    }
    const values = keys.map((k) => (k === 'destination' ? checkDestination(b.destination as string) : (b as Record<string, unknown>)[k] ?? null));
    const r = await query(
      `UPDATE marketing_links SET ${keys.map((k, i) => `${cols[k]} = $${i + 1}`).join(', ')}, updated_at = NOW()
        WHERE id = $${keys.length + 1} RETURNING id`,
      [...values, req.params.id],
    );
    if (!r.rows.length) {
      res.status(404).json({ error: 'Link not found' });
      return;
    }
    res.json({ data: { id: req.params.id } });
  } catch (err) {
    fail(res, 'link update', err);
  }
});

router.get('/links/:id/qr', validate(idParam, 'params'), async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(`SELECT code FROM marketing_links WHERE id = $1`, [req.params.id]);
    if (!r.rows.length) {
      res.status(404).json({ error: 'Link not found' });
      return;
    }
    res.json({ data: await linkQr(String(r.rows[0].code)) });
  } catch (err) {
    fail(res, 'link qr', err);
  }
});

export default router;
