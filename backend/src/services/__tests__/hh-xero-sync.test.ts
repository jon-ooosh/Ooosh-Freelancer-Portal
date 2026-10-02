/**
 * The Xero push must report a refusal, not swallow it.
 *
 * Job 15187, Sep 2026: a £120 refund reached Stripe and HireHop, and HireHop
 * came back with Xero's own refusal in the response body —
 *
 *   "Can't create payment for invoice<br>Xero error: Payments can only be made
 *    against Authorised documents<br>[2263]"
 *
 * — which OP discarded, logged "Xero sync triggered", and returned 200. The
 * trap that made it possible: `hhBroker.post` RESOLVES `{ success: false }`
 * rather than throwing, so the caller's try/catch never fired and the return
 * value was never read. These tests pin the two halves of the fix: a refusal
 * comes back as `ok: false` with the reason, and the reason is readable.
 */
jest.mock('../hirehop-broker', () => ({ hhBroker: { post: jest.fn() } }));
jest.mock('../email-service', () => ({ emailService: { sendRaw: jest.fn() } }));
jest.mock('../../config/app-urls', () => ({ getFrontendUrl: () => 'https://staff.oooshtours.co.uk' }));

import { syncSavedRowToXero, cleanHhError } from '../hh-xero-sync';
import { hhBroker } from '../hirehop-broker';

const post = hhBroker.post as jest.Mock;

// A real billing_payments_save.php response (job 15187, deposit 8953).
const SAVED_ROW = {
  rows: [],
  hh_task: 'post_payment',
  hh_id: 12519,
  hh_acc_package_id: 3,
  hh_package_type: 1,
};

const XERO_2263 = "<b>Can't create payment for invoice </b><br>Xero error: Payments can only be made against Authorised documents<br>[2263]";

beforeEach(() => post.mockReset());

describe('syncSavedRowToXero', () => {
  it('reports a HireHop refusal instead of swallowing it — THE job 15187 bug', async () => {
    // The exact shape that fooled the old code: resolves, never throws.
    post.mockResolvedValue({ success: false, error: XERO_2263 });

    const result = await syncSavedRowToXero('hire refund on job 15187', SAVED_ROW);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('2263');
    expect(result.error).toContain('Authorised documents');
  });

  it('reports success when HireHop accepts', async () => {
    post.mockResolvedValue({ success: true, data: {} });
    await expect(syncSavedRowToXero('hire refund', SAVED_ROW)).resolves.toEqual({ ok: true, error: null });
  });

  it('uses the sync parameters HireHop named in its own save response', async () => {
    post.mockResolvedValue({ success: true, data: {} });
    await syncSavedRowToXero('deposit', { hh_task: 'post_deposit', hh_id: 9001, hh_acc_package_id: 7, hh_package_type: 2 });

    expect(post).toHaveBeenCalledWith('/php_functions/accounting/tasks.php', {
      hh_package_type: 2, hh_acc_package_id: 7, hh_task: 'post_deposit', hh_id: 9001, hh_acc_id: '',
    }, { priority: 'high' });
  });

  it('falls back to post_payment / 1 / 3 when HireHop names nothing', async () => {
    post.mockResolvedValue({ success: true, data: {} });
    await syncSavedRowToXero('legacy row', { hh_id: 12519 });

    expect(post).toHaveBeenCalledWith('/php_functions/accounting/tasks.php',
      expect.objectContaining({ hh_task: 'post_payment', hh_acc_package_id: 3, hh_package_type: 1 }),
      { priority: 'high' });
  });

  it('never calls Xero when HireHop returned no row id — and says why', async () => {
    const result = await syncSavedRowToXero('hire refund', { rows: [] });

    expect(post).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no id/i);
  });

  it('treats a thrown broker error as a failure, not a success', async () => {
    post.mockRejectedValue(new Error('socket hang up'));
    const result = await syncSavedRowToXero('hire refund', SAVED_ROW);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('socket hang up');
  });
});

describe('cleanHhError', () => {
  it('flattens HireHop display HTML into one readable line', () => {
    expect(cleanHhError(XERO_2263)).toBe(
      "Can't create payment for invoice — Xero error: Payments can only be made against Authorised documents — [2263]"
    );
  });

  it('leaves a plain message alone', () => {
    expect(cleanHhError('370')).toBe('370');
  });

  it('never returns an empty string — a blank warning warns nobody', () => {
    expect(cleanHhError(null)).toBe('Unknown error');
    expect(cleanHhError('')).toBe('Unknown error');
  });
});
