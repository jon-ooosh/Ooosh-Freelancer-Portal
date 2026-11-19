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

// ── Link a cost that is already in Money › Costs (§23.1) ──────────────────
//
// The cost form only links a Problem when the cost is CREATED from it. A bill
// that went into Costs first (the usual way) had no route to its Problem.
// These change costs.job_issue_id and NOTHING else: not through PATCH /costs,
// which fires a Xero push for any cost not yet in Xero. Which Problem a cost
// belongs to is OP's own filing; Xero never sees it.

/** "Bodyshop £1,200.00 (INV-123)" for a timeline line. */
function describeCost(c: { supplier_name?: string | null; amount_gross?: unknown; invoice_number?: string | null }): string {
  const gross = Number(c.amount_gross);
  return `${c.supplier_name || 'Cost'}${Number.isFinite(gross) ? ` ${gbp(gross)}` : ''}${c.invoice_number ? ` (${c.invoice_number})` : ''}`;
}

/** On the Problem's timeline, and its claim's too when it is on one. Never fails the write. */
async function logCostEvent(issueId: string, userId: string, body: string) {
  try {
    await logIssueEvent(issueId, userId, 'money', body);
    const c = await query(
      `SELECT ji.claim_id FROM job_issues ji
       JOIN incident_claims c ON c.id = ji.claim_id AND c.is_deleted = false
       WHERE ji.id = $1`,
      [issueId],
    );
    if (c.rows[0]?.claim_id) await logClaimEvent(c.rows[0].claim_id, userId, 'money', body);
  } catch (err) {
    console.error('[damage-money] cost timeline log failed:', err);
  }
}

/**
 * Costs that could belong here. With no search: those on the same hire (whole
 * or split) or the same van. With a search: any cost whose supplier,
 * description or invoice number matches, or whose amount (net or gross) is
 * the number typed. Costs already linked here are left out; one linked to
 * ANOTHER Problem is listed, saying which — linking it moves it.
 */
router.get('/linkable-costs', async (req: AuthRequest, res: Response) => {
  try {
    const issueId = typeof req.query.issue_id === 'string' ? req.query.issue_id : '';
    const claimId = typeof req.query.claim_id === 'string' ? req.query.claim_id : '';
    const guid = z.string().guid();
    let ids: string[] = [];
    let jobId: string | null = null;
    let vehicleId: string | null = null;
    if (guid.safeParse(issueId).success) {
      const r = await query(`SELECT id, job_id, vehicle_id FROM job_issues WHERE id = $1`, [issueId]);
      if (!r.rows[0]) { res.status(404).json({ error: 'Problem not found' }); return; }
      ids = [issueId];
      jobId = r.rows[0].job_id;
      vehicleId = r.rows[0].vehicle_id;
    } else if (guid.safeParse(claimId).success) {
      const r = await query(`SELECT job_id, vehicle_id FROM incident_claims WHERE id = $1 AND is_deleted = false`, [claimId]);
      if (!r.rows[0]) { res.status(404).json({ error: 'Claim not found' }); return; }
      jobId = r.rows[0].job_id;
      vehicleId = r.rows[0].vehicle_id;
      ids = (await query(`SELECT id FROM job_issues WHERE claim_id = $1`, [claimId])).rows.map((p) => p.id);
    } else {
      res.status(400).json({ error: 'Say which Problem or claim' }); return;
    }

    const raw = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
    const search = raw.length >= 2 ? raw.replace(/[\\%_]/g, (m) => `\\${m}`) : null;
    const amountTyped = raw ? Number(raw.replace(/[£,\s]/g, '')) : NaN;
    const amount = Number.isFinite(amountTyped) && amountTyped > 0 ? Math.round(amountTyped * 100) / 100 : null;
    if (!search && !jobId && !vehicleId) { res.json({ data: [] }); return; }

    const r = await query(
      `SELECT c.id, c.supplier_name, c.description, c.invoice_number,
              to_char(c.cost_date, 'YYYY-MM-DD') AS cost_date,
              c.amount_net, c.amount_vat, c.amount_gross,
              c.job_issue_id, ji.summary AS linked_problem_summary
       FROM costs c
       LEFT JOIN job_issues ji ON ji.id = c.job_issue_id
       WHERE (c.job_issue_id IS NULL OR c.job_issue_id <> ALL($1::uuid[]))
         AND (
           ($4::text IS NULL AND (
              c.job_id = $2::uuid OR c.vehicle_id = $3::uuid
              OR EXISTS (SELECT 1 FROM cost_allocations a WHERE a.cost_id = c.id AND a.job_id = $2::uuid)
              -- on another Problem of the same hire or van
              OR ji.job_id = $2::uuid OR ji.vehicle_id = $3::uuid))
           OR ($4::text IS NOT NULL AND (
              c.supplier_name ILIKE '%' || $4 || '%'
              OR c.description ILIKE '%' || $4 || '%'
              OR c.invoice_number ILIKE '%' || $4 || '%'
              OR ($5::numeric IS NOT NULL AND (ABS(c.amount_gross - $5::numeric) < 0.005 OR ABS(c.amount_net - $5::numeric) < 0.005))))
         )
       ORDER BY c.cost_date DESC NULLS LAST, c.created_at DESC
       LIMIT 40`,
      [ids, jobId, vehicleId, search, amount],
    );
    res.json({
      data: r.rows.map((c) => ({
        ...c,
        amount_net: c.amount_net === null ? null : Number(c.amount_net),
        amount_vat: c.amount_vat === null ? null : Number(c.amount_vat),
        amount_gross: c.amount_gross === null ? null : Number(c.amount_gross),
      })),
    });
  } catch (err) {
    console.error('[damage-money] linkable costs error:', err);
    res.status(500).json({ error: 'Could not look up costs' });
  }
});

