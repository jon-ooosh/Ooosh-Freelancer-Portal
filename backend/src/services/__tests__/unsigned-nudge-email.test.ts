/**
 * The two unsigned-hire-form nudge emails.
 *
 * The nudge used to send ONE email whose copy said "your documents have all
 * been checked and are fine — there's just one thing left". Its trigger only
 * ever asked "is this driver joined to the hire yet?", never "are their
 * documents done?", so a driver who got as far as the OTP and stopped was told
 * their documents were fine when nothing had been uploaded (Sep 2026).
 *
 * These render the templates exactly as a driver would receive them, because
 * the outstanding items are {{#if}} blocks and the template engine does not
 * support nesting — a mis-shaped block fails silently as literal text.
 */

import emailService from '../email-service';
import { computeDriverValidity, outstandingDocuments, hasAllRequiredDocuments } from '../driver-validity';

const TODAY = '2026-09-08';

function render(templateId: string, variables: Record<string, string>) {
  const out = emailService.renderPreview(templateId, { to: 'driver@example.com', variables });
  if ('error' in out) throw new Error(out.error);
  return out;
}

/** The flags the nudge builds for an incomplete driver. */
function incompleteFlags(driver: Record<string, unknown>) {
  const out = outstandingDocuments(computeDriverValidity(driver, TODAY));
  const vars: Record<string, string> = {};
  if (out.licence) vars.needLicence = '1';
  if (out.poa1) vars.needPoa1 = '1';
  if (out.poa2) vars.needPoa2 = '1';
  if (out.dvla) vars.needDvla = '1';
  if (out.passport) vars.needPassport = '1';
  return vars;
}

describe('hire_form_incomplete_nudge', () => {
  const base = { driverName: 'Test', jobNumber: '16643', jobName: 'New test', startDate: 'Tuesday, 8 September 2026', hireFormUrl: 'https://hireforms.oooshtours.co.uk/?job=16643' };

  it('lists only what is actually outstanding', () => {
    // The Sep 2026 test driver: no licence check, DVLA expired, no POA dates.
    const { html } = render('hire_form_incomplete_nudge', {
      ...base,
      ...incompleteFlags({
        licence_issue_country: 'GB',
        idenfy_check_date: null,
        dvla_check_date: '2026-03-05',
        poa1_doc_date: null,
        poa2_doc_date: null,
      }),
    });
    expect(html).toContain('Verify your driving licence');
    expect(html).toContain('Proof of address #1');
    expect(html).toContain('Proof of address #2');
    expect(html).toContain('DVLA check code');
    expect(html).not.toContain('photo of your passport</li>');
  });

  it('omits the items the driver has already done', () => {
    const { html } = render('hire_form_incomplete_nudge', {
      ...base,
      ...incompleteFlags({
        idenfy_check_date: '2026-09-01',
        licence_issued_by: 'DVLA',
        poa1_doc_date: '2026-08-20',
        poa2_doc_date: '2026-08-20',
        dvla_check_date: null,
      }),
    });
    expect(html).not.toContain('Verify your driving licence');
    expect(html).not.toContain('Proof of address #1');
    expect(html).toContain('DVLA check code');
    // The signature line is unconditional — it is always the last thing left.
    expect(html).toContain('Sign the hire agreement');
  });

  it('leaves no unrendered template syntax behind', () => {
    const { html, subject } = render('hire_form_incomplete_nudge', { ...base, needLicence: '1' });
    expect(html).not.toMatch(/\{\{/);
    expect(subject).toBe('Please finish your hire form for #16643');
  });
});

describe('hire_form_unsigned_nudge', () => {
  it('is reserved for a driver whose documents really are all done', () => {
    const complete = {
      idenfy_check_date: '2026-09-01',
      licence_issued_by: 'DVLA',
      dvla_check_date: '2026-09-01',
      poa1_doc_date: '2026-08-20',
      poa2_doc_date: '2026-08-20',
    };
    expect(hasAllRequiredDocuments(computeDriverValidity(complete, TODAY))).toBe(true);

    const { html, subject } = render('hire_form_unsigned_nudge', {
      driverName: 'Test', jobNumber: '16643', jobName: '', startDate: '',
      hireFormUrl: 'https://hireforms.oooshtours.co.uk/?job=16643',
    });
    expect(subject).toBe('One last step: sign your hire agreement for #16643');
    expect(html).toContain('signing the hire agreement');
    expect(html).not.toMatch(/\{\{/);
  });
});
