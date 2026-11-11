/**
 * Damage money — the Money card on a Problem and on an insurance claim
 * (docs/INCIDENT-CLAIMS-SPEC.md §23). Mounted at /api/damage-money.
 *
 * Reads are services/damage-money.ts. Writes are only the things that had
 * nowhere else to live: what the client paid for this damage, what the
 * insurer paid, and a claim's repair estimate (the broker form's figure).
 * Nothing here moves money — excess and invoices stay on the Money tab,
 * bills and receipts in Money › Costs.
 *
 * Every write is logged on the Problem's or the claim's timeline. A line is
 * never deleted, only stamped deleted_at.
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { getProblemMoney, getClaimMoney } from '../services/damage-money';
import { checkAmounts, RECOVERY_SOURCES, INSURER_PAID_TO } from '../services/damage-money-maths';
import { logIssueEvent } from '../services/job-issues';
import { logClaimEvent } from '../services/incident-claims';

const router = Router();
router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.number().finite().nonnegative().max(10_000_000);

const SOURCE_LABEL: Record<string, string> = { excess: 'from the excess', invoice: 'on an invoice', other: 'paid another way' };
const PAID_TO_LABEL: Record<string, string> = { ooosh: 'paid to us', repairer: 'paid to the repairer' };

const gbp = (n: number) => `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "Recovered from client: £1,000.00 + £200.00 VAT (from the excess) — Bumper" */
function describeLine(l: {
  kind: string; source?: string | null; paid_to?: string | null; description?: string | null;
  amount_net: number; amount_vat: number;
}): string {
  const amount = l.amount_vat > 0 ? `${gbp(l.amount_net)} + ${gbp(l.amount_vat)} VAT` : gbp(l.amount_net);
  const how = l.kind === 'client_recovery' ? SOURCE_LABEL[l.source || ''] : PAID_TO_LABEL[l.paid_to || ''];
  const what = l.kind === 'client_recovery' ? 'Recovered from client' : 'Insurer payment';
  return `${what}: ${amount}${how ? ` (${how})` : ''}${l.description ? ` — ${l.description}` : ''}`;
}

/** Log on the timeline of whatever owns the line. Never fails the write. */
async function logLineEvent(owner: { issue_id: string | null; claim_id: string | null }, userId: string, body: string) {
  try {
    if (owner.issue_id) await logIssueEvent(owner.issue_id, userId, 'money', body);
    else if (owner.claim_id) await logClaimEvent(owner.claim_id, userId, 'money', body);
  } catch (err) {
    console.error('[damage-money] timeline log failed:', err);
  }
}

// ── Reads ────────────────────────────────────────────────────────────────

router.get('/problem/:id', async (req: AuthRequest, res: Response) => {
  try {
    const data = await getProblemMoney(String(req.params.id));
    if (!data) { res.status(404).json({ error: 'Problem not found' }); return; }
    res.json({ data });
  } catch (err) {
    console.error('[damage-money] problem read error:', err);
    res.status(500).json({ error: 'Could not load the money for this Problem' });
  }
});

router.get('/claim/:id', async (req: AuthRequest, res: Response) => {
  try {
    const data = await getClaimMoney(String(req.params.id));
    if (!data) { res.status(404).json({ error: 'Claim not found' }); return; }
    res.json({ data });
  } catch (err) {
    console.error('[damage-money] claim read error:', err);
    res.status(500).json({ error: 'Could not load the money for this claim' });
  }
});

// ── A claim's estimate (the broker form's "Approx. repair cost") ─────────

router.put('/claim/:id/estimate', validate(z.object({ amount_net: money.nullable() })), async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const amount = req.body.amount_net === null ? null : Math.round(req.body.amount_net * 100) / 100;
    // Written into the our_vehicle section without touching its other answers.
    // The section may be missing (or, in theory, not an object) on an old case.
    const r = await query(
      `UPDATE incident_claims
       SET form_data = jsonb_set(
             form_data, '{our_vehicle}',
             CASE WHEN $2::numeric IS NULL
                  THEN (CASE WHEN jsonb_typeof(form_data->'our_vehicle') = 'object' THEN form_data->'our_vehicle' ELSE '{}'::jsonb END) - 'repair_cost'
                  ELSE (CASE WHEN jsonb_typeof(form_data->'our_vehicle') = 'object' THEN form_data->'our_vehicle' ELSE '{}'::jsonb END)
                       || jsonb_build_object('repair_cost', $2::numeric)
             END),
           updated_at = NOW()
       WHERE id = $1 AND is_deleted = false
       RETURNING id`,
      [id, amount],
    );
    if (r.rowCount === 0) { res.status(404).json({ error: 'Claim not found' }); return; }
    await logLineEvent({ issue_id: null, claim_id: id }, req.user!.id,
      amount === null ? 'Repair estimate cleared' : `Repair estimate: ${gbp(amount)} ex VAT`);
    res.json({ data: { ok: true } });
  } catch (err) {
    console.error('[damage-money] estimate error:', err);
    res.status(500).json({ error: 'Could not save the estimate' });
  }
});

// ── Lines: recovered from the client, insurer payments ───────────────────

const amountsShape = {
  amount_net: money.nullable().optional(),
  amount_vat: money.nullable().optional(),
  amount_gross: money.nullable().optional(),
};

const createSchema = z.object({
  issue_id: z.string().guid().nullable().optional(),
  claim_id: z.string().guid().nullable().optional(),
  kind: z.enum(['client_recovery', 'insurer_payment']),
  source: z.enum(RECOVERY_SOURCES as unknown as [string, ...string[]]).nullable().optional(),
  paid_to: z.enum(INSURER_PAID_TO as unknown as [string, ...string[]]).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  entry_date: dateStr.nullable().optional(),
  ...amountsShape,
});

