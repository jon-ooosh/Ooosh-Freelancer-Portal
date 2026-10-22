/**
 * ONE-OFF: link the freelancer invoices captured before "Whose invoice?"
 * existed to their freelancer (docs/FREELANCER-PORTAL-SPEC.md §5, jon, Oct 2026).
 *
 * The office uses it once, after which every new freelancer invoice is linked
 * at upload. It is deliberately self-contained so it can be DELETED once done:
 * this file, its mount in routes/index.ts, frontend/src/pages/
 * LinkFreelancerInvoicesPage.tsx, its route in App.tsx and the button on the
 * Costs page.
 *
 * From 6 April 2026 (this tax year, and roughly when OP went live): earlier
 * invoices aren't asked about. Linking sets costs.person_id only where it is
 * empty; it never moves money or touches Xero.
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, MANAGER_ROLES } from '../middleware/auth';
import { normaliseSupplierName } from '../services/supplier-match';
import { suggestInvoicePerson } from '../services/freelancer-invoice-person';

export const BACKLOG_FROM = '2026-04-06';

const router = Router();
router.use(authenticate);
router.use(authorize(...MANAGER_ROLES));

// GET / → { groups: unlinked invoices by letterhead, each with a suggested
//          freelancer }, { toTick: linked but unpaid invoices with no work ticked }
router.get('/', async (_req: AuthRequest, res: Response) => {
  try {
    const unlinked = await query(
      `SELECT id, supplier_name, invoice_number, cost_date::text AS cost_date, amount_gross, payment_status
         FROM costs
        WHERE cost_type = 'freelancer_invoice' AND person_id IS NULL
          AND COALESCE(is_credit, false) = false
          AND cost_date >= $1::date
        ORDER BY cost_date DESC`,
      [BACKLOG_FROM],
    );
    const groups = new Map<string, { key: string; names: Set<string>; invoices: Record<string, unknown>[] }>();
    for (const r of unlinked.rows) {
      const key = normaliseSupplierName(r.supplier_name || '') || `blank:${r.id}`;
      const g = groups.get(key) || { key, names: new Set<string>(), invoices: [] };
      if (r.supplier_name) g.names.add(r.supplier_name);
      g.invoices.push(r);
      groups.set(key, g);
    }
    const out = [];
    for (const g of groups.values()) {
      const printed = [...g.names][0] || '';
      const suggestion = printed ? await suggestInvoicePerson(printed) : { person: null, source: 'none' as const };
      out.push({
        key: g.key,
        names: [...g.names],
        invoices: g.invoices,
        total: Math.round(g.invoices.reduce((t, i) => t + Number(i.amount_gross || 0), 0) * 100) / 100,
        suggestion,
      });
    }
    out.sort((a, b) => b.invoices.length - a.invoices.length || a.names.join().localeCompare(b.names.join()));

    // Linked, not yet paid, and no work ticked: these show as "With us" in
    // Earnings without their jobs until someone ticks them.
    const toTick = await query(
      `SELECT c.id, c.supplier_name, c.invoice_number, c.cost_date::text AS cost_date, c.amount_gross,
              c.payment_status, c.approval_state, c.person_id,
              p.first_name, p.last_name, p.preferred_name
         FROM costs c
         JOIN people p ON p.id = c.person_id
        WHERE c.cost_type = 'freelancer_invoice' AND c.payment_status <> 'paid'
          AND COALESCE(c.is_credit, false) = false
          AND c.cost_date >= $1::date
          AND NOT EXISTS (SELECT 1 FROM cost_work_items w WHERE w.cost_id = c.id)
        ORDER BY c.cost_date DESC`,
      [BACKLOG_FROM],
    );

    res.json({ data: { from: BACKLOG_FROM, groups: out, toTick: toTick.rows } });
  } catch (err) {
    console.error('[freelancer-invoice-backlog] list error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const linkSchema = z.object({
  cost_ids: z.array(z.string().uuid()).min(1).max(500),
  person_id: z.string().uuid(),
});

// POST /link { cost_ids, person_id } → links those invoices (only where unlinked).
router.post('/link', async (req: AuthRequest, res: Response) => {
  try {
    const parse = linkSchema.safeParse(req.body);
    if (!parse.success) { res.status(400).json({ error: 'Pick the freelancer and the invoices' }); return; }
    const person = await query(
      `SELECT id FROM people WHERE id = $1 AND COALESCE(is_deleted, false) = false`,
      [parse.data.person_id],
    );
    if (!person.rows.length) { res.status(404).json({ error: 'That person isn\'t in the address book' }); return; }
    const r = await query(
      `UPDATE costs SET person_id = $1
        WHERE id = ANY($2::uuid[]) AND cost_type = 'freelancer_invoice' AND person_id IS NULL
        RETURNING id`,
      [parse.data.person_id, parse.data.cost_ids],
    );
    for (const row of r.rows) {
      await query(
        `INSERT INTO audit_log (user_id, entity_type, entity_id, action, previous_values, new_values)
         VALUES ($1, 'cost', $2, 'cost_person_linked', '{}', $3)`,
        [req.user!.id, row.id, JSON.stringify({ person_id: parse.data.person_id, from: 'backlog' })],
      ).catch(() => { /* the link is what matters */ });
    }
    res.json({ data: { linked: r.rows.length } });
  } catch (err) {
    console.error('[freelancer-invoice-backlog] link error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
