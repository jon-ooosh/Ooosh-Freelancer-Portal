// Pictures for the three "money on account" guides:
//   keep-an-overpayment · use-money-on-account · keep-a-cancellation-refund
// Run from the repo root with the local app up (help/README.md):  node help/shots/money-on-account.js
const { APP, sql, open, card, shot } = require('./lib');

const CLIENT = 'The Demo Band';

/** Made-up client and three made-up jobs. Safe to run again: it clears its own rows first. */
function fixtures() {
  sql(`
    DELETE FROM account_credits WHERE source_job_id IN (SELECT id FROM jobs WHERE hh_job_number IN (90001, 90002, 90003));
    DELETE FROM interactions WHERE job_id IN (SELECT id FROM jobs WHERE hh_job_number IN (90001, 90002, 90003));
    DELETE FROM job_payments WHERE job_id IN (SELECT id FROM jobs WHERE hh_job_number IN (90001, 90002, 90003));
    DELETE FROM jobs WHERE hh_job_number IN (90001, 90002, 90003);
    DELETE FROM organisations WHERE name = '${CLIENT}';
    INSERT INTO organisations (name, type, created_by) VALUES ('${CLIENT}', 'band', 'help-shots');
    INSERT INTO jobs (hh_job_number, job_name, client_name, client_id, pipeline_status, status)
      SELECT n, name, '${CLIENT}', (SELECT id FROM organisations WHERE name = '${CLIENT}'), st, 0
        FROM (VALUES (90001, 'The Demo Band - Self-drive van', 'returned'),
                     (90002, 'The Demo Band - Spring tour', 'provisional'),
                     (90003, 'The Demo Band - Festival weekend', 'cancelled')) AS v(n, name, st);`);
  const id = (n) => sql(`SELECT id FROM jobs WHERE hh_job_number = ${n}`)[0];
  return { done: id(90001), next: id(90002), cancelled: id(90003), org: sql(`SELECT id FROM organisations WHERE name = '${CLIENT}'`)[0] };
}

// ── What HireHop would have said (the app cannot reach it from here) ──
const summary = (jobId, n, over) => ({ data: {
  job: { id: jobId, hh_job_number: n, client_name: CLIENT },
  financial: {
    balance_override: null, hire_value_ex_vat: 1393, hire_value_inc_vat: 1671.6, vat_amount: 278.6, vat_adjusted: false, vat_saved: 0,
    total_deposits: 1740, total_hire_deposits: 1740, total_excess_deposits: 0, total_credit_notes: 0, credit_note_write_off: 0,
    client_overpaid: 0, client_overpaid_dealt_with: null, balance_outstanding: -68.4, required_deposit: 0, deposit_paid: true,
    deposit_percent: 100, on_account: null, pending_refunds: [], cancellation: null,
    deposits: [
      { id: 9100, date: '2026-08-11', bank_name: 'Stripe GBP', description: '90001 - deposit', amount: 370.5, is_deposit: true, is_refund: false, is_excess: false },
      { id: 9300, date: '2026-10-27', bank_name: 'Stripe GBP', description: '90001 - balance', amount: 1339.5, is_deposit: true, is_refund: false, is_excess: false },
      { id: 9400, date: '2026-11-01', bank_name: 'Wise - Current Account (BACS)', description: '90001 - balance', amount: 30, is_deposit: true, is_refund: false, is_excess: false },
    ],
    ...over,
  },
  excess: { records: [], total_required: 0, total_collected: 0, status: null, topn_shortfall: null },
  vat_adjustment: null, client_balance_on_account: 0, reconciliation: { actions: [], unmatched_hh_deposits: [] },
} });
const plan = (jobId, n, over) => ({
  jobId, hhJobNumber: n, jobName: '', hhStatus: 7,
  invoice: { accruedNet: 1393, invoicedNet: 1393, netToInvoice: 0, draft: null, euTrigger: false, notReturned: false, blockers: [], ready: false },
  invoices: [{ invoiceId: 1, number: 'OT-INV-90001', status: 3, date: '2026-11-16', gross: 1671.6, owing: 0, inXero: true, xeroId: 'x', chargeOnly: false }],
  payments: [], allocations: [], surplus: [{ depositId: 9300, amount: 38.4 }, { depositId: 9400, amount: 30 }], shortfall: 0, excessHeld: 0,
  blockers: [], warnings: [], sentences: [], ready: false, readyToComplete: false, log: [], invoiceRequirementId: null, invoiceSent: true,
  openProblems: 0, paymentTarget: null, cancellation: null, onAccount: null, creditReserved: [], ...over,
});
const held = (id, amount) => ({ id, amount, clientName: CLIENT, heldByName: 'Sam Carter', heldAt: '2026-11-19T10:00:00Z', reservedJobId: null, reservedJobNumber: null });

