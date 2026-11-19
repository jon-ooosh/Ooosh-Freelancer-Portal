/**
 * Remittance for a bulk payment: ONE email per payee listing every bill paid
 * to them (jon, Nov 2026), never one per bill — and never for a bill that
 * isn't paid, or for bills belonging to two different payees.
 */
export {};

jest.mock('../../config/database', () => ({ query: jest.fn() }));
jest.mock('../email-service', () => ({ emailService: { send: jest.fn() } }));

import { query } from '../../config/database';
import { emailService } from '../email-service';
import { remittancePayeeKey, sendRemittanceForCosts } from '../remittance';

const mockQuery = query as jest.Mock;
const mockSend = emailService.send as jest.Mock;

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function bill(id: string, over: Record<string, unknown> = {}) {
  return {
    id, payment_method: 'not_yet_paid', uploaded_by: null, quote_assignment_id: null, person_id: null,
    cost_type: 'supplier_invoice', xero_contact_id: 'xc-garage', supplier_name: 'Hi-Q Portslade',
    invoice_number: `SJ-${id.slice(0, 4)}`, description: 'Service', amount_gross: '100.50',
    paid_method: 'lloyds_transfer', paid_value_date: '2026-11-01', job_id: null,
    payment_status: 'paid', cost_date: '2026-10-20', uploaded_by_name: null,
    ...over,
  };
}

/** Answers the cost load with `rows`; every lookup after it finds nothing. */
function withCosts(rows: Array<Record<string, unknown>>) {
  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes('FROM costs c')) return Promise.resolve({ rows });
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockSend.mockReset();
  mockSend.mockResolvedValue({ success: true });
});

describe('remittancePayeeKey', () => {
  it('groups bills by Xero contact first', () => {
    expect(remittancePayeeKey(bill(A))).toBe(remittancePayeeKey(bill(B, { supplier_name: 'HiQ' })));
  });
  it('falls back to the supplier name, ignoring case and spacing', () => {
    expect(remittancePayeeKey(bill(A, { xero_contact_id: null, supplier_name: 'Hi-Q  Portslade' })))
      .toBe(remittancePayeeKey(bill(B, { xero_contact_id: null, supplier_name: 'hi-q portslade' })));
  });
  it('keys a reimbursement on the person who fronted it, not the shop', () => {
    const r1 = remittancePayeeKey(bill(A, { payment_method: 'reimburse_me', uploaded_by: 'u-1' }));
    const r2 = remittancePayeeKey(bill(B, { payment_method: 'reimburse_me', uploaded_by: 'u-2' }));
    expect(r1).not.toBe(r2);
  });
});

describe('sendRemittanceForCosts', () => {
  it('sends ONE email listing every bill, with the total and the reference, and stamps them all', async () => {
    withCosts([bill(A), bill(B)]);
    const r = await sendRemittanceForCosts([A, B], 'accounts@hiq.example', 'Garage - November');
    expect(r).toEqual({ ok: true });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const sent = mockSend.mock.calls[0][1];
    expect(sent.to).toBe('accounts@hiq.example');
    expect(sent.subjectOverride).toContain('£201.00');
    expect(sent.subjectOverride).toContain('2 invoices');
    expect(sent.bodyHtmlOverride).toContain('SJ-1111');
    expect(sent.bodyHtmlOverride).toContain('SJ-2222');
    expect(sent.bodyHtmlOverride).toContain('Garage - November');
    const stamp = mockQuery.mock.calls.find(([sql]) => String(sql).includes('remittance_sent_at = NOW()'));
    expect(stamp?.[1][0]).toEqual([A, B]);
  });

  it('refuses, and sends nothing, when a bill is not paid', async () => {
    withCosts([bill(A), bill(B, { payment_status: 'unpaid' })]);
    const r = await sendRemittanceForCosts([A, B], 'accounts@hiq.example');
    expect(r.ok).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses, and sends nothing, when the bills are for different payees', async () => {
    withCosts([bill(A), bill(B, { xero_contact_id: 'xc-other', supplier_name: 'Rossetts' })]);
    const r = await sendRemittanceForCosts([A, B], 'accounts@hiq.example');
    expect(r.ok).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('leaves the bills unstamped when the email fails', async () => {
    withCosts([bill(A)]);
    mockSend.mockResolvedValue({ success: false, error: 'boom' });
    const r = await sendRemittanceForCosts([A], 'accounts@hiq.example');
    expect(r).toEqual({ ok: false, error: 'boom' });
    expect(mockQuery.mock.calls.some(([sql]) => String(sql).includes('remittance_sent_at = NOW()'))).toBe(false);
  });
});
