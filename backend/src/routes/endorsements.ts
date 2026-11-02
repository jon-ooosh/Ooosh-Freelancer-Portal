import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate, AuthRequest, authorize, STAFF_ROLES } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { logAudit } from '../middleware/audit';
import { ukToday } from '../services/uk-date';
import {
  listEndorsements, getEndorsement, createEndorsement, updateEndorsement, markChecked, endEndorsement,
  listBrands, addBrand, updateBrand, type CheckState,
} from '../services/endorsements';

// Artist endorsements — Operations › Backline – Endorsements, plus the panel on
// person / band pages. Any staff member can record and confirm one (jon, Oct 2026).
// All logic lives in services/endorsements.ts.
const router = Router();
router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

const uuid = z.string().uuid();
const optText = z.string().max(2000).optional().nullable();

const endorsementSchema = z.object({
  brand_id: uuid,
  person_id: uuid.optional().nullable(),
  organisation_id: uuid.optional().nullable(),
  who: z.string().max(200).optional().nullable(),
  deal: optText,
  confirmed_with: z.string().max(300).optional().nullable(),
  notes: optText,
  // When the rep / A&R confirmed it — a past date when backfilling; null = not confirmed
  checked_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  checked_now: z.boolean().optional(),
}).refine((d) => (!!d.person_id) !== (!!d.organisation_id), {
  message: 'An endorsement belongs to a person OR a band — pick exactly one',
}).refine((d) => !d.checked_on || d.checked_on <= ukToday(), {
  message: 'The confirmed date can’t be in the future',
});

// ── Brands ──
router.get('/brands', async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await listBrands(req.query.include_inactive === 'true') });
  } catch (err) {
    console.error('List endorsement brands error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/brands', validate(z.object({ name: z.string().trim().min(1).max(100), standard_deal: optText })), async (req: AuthRequest, res: Response) => {
  try {
    const brand = await addBrand(req.body.name, req.body.standard_deal ?? null);
    await logAudit(req.user!.id, 'endorsement_brands', brand.id, 'create', null, brand as unknown as Record<string, unknown>);
    res.status(201).json({ data: brand });
  } catch (err) {
    console.error('Add endorsement brand error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/brands/:id', validate(z.object({
  name: z.string().trim().min(1).max(100).optional(),
  standard_deal: optText,
  is_active: z.boolean().optional(),
})), async (req: AuthRequest, res: Response) => {
  try {
    const brand = await updateBrand(String(req.params.id), req.body);
    if (!brand) { res.status(404).json({ error: 'Brand not found' }); return; }
    await logAudit(req.user!.id, 'endorsement_brands', brand.id, 'update', null, req.body);
    res.json({ data: brand });
  } catch (err) {
    console.error('Update endorsement brand error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Endorsements ──
// ?person_id= | ?organisation_id= (&include_members=true) | ?brand_id= | ?state=unconfirmed|current|stale | ?include_ended=true
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const q = (k: string) => (typeof req.query[k] === 'string' && req.query[k] ? String(req.query[k]) : undefined);
    const isUuid = (v?: string) => !v || /^[0-9a-f-]{36}$/i.test(v);
    if (!isUuid(q('person_id')) || !isUuid(q('organisation_id')) || !isUuid(q('brand_id'))) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const state = q('state');
    res.json({
      data: await listEndorsements({
        personId: q('person_id'),
        organisationId: q('organisation_id'),
        brandId: q('brand_id'),
        state: state && ['unconfirmed', 'current', 'stale'].includes(state) ? (state as CheckState) : undefined,
        includeEnded: req.query.include_ended === 'true',
        includeMembers: req.query.include_members === 'true',
      }),
    });
  } catch (err) {
    console.error('List endorsements error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', validate(endorsementSchema), async (req: AuthRequest, res: Response) => {
  try {
    const e = await createEndorsement(req.body, req.user!.id);
    await logAudit(req.user!.id, 'artist_endorsements', e.id, 'create', null, req.body);
    res.status(201).json({ data: e });
  } catch (err) {
    console.error('Create endorsement error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', validate(endorsementSchema), async (req: AuthRequest, res: Response) => {
  try {
    const before = await getEndorsement(String(req.params.id));
    if (!before) { res.status(404).json({ error: 'Endorsement not found' }); return; }
    const e = await updateEndorsement(before.id, req.body, req.user!.id);
    await logAudit(req.user!.id, 'artist_endorsements', before.id, 'update', before as unknown as Record<string, unknown>, req.body);
    res.json({ data: e });
  } catch (err) {
    console.error('Update endorsement error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/checked', validate(z.object({ confirmed_with: z.string().max(300).optional().nullable() })), async (req: AuthRequest, res: Response) => {
  try {
    const e = await markChecked(String(req.params.id), req.user!.id, req.body.confirmed_with ?? null);
    if (!e) { res.status(404).json({ error: 'Endorsement not found or ended' }); return; }
    await logAudit(req.user!.id, 'artist_endorsements', e.id, 'checked', null, { confirmed_with: e.confirmed_with, last_checked_on: e.last_checked_on });
    res.json({ data: e });
  } catch (err) {
    console.error('Mark endorsement checked error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/end', validate(z.object({ reason: z.string().max(500).optional().nullable() })), async (req: AuthRequest, res: Response) => {
  try {
    const e = await endEndorsement(String(req.params.id), req.body.reason ?? null);
    if (!e) { res.status(404).json({ error: 'Endorsement not found or already ended' }); return; }
    await logAudit(req.user!.id, 'artist_endorsements', e.id, 'end', null, { reason: req.body.reason ?? null });
    res.json({ data: e });
  } catch (err) {
    console.error('End endorsement error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
