jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../hirehop-broker', () => ({ hhBroker: {} }));

import { deriveFlags, TOWBAR_LIST_ID } from '../hh-requirement-derivation';
import type { HHLineItem } from '../hirehop-job-sync';

function line(over: Partial<HHLineItem>): HHLineItem {
  return {
    ITEM_ID: 1, LIST_ID: 0, ITEM_NAME: '', QUANTITY: 1, CATEGORY_ID: 370, kind: 2,
    AUTOPULL: 0, VIRTUAL: false, LFT: 0, RGT: 0, TYPE_CUSTOM_FIELDS: null, ...over,
  };
}

describe('Towbar autopull (HireHop 2064)', () => {
  const van = line({ ITEM_ID: 11, LIST_ID: 2065, ITEM_NAME: 'Standard MWB Splitter Van - auto gearbox', LFT: 1, RGT: 4 });

  it('is never counted as a van, even if HireHop stops flagging it VIRTUAL', () => {
    const towbar = line({ ITEM_ID: 12, LIST_ID: TOWBAR_LIST_ID, ITEM_NAME: 'Towbar', VIRTUAL: false, LFT: 2, RGT: 3 });
    const flags = deriveFlags([van, towbar]);
    expect(flags.vehicle_count).toBe(1);
    expect(flags.vehicle_slots).toHaveLength(1);
    expect(flags.towbar_count).toBe(1);
  });

  it('counts no towbar when none is on the job', () => {
    const flags = deriveFlags([van]);
    expect(flags.towbar_count).toBe(0);
    expect(flags.vehicle_count).toBe(1);
  });
});
