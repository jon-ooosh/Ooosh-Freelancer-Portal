/**
 * api_keys.permissions scoping for the money router (payment portal audit B.6, Oct 2026).
 * Pure functions only — the DB-backed verifier is not exercised here.
 */
jest.mock('../../config/database', () => ({ query: jest.fn() }));

import { moneyOperationFor, apiKeyMayCall } from '../api-key';

const PORTAL = ['money:job-lookup', 'money:excess-info', 'money:stripe-event', 'money:payment-event'];

describe('moneyOperationFor', () => {
  it('names the four portal operations', () => {
    expect(moneyOperationFor('/job-lookup/16815')).toBe('money:job-lookup');
    expect(moneyOperationFor('/16815/excess-info')).toBe('money:excess-info');
    expect(moneyOperationFor('/3f2a1b2c-0000-0000-0000-000000000000/excess-info')).toBe('money:excess-info');
    expect(moneyOperationFor('/stripe-event/claim')).toBe('money:stripe-event');
    expect(moneyOperationFor('/stripe-event/record-deposit')).toBe('money:stripe-event');
    expect(moneyOperationFor('/16815/payment-event')).toBe('money:payment-event');
  });
  it('is null for everything else', () => {
    for (const p of ['/16815/refund-payment', '/16815/record-payment', '/16815/summary', '/16815/payments',
      '/16815/payment-link', '/sync-values', '/overview', '/stripe-event/other', '/job-lookup/16815/extra', '/']) {
      expect(moneyOperationFor(p)).toBeNull();
    }
  });
});

describe('apiKeyMayCall', () => {
  it('an empty or missing permissions row is unrestricted (every key today)', () => {
    expect(apiKeyMayCall([], '/16815/refund-payment')).toBe(true);
    expect(apiKeyMayCall(null, '/16815/refund-payment')).toBe(true);
    expect(apiKeyMayCall(undefined, '/overview')).toBe(true);
  });
  it('money:* is unrestricted', () => {
    expect(apiKeyMayCall(['money:*'], '/16815/refund-payment')).toBe(true);
  });
  it('the portal row reaches its four operations and nothing else', () => {
    expect(apiKeyMayCall(PORTAL, '/job-lookup/16815')).toBe(true);
    expect(apiKeyMayCall(PORTAL, '/16815/excess-info')).toBe(true);
    expect(apiKeyMayCall(PORTAL, '/stripe-event/claim')).toBe(true);
    expect(apiKeyMayCall(PORTAL, '/stripe-event/record-deposit')).toBe(true);
    expect(apiKeyMayCall(PORTAL, '/16815/payment-event')).toBe(true);
    expect(apiKeyMayCall(PORTAL, '/16815/refund-payment')).toBe(false);
    expect(apiKeyMayCall(PORTAL, '/16815/record-payment')).toBe(false);
    expect(apiKeyMayCall(PORTAL, '/16815/summary')).toBe(false);
    expect(apiKeyMayCall(PORTAL, '/16815/payment-link')).toBe(false);
    expect(apiKeyMayCall(PORTAL, '/sync-values')).toBe(false);
  });
  it('a row naming another service\'s permission reaches no money route', () => {
    expect(apiKeyMayCall(['enquiry_intake'], '/job-lookup/16815')).toBe(false);
    expect(apiKeyMayCall(['enquiry_intake'], '/16815/payment-event')).toBe(false);
  });
});