router.post('/lines', validate(createSchema), async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body as z.infer<typeof createSchema>;
    const issueId = b.issue_id || null;
    const claimId = b.claim_id || null;
    if ((issueId === null) === (claimId === null)) {
      res.status(400).json({ error: 'A line belongs to a Problem or a claim' }); return;
    }
    if (b.kind === 'client_recovery' && !b.source) {
      res.status(400).json({ error: 'Say how the client paid it' }); return;
    }
    if (b.kind === 'insurer_payment' && !claimId) {
      res.status(400).json({ error: 'Insurer payments go on the claim' }); return;
    }
    if (b.kind === 'insurer_payment' && !b.paid_to) {
      res.status(400).json({ error: 'Say who the insurer paid' }); return;
    }
    const amounts = checkAmounts(b);
    if (!amounts.ok) { res.status(400).json({ error: amounts.error }); return; }

    const owner = issueId
      ? await query(`SELECT id FROM job_issues WHERE id = $1`, [issueId])
      : await query(`SELECT id FROM incident_claims WHERE id = $1 AND is_deleted = false`, [claimId]);
    if (owner.rowCount === 0) { res.status(404).json({ error: issueId ? 'Problem not found' : 'Claim not found' }); return; }

    const line = {
      kind: b.kind,
      source: b.kind === 'client_recovery' ? b.source! : null,
      paid_to: b.kind === 'insurer_payment' ? b.paid_to! : null,
      description: b.description?.trim() || null,
      amount_net: amounts.net, amount_vat: amounts.vat, amount_gross: amounts.gross,
    };
    const r = await query(
      `INSERT INTO damage_money_lines
         (issue_id, claim_id, kind, source, paid_to, description, amount_net, amount_vat, amount_gross, entry_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11)
       RETURNING id`,
      [issueId, claimId, line.kind, line.source, line.paid_to, line.description,
        line.amount_net, line.amount_vat, line.amount_gross, b.entry_date || null, req.user!.id],
    );
    await logLineEvent({ issue_id: issueId, claim_id: claimId }, req.user!.id, `Added — ${describeLine(line)}`);
    res.status(201).json({ data: { id: r.rows[0].id } });
  } catch (err) {
    console.error('[damage-money] add line error:', err);
    res.status(500).json({ error: 'Could not save that line' });
  }
});

// What a line is FOR (who owns it, which kind) never changes — remove it and
// add a new one instead. Amounts are sent as a set of three.
const editSchema = z.object({
  source: z.enum(RECOVERY_SOURCES as unknown as [string, ...string[]]).optional(),
  paid_to: z.enum(INSURER_PAID_TO as unknown as [string, ...string[]]).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  entry_date: dateStr.nullable().optional(),
  ...amountsShape,
});

router.patch('/lines/:id', validate(editSchema), async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const b = req.body as z.infer<typeof editSchema>;
    const cur = await query(`SELECT * FROM damage_money_lines WHERE id = $1 AND deleted_at IS NULL`, [id]);
    const before = cur.rows[0];
    if (!before) { res.status(404).json({ error: 'Line not found' }); return; }

    const sentAmounts = 'amount_net' in b || 'amount_vat' in b || 'amount_gross' in b;
    const amounts = sentAmounts
      ? checkAmounts(b)
      : { ok: true as const, net: Number(before.amount_net), vat: Number(before.amount_vat), gross: Number(before.amount_gross) };
    if (!amounts.ok) { res.status(400).json({ error: amounts.error }); return; }

    const next = {
      kind: before.kind as string,
      source: before.kind === 'client_recovery' ? (b.source ?? before.source) : null,
      paid_to: before.kind === 'insurer_payment' ? (b.paid_to ?? before.paid_to) : null,
      description: 'description' in b ? (b.description?.trim() || null) : before.description,
      amount_net: amounts.net, amount_vat: amounts.vat, amount_gross: amounts.gross,
    };
    const entryDate = 'entry_date' in b ? (b.entry_date || null) : before.entry_date;
    await query(
      `UPDATE damage_money_lines
       SET source = $2, paid_to = $3, description = $4, amount_net = $5, amount_vat = $6, amount_gross = $7,
           entry_date = $8::date, updated_at = NOW()
       WHERE id = $1`,
      [id, next.source, next.paid_to, next.description, next.amount_net, next.amount_vat, next.amount_gross, entryDate],
    );
    await logLineEvent(before, req.user!.id, `Changed — ${describeLine(next)}`);
    res.json({ data: { ok: true } });
  } catch (err) {
    console.error('[damage-money] edit line error:', err);
    res.status(500).json({ error: 'Could not save that line' });
  }
});

router.delete('/lines/:id', async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `UPDATE damage_money_lines SET deleted_at = NOW(), deleted_by = $2, updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING issue_id, claim_id, kind, source, paid_to, description, amount_net, amount_vat`,
      [String(req.params.id), req.user!.id],
    );
    const l = r.rows[0];
    if (!l) { res.status(404).json({ error: 'Line not found' }); return; }
    await logLineEvent(l, req.user!.id,
      `Removed — ${describeLine({ ...l, amount_net: Number(l.amount_net), amount_vat: Number(l.amount_vat) })}`);
    res.json({ data: { ok: true } });
  } catch (err) {
    console.error('[damage-money] remove line error:', err);
    res.status(500).json({ error: 'Could not remove that line' });
  }
});

export default router;
