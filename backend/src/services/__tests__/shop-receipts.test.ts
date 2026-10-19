/**
 * Step 11: the customer's receipt. What matters is that it carries the
 * simplified-VAT-invoice fields per line (VAT rate) and in total, and that a
 * refund receipt reads as a refund of the original sale — not a new sale.
 * (Our name, address and VAT number come from the client email footer.)
 */
export {};

jest.mock('../../config/database', () => ({ query: jest.fn() }));
jest.mock('../email-service', () => ({ emailService: { sendRaw: jest.fn() } }));

import { renderReceiptHtml } from '../shop-receipts';

const base = {
  isRefund: false,
  ref: 'OT-SHOP-00123',
  when: '24 September 2026 at 19:42',
  tender: 'till_cash',
  lines: [
    { name: 'Guitar strings 10-46', qty: 2, unitGross: 9, vatPct: 20, lineGross: 18 },
    { name: 'Children\'s book <zero>', qty: 1, unitGross: 5, vatPct: 0, lineGross: 5 },
  ],
  net: 20,
  vat: 3,
  gross: 23,
};

describe('renderReceiptHtml', () => {
  it('is a VAT receipt with the number, time, per-line VAT rate and totals', () => {
    const html = renderReceiptHtml(base);
    expect(html).toContain('VAT receipt');
    expect(html).toContain('OT-SHOP-00123');
    expect(html).toContain('24 September 2026 at 19:42');
    expect(html).toContain('20%');
    expect(html).toContain('0%');          // a zero-rated line shows its own rate
    expect(html).toContain('Total excluding VAT');
    expect(html).toContain('£20.00');
    expect(html).toContain('£3.00');
    expect(html).toContain('Total paid');
    expect(html).toContain('£23.00');
    expect(html).toContain('Paid by: Cash');
  });

  it('escapes item names — they come from HireHop, not from us', () => {
    const html = renderReceiptHtml(base);
    expect(html).toContain('&lt;zero&gt;');
    expect(html).not.toContain('<zero>');
  });

  it('a refund receipt refers to the ORIGINAL sale and shows positive amounts', () => {
    const html = renderReceiptHtml({ ...base, isRefund: true, net: -20, vat: -3, gross: -23, tender: 'worldpay' });
    expect(html).toContain('Refund receipt');
    expect(html).toContain('against receipt <strong>OT-SHOP-00123</strong>');
    expect(html).toContain('Total refunded');
    expect(html).toContain('£23.00');
    expect(html).not.toContain('-£');
    expect(html).toContain('Refunded to: Card (Worldpay)');
  });
});
