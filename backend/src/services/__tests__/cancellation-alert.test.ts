/**
 * The internal "job cancelled" email (job_cancelled_internal).
 *
 * It used to be titled "Cancellation Processed" and read as if everything was
 * finished when the fee invoice, the refund and sending the invoice were all
 * still to do (job 16725, Oct 2026). These render it exactly as info@ receives
 * it: the steps are flat {{#if}} blocks and the engine can't nest, so a
 * mis-shaped block would fail silently as literal text.
 */

import emailService from '../email-service';
import { cancellationAlertVariables, CancellationAlertInput } from '../cancellation-alert';

function render(overrides: Partial<CancellationAlertInput>) {
  const input: CancellationAlertInput = {
    cancelledBy: 'Matt Example',
    jobName: 'Carcass - PREMIUM',
    hhJobNumber: 16725,
    reason: 'Client cancelled',
    feeNet: 68,
    feeGross: 81.6,
    refund: 158.4,
    owing: 0,
    excessHeld: 0,
    clientEmailed: true,
    chaseFrom: '2026-10-27',
    moneyUrl: 'https://staff.example/jobs/abc?tab=money',
    listUrl: 'https://staff.example/jobs/lost-cancelled?tab=cancelled',
    ...overrides,
  };
  const variables = cancellationAlertVariables(input);
  const out = emailService.renderPreview('job_cancelled_internal', { to: 'info@oooshtours.co.uk', variables });
  if ('error' in out) throw new Error(out.error);
  return { ...out, variables };
}

describe('job_cancelled_internal', () => {
  it('lists the money still to do on a cancellation with a refund (job 16725)', () => {
    const { subject, html } = render({});
    expect(subject).toBe('Cancelled — money to finish: Carcass - PREMIUM (J-16725)');
    expect(html).toContain('money still to finish');
    expect(html).toContain('Raise the cancellation fee invoice — £68.00 + VAT = <strong>£81.60</strong>');
    expect(html).toContain('Refund the client <strong>£158.40</strong>');
    expect(html).toContain('Mark as sent');
    expect(html).toContain('Anything still open on Tue 27 Oct is chased');
    expect(html).toContain('?tab=money');
    expect(html).not.toContain('Collect the');
    expect(html).not.toContain('Excess:');
    expect(html).not.toContain('Nothing to invoice');
    expect(html).not.toContain('Processed');
  });

  it('asks for the fee when the client paid nothing', () => {
    const { html } = render({ refund: 0, owing: 81.6 });
    expect(html).toContain('Collect the <strong>£81.60</strong> the client still owes');
    expect(html).not.toContain('Refund the client');
    expect(html).toContain('Raise the cancellation fee invoice');
  });

  it('says there is nothing to do when no money moves', () => {
    const { subject, html } = render({ feeNet: 0, feeGross: 0, refund: 0, owing: 0, excessHeld: 0 });
    expect(subject).toBe('Cancelled — nothing to settle: Carcass - PREMIUM (J-16725)');
    expect(html).toContain('Nothing to invoice, collect or refund');
    expect(html).not.toContain('Raise the cancellation fee invoice');
    expect(html).not.toContain('money still to finish');
    expect(html).not.toContain('is chased');
  });

  it('adds the excess held, with thousands separators', () => {
    const { html } = render({ excessHeld: 1200 });
    expect(html).toContain('Excess: <strong>£1,200.00</strong> held');
    expect(html).toContain('The excess is separate');
  });

  it('says when the client email was skipped', () => {
    expect(render({ clientEmailed: false }).html).toContain('no client email (skipped at cancellation)');
    expect(render({}).html).toContain('a cancellation confirmation emailed to the client');
  });

  it('passes the bare job number so a bounce links back to the job', () => {
    expect(render({}).variables.jobNumber).toBe('16725');
  });

  it('leaves no template syntax behind in any case', () => {
    for (const o of [{}, { refund: 0, owing: 81.6 }, { feeNet: 0, feeGross: 0, refund: 0 }, { excessHeld: 500, clientEmailed: false }]) {
      const { subject, html } = render(o);
      expect(subject).not.toMatch(/\{\{|\}\}/);
      expect(html).not.toMatch(/\{\{|\}\}/);
    }
  });
});
