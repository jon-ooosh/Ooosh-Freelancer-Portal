/**
 * "Is this cost already in Xero?" — the question that, answered wrongly,
 * created duplicate bills in the live ledger (Sept 2026).
 *
 * The guards used to read `xero_object_id IS SET && state IN (pushed states)`.
 * But `recordError()` sets state='error' and leaves the object id alone, so a
 * cost holding a live Xero bill whose attach step merely hit a 429 read as "not
 * in Xero" — and the next push made a second bill. Eleven live costs were in
 * exactly that state when it was found.
 *
 * `xero_object_id` says whether the object EXISTS.
 * `xero_sync_state` says whether the LAST OPERATION succeeded.
 * Only the first may ever answer this question.
 */
jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../../config/r2', () => ({ getFromR2: jest.fn(), isR2Configured: () => false }));
jest.mock('../../config/xero', () => ({ isXeroConfigured: () => true }));
jest.mock('../xero-broker', () => ({
  xeroBroker: {}, XeroApiError: class extends Error {}, XeroLineItem: {},
}));
jest.mock('../../routes/system-settings', () => ({ getSystemSetting: jest.fn() }));
jest.mock('../cost-documents', () => ({ collectDocuments: () => [], hasDocuments: () => false }));
jest.mock('../cost-lines', () => ({ fetchCostLines: async () => [], grossesWithResidue: () => [] }));

import { existsInXero } from '../cost-xero-push';

const OBJ = '2052ae60-ed4d-49ae-875d-9112826203a8';

describe('existsInXero', () => {
  it('is false with no object id — the only case where creating is right', () => {
    expect(existsInXero({ xero_object_id: null })).toBe(false);
    expect(existsInXero({ xero_object_id: '' })).toBe(false);
    expect(existsInXero({})).toBe(false);
  });

  it('is true for every healthy pushed state', () => {
    for (const _state of ['bill_created', 'attached', 'reconciled']) {
      expect(existsInXero({ xero_object_id: OBJ })).toBe(true);
    }
  });

  it('is TRUE when the last operation errored — the regression that duplicated bills', () => {
    // Real rows from production: a transient 429 on the attach step left a
    // perfectly good Xero object behind a state of 'error'.
    expect(existsInXero({ xero_object_id: OBJ })).toBe(true);
  });

  it('ignores sync state entirely — passing one must not change the answer', () => {
    // Deliberately typed loosely: if a future edit re-introduces a state check,
    // this is the test that should fail.
    const withState = { xero_object_id: OBJ, xero_sync_state: 'error' } as {
      xero_object_id: string; xero_sync_state: string;
    };
    const withoutState = { xero_object_id: OBJ };
    expect(existsInXero(withState)).toBe(existsInXero(withoutState));
  });
});