router.post('/costs/:costId/link', validate(z.object({ issue_id: z.string().guid() })), async (req: AuthRequest, res: Response) => {
  try {
    const costId = String(req.params.costId);
    const issueId = req.body.issue_id as string;
    const issue = await query(`SELECT id, summary FROM job_issues WHERE id = $1`, [issueId]);
    if (!issue.rows[0]) { res.status(404).json({ error: 'Problem not found' }); return; }
    const cur = await query(
      `SELECT c.id, c.supplier_name, c.amount_gross, c.invoice_number, c.job_issue_id
       FROM costs c WHERE c.id = $1`,
      [costId],
    );
    const cost = cur.rows[0];
    if (!cost) { res.status(404).json({ error: 'Cost not found' }); return; }
    if (cost.job_issue_id === issueId) { res.json({ data: { ok: true } }); return; }

    await query(`UPDATE costs SET job_issue_id = $2 WHERE id = $1`, [costId, issueId]);
    const what = describeCost(cost);
    await logCostEvent(issueId, req.user!.id, `Cost linked from Money › Costs: ${what}`);
    if (cost.job_issue_id) {
      await logCostEvent(cost.job_issue_id, req.user!.id, `Cost moved to another Problem (${issue.rows[0].summary}): ${what}`);
    }
    res.json({ data: { ok: true } });
  } catch (err) {
    console.error('[damage-money] link cost error:', err);
    res.status(500).json({ error: 'Could not link that cost' });
  }
});

router.post('/costs/:costId/unlink', validate(z.object({ issue_id: z.string().guid() })), async (req: AuthRequest, res: Response) => {
  try {
    const issueId = req.body.issue_id as string;
    // Only from the Problem it is on — a stale screen can't unlink it from another.
    const r = await query(
      `UPDATE costs SET job_issue_id = NULL WHERE id = $1 AND job_issue_id = $2
       RETURNING supplier_name, amount_gross, invoice_number`,
      [String(req.params.costId), issueId],
    );
    if (!r.rows[0]) { res.status(409).json({ error: 'That cost isn’t on this Problem any more — reload the page.' }); return; }
    await logCostEvent(issueId, req.user!.id, `Cost unlinked (it stays in Money › Costs): ${describeCost(r.rows[0])}`);
    res.json({ data: { ok: true } });
  } catch (err) {
    console.error('[damage-money] unlink cost error:', err);
    res.status(500).json({ error: 'Could not unlink that cost' });
  }
});

export default router;
