/**
 * The "Photo ID check needs review" email, rendered as info@ receives it.
 *
 * Steve Claes, job 16831 (Nov 2026): the "What iDenfy reported" block printed
 * literal `<strong>` and `<br/>` — the template engine escapes every variable,
 * and the sender built the block as HTML. It also always said the SELFIE
 * didn't match, when his face matched and the DOCUMENT wasn't supported.
 */

import emailService from '../email-service';
import { identityAlertDetail, identityAlertHeadline } from '../identity-review';

const steve = {
  idenfy_overall: 'SUSPECTED',
  idenfy_face_result: 'FACE_MATCH',
  idenfy_doc_result: 'DOC_NOT_SUPPORTED',
  idenfy_mismatch_tags: ['VIRTUAL_CAMERA'],
  idenfy_suspicion_reasons: null,
};

function render(variables: Record<string, string>) {
  const out = emailService.renderPreview('identity_review_required', { to: 'info@example.com', variables });
  if ('error' in out) throw new Error(out.error);
  return out;
}

describe('identity review alert email', () => {
  it('shows what iDenfy reported as plain lines, with no escaped tags', () => {
    const { html } = render({
      driverName: 'Name not read from the document',
      driverEmail: 'steve@example.com',
      jobNumber: '16831',
      headline: identityAlertHeadline(steve.idenfy_face_result, steve.idenfy_doc_result),
      checkDetail: identityAlertDetail(steve),
      driverUrl: 'https://staff.example/drivers/x',
    });
    expect(html).not.toMatch(/&lt;(strong|br)/);
    expect(html).toContain('• iDenfy result: SUSPECTED\n• Face check: FACE_MATCH\n• Document check: DOC_NOT_SUPPORTED\n• Mismatch: VIRTUAL_CAMERA');
    expect(html).toContain('white-space:pre-line');
    expect(html).toContain('did not recognise the document');
    expect(html).not.toContain('could not match this driver');
    expect(html).toContain('Job <strong>#16831</strong>');
  });

  it('still escapes whatever iDenfy sends', () => {
    const { html } = render({
      driverName: 'A', driverEmail: 'a@example.com', jobNumber: '',
      headline: 'x', checkDetail: identityAlertDetail({ idenfy_doc_result: '<script>' }), driverUrl: 'u',
    });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});

describe('identityAlertHeadline', () => {
  it('names what failed', () => {
    expect(identityAlertHeadline('FACE_MISMATCH', null)).toMatch(/selfie/);
    expect(identityAlertHeadline('FACE_MATCH', 'DOC_NOT_SUPPORTED')).toMatch(/paper licence/);
    expect(identityAlertHeadline('FACE_MATCH', 'DOC_SPOOF_DETECTED')).toBe('iDenfy did not accept this driver’s photo ID check.');
    expect(identityAlertHeadline(null, null)).toBe('iDenfy did not accept this driver’s photo ID check.');
  });
});
