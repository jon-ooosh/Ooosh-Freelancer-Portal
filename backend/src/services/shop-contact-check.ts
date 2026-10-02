/**
 * shop-contact-check.ts — has anyone edited the "OP Shop Sales" contact?
 *
 * Every week's shop job, and so every weekly invoice, is raised against one
 * HireHop client (`shop_job_client_id`, 3067). The contact it replaced was
 * ruined by staff editing its ADDRESS to raise ad-hoc invoices for one-off
 * buyers — a known incident, which made a mess in Xero (SHOP-SALES-SPEC.md
 * §6.0). This notices it happening again: once a day, read the contact and
 * compare its name, company and address with what they were; email jon once
 * per distinct change.
 *
 * It reads HireHop's contact list (`fetchAllHireHopContacts`, the same call
 * OP's contact sync makes) — no new endpoint. The first run just records the
 * baseline. After an alert the new values become the baseline: if the change
 * was deliberate there is nothing more to do; if not, put it back in HireHop
 * and the next day's check alerts again, proving it's back.
 */
import { query } from '../config/database';
import { emailService } from './email-service';
import { SHOP_ALERT_RECIPIENT } from './shop-reconcile';

const BASELINE_KEY = 'shop_contact_baseline';

export interface ShopContactFields {
  name: string;
  company: string;
  address: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const clean = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();

export async function checkShopContact(): Promise<'baseline' | 'unchanged' | 'changed' | 'skipped'> {
  const idRow = await query(`SELECT value FROM system_settings WHERE key = 'shop_job_client_id'`);
  const clientId = Number(idRow.rows[0]?.value);
  if (!Number.isFinite(clientId) || clientId <= 0) return 'skipped';

  const { fetchAllHireHopContacts } = await import('./hirehop-sync');
  const contacts = await fetchAllHireHopContacts();
  // CLIENT_ID on a job is the COMPANY id (cID) — §6.0.
  const row = contacts.find((c) => Number(c.cID) === clientId) ?? contacts.find((c) => Number(c.ID) === clientId);
  const now: ShopContactFields | null = row
    ? { name: clean(row.NAME), company: clean(row.COMPANY), address: clean(row.ADDRESS) }
    : null;

  const base = await query(`SELECT value FROM system_settings WHERE key = $1`, [BASELINE_KEY]);
  const saved: ShopContactFields | null = (() => {
    try { return base.rows[0]?.value ? JSON.parse(base.rows[0].value) : null; } catch { return null; }
  })();

  const store = (v: ShopContactFields | null) => query(
    `INSERT INTO system_settings (key, value, category, updated_at) VALUES ($1, $2, 'shop_internal', NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [BASELINE_KEY, JSON.stringify(v)],
  );

  if (!saved) {
    if (now) await store(now);
    return 'baseline';
  }
  if (now && now.name === saved.name && now.company === saved.company && now.address === saved.address) {
    return 'unchanged';
  }

  const line = (label: string, a: string, b: string) => (a === b ? '' :
    `<li><strong>${label}:</strong> "${escapeHtml(a || '(blank)')}" → "${escapeHtml(b || '(blank)')}"</li>`);
  const changes = now
    ? line('Name', saved.name, now.name) + line('Company', saved.company, now.company) + line('Address', saved.address, now.address)
    : '<li>The contact is <strong>no longer in HireHop\'s contact list</strong> — deleted or merged?</li>';

  await emailService.sendRaw({
    to: SHOP_ALERT_RECIPIENT,
    subject: `[Shop] The "OP Shop Sales" contact in HireHop has been changed`,
    html: `<p>HireHop client ${clientId} — the contact every weekly shop invoice is raised against — has changed:</p>`
      + `<ul>${changes}</ul>`
      + '<p>If that was deliberate, nothing to do. If someone edited it to invoice a one-off buyer, '
      + 'put it back in HireHop — that is the habit that made a mess of the old contact (SHOP-SALES-SPEC §6.0). '
      + 'A one-off buyer paying on account belongs on a real job.</p>',
    variant: 'internal',
  });
  // Always move the baseline on, even to "missing", so one change alerts once.
  await store(now);
  return 'changed';
}