(async () => {
  const J = fixtures();
  const { browser, page, errors } = await open({ role: 'manager' });
  const modal = () => page.locator('.fixed.inset-0 > div').first();

  // ── 1. keep-an-overpayment ────────────────────────────────────────────
  console.log('keep-an-overpayment');
  let doneHold = null;
  await page.route(`**/api/money/${J.done}/summary*`, (r) => r.fulfill({ json: summary(J.done, 90001, {}) }));
  await page.route(`**/api/close-out/${J.done}/plan*`, (r) => r.fulfill({ json: { data: plan(J.done, 90001, { onAccount: doneHold, readyToComplete: !!doneHold }) } }));
  // The hold reads HireHop, so the row the service would write is written here, with the plan it would answer.
  let holding = J.done;
  await page.route('**/api/account-credit/hold', async (r) => {
    const body = r.request().postDataJSON();
    const amount = holding === J.done ? 68.4 : 1485;
    const id = sql(`INSERT INTO account_credits (source_job_id, organisation_id, amount, note) VALUES ('${holding}', '${J.org}', ${amount}, '${String(body.note || '').replace(/'/g, "''")}') RETURNING id`)[0];
    if (holding === J.done) { doneHold = held(id, amount); await r.fulfill({ json: { data: { credit: {}, plan: plan(J.done, 90001, { onAccount: doneHold, readyToComplete: true }) } } }); }
    else { cancelHold = held(id, amount); await r.fulfill({ json: { data: { credit: {}, plan: cancelPlan() } } }); }
  });

  await page.goto(`${APP}/jobs/${J.done}?tab=money`);
  await page.getByText('overpaid').first().waitFor({ timeout: 30000 });
  const invoicePanel = () => card(page, /^Invoice/);
  await shot(page, 'keep-an-overpayment', '1-in-credit.png', [card(page, 'Financial Summary'), invoicePanel()]);
  const holdBtn = invoicePanel().getByRole('button', { name: 'Hold on account' });
  await shot(page, 'keep-an-overpayment', '2-hold-button.png', invoicePanel(), { ring: holdBtn });
  await holdBtn.click();
  await page.locator('#ac-note').fill('Sam asked us to keep it for the spring tour');
  await shot(page, 'keep-an-overpayment', '3-confirm.png', modal(), { pad: 0 });
  await modal().getByRole('button', { name: 'Hold on account' }).click();
  await page.getByText('held on account').first().waitFor();
  await shot(page, 'keep-an-overpayment', '4-held.png', invoicePanel());

  // ── 2. use-money-on-account ───────────────────────────────────────────
  console.log('use-money-on-account');
  const reserved = [{ id: 'c', amount: 68.4, source_job_id: J.done, source_job_number: 90001 }];
  let invoicing = false;
  await page.route(`**/api/money/${J.next}/summary*`, (r) => r.fulfill({ json: summary(J.next, 90002, {
    hire_value_ex_vat: 1000, hire_value_inc_vat: 1200, vat_amount: 200, total_deposits: 0, total_hire_deposits: 0,
    balance_outstanding: 1200, required_deposit: 300, deposit_paid: false, deposit_percent: 0, deposits: [],
    on_account: { total: 68.4, covers: 68.4, to_pay: 1131.6, items: reserved },
  }) }));
  await page.route(`**/api/close-out/${J.next}/plan*`, (r) => r.fulfill({ json: { data: invoicing
    ? plan(J.next, 90002, { invoices: [], surplus: [], creditReserved: reserved, blockers: ['Raise the invoice first'],
        invoice: { accruedNet: 1000, invoicedNet: 0, netToInvoice: 1000, draft: null, euTrigger: false, notReturned: false, blockers: [], ready: true } })
    : plan(J.next, 90002, { hhStatus: 1, invoices: [], surplus: [], creditReserved: reserved,
        invoice: { accruedNet: 1000, invoicedNet: 0, netToInvoice: 1000, draft: null, euTrigger: false, notReturned: true, blockers: ['not back'], ready: false } }) } }));
  await page.route('**/api/pipeline/**/status', (r) => r.fulfill({ json: { data: {} } }));

  await page.goto(`${APP}/jobs/${J.next}`);
  await page.getByText('Money on account').waitFor({ timeout: 30000 });
  // Just the panel's heading and the box — the rest of the panel is not what the step is about.
  const history = () => [page.getByRole('heading', { name: /Client History/ }), box()];
  const box = () => page.getByText('Money on account').locator('xpath=..');
  await shot(page, 'use-money-on-account', '1-on-account-box.png', history(), { ring: box() });
  await page.getByRole('button', { name: 'Use on this job' }).click();
  await page.getByText('Put aside for this job').waitFor();
  await shot(page, 'use-money-on-account', '2-put-aside.png', history(), { ring: box() });

  await page.goto(`${APP}/jobs/${J.next}?tab=money`);
  await page.getByText('To pay now').waitFor({ timeout: 30000 });
  await shot(page, 'use-money-on-account', '3-to-pay-now.png', card(page, 'Financial Summary'), { ring: page.getByText('To pay now').locator('xpath=ancestor::div[contains(@class,"bg-blue-50")][1]') });

  await page.getByRole('button', { name: /Provisional/ }).first().click();
  await page.getByRole('button', { name: /Confirmed/ }).first().click();
  await page.getByText('How was this confirmed?').waitFor();
  await page.waitForTimeout(600);
  await page.locator('select').filter({ hasText: 'Deposit received' }).selectOption('credit_on_account');
  // This modal is built differently from the others: crop to its own white box.
  await shot(page, 'use-money-on-account', '4-confirm-method.png',
    page.getByText('How was this confirmed?').locator('xpath=ancestor::div[contains(@class,"bg-white")][1]'), { pad: 24 });
  await page.getByRole('button', { name: 'Cancel' }).click();

  invoicing = true;
  await page.goto(`${APP}/jobs/${J.next}?tab=money`);
  await page.getByText('This will also apply').waitFor({ timeout: 30000 });
  await shot(page, 'use-money-on-account', '5-also-applies.png', invoicePanel(), { ring: page.getByText('This will also apply').locator('xpath=..') });

  // ── 3. keep-a-cancellation-refund ─────────────────────────────────────
  console.log('keep-a-cancellation-refund');
  let cancelHold = null;
  function cancelPlan() {
    return plan(J.cancelled, 90003, {
      hhStatus: 9, surplus: [{ depositId: 9412, amount: 1485 }], onAccount: cancelHold,
      invoice: { accruedNet: 0, invoicedNet: 412.5, netToInvoice: 0, draft: null, euTrigger: false, notReturned: false, blockers: [], ready: false },
      invoices: [{ invoiceId: 5, number: 'OT-INV-90003', status: 3, date: '2026-11-10', gross: 495, owing: 0, inXero: true, xeroId: 'x', chargeOnly: true }],
      cancellation: { feeNet: 412.5, feeGross: 495, cancelledAt: '2026-11-08', invoiced: true, refundOutcome: null, settled: !!cancelHold,
        refundReminders: cancelHold ? [] : [{ id: 'r1', amount: 1485 }] },
    });
  }
  holding = J.cancelled;
  await page.route(`**/api/money/${J.cancelled}/summary*`, (r) => r.fulfill({ json: summary(J.cancelled, 90003, {
    hire_value_ex_vat: 412.5, hire_value_inc_vat: 495, vat_amount: 82.5, total_deposits: 1980, total_hire_deposits: 1980, balance_outstanding: -1485,
    deposits: [
      { id: 9354, date: '2026-09-28', bank_name: 'Stripe GBP', description: '90003 - deposit', amount: 495, is_deposit: true, is_refund: false, is_excess: false },
      { id: 9412, date: '2026-10-08', bank_name: 'Stripe GBP', description: '90003 - balance', amount: 1485, is_deposit: true, is_refund: false, is_excess: false },
    ],
  }) }));
  await page.route(`**/api/close-out/${J.cancelled}/plan*`, (r) => r.fulfill({ json: { data: cancelPlan() } }));
  await page.goto(`${APP}/jobs/${J.cancelled}?tab=money`);
  await page.getByText('or hold it on account').waitFor({ timeout: 30000 });
  const feePanel = () => card(page, /^Cancellation fee/);
  const cancelBtn = feePanel().getByRole('button', { name: 'Hold on account' });
  await shot(page, 'keep-a-cancellation-refund', '1-refund-due.png', feePanel(), { ring: cancelBtn });
  await cancelBtn.click();
  await page.locator('#ac-note').fill('Festival moved to next summer - they will rebook');
  await shot(page, 'keep-a-cancellation-refund', '2-confirm.png', modal(), { pad: 0 });
  await modal().getByRole('button', { name: 'Hold on account' }).click();
  await page.getByText('held on account').first().waitFor();
  await shot(page, 'keep-a-cancellation-refund', '3-settled.png', feePanel());

  await browser.close();
  if (errors.length) { console.error('The app threw while being pictured:', errors); process.exit(1); }
  console.log('done');
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
