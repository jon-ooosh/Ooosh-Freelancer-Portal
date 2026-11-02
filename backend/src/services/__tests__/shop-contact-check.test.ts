/**
 * The "OP Shop Sales" contact check: records a baseline, stays quiet while
 * nothing changes, and emails ONCE per change (SHOP-SALES-SPEC §6.0).
 */
export {};

jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../email-service', () => ({ emailService: { sendRaw: jest.fn().mockResolvedValue({}) } }));
jest.mock('../shop-reconcile', () => ({ SHOP_ALERT_RECIPIENT: 'jon@example.test' }));
jest.mock('../hirehop-sync', () => ({ fetchAllHireHopContacts: jest.fn() }));

import { query } from '../../config/database';
import { emailService } from '../email-service';
import { fetchAllHireHopContacts } from '../hirehop-sync';
import { checkShopContact } from '../shop-contact-check';

const mockQuery = query as jest.Mock;
const mockEmail = (emailService as any).sendRaw as jest.Mock;
const mockContacts = fetchAllHireHopContacts as jest.Mock;

let baseline: string | null;
const contact = (address: string) => ({ ID: 3067, cID: 3067, NAME: 'OP Shop Sales', COMPANY: '', ADDRESS: address });

beforeEach(() => {
  jest.clearAllMocks();
  baseline = null;
  mockQuery.mockImplementation(async (sql: string, params: any[] = []) => {
    if (sql.includes("key = 'shop_job_client_id'")) return { rows: [{ value: '3067' }] };
    if (sql.startsWith('SELECT value FROM system_settings WHERE key = $1')) {
      return { rows: baseline == null ? [] : [{ value: baseline }] };
    }
    if (sql.includes('INSERT INTO system_settings')) { baseline = params[1]; return { rows: [] }; }
    throw new Error(`unexpected SQL: ${sql}`);
  });
});

describe('checkShopContact', () => {
  it('records a baseline on the first run and says nothing', async () => {
    mockContacts.mockResolvedValue([contact('')]);
    expect(await checkShopContact()).toBe('baseline');
    expect(mockEmail).not.toHaveBeenCalled();
    expect(JSON.parse(baseline!)).toEqual({ name: 'OP Shop Sales', company: '', address: '' });
  });

  it('stays quiet while nothing changes', async () => {
    mockContacts.mockResolvedValue([contact('')]);
    await checkShopContact();
    expect(await checkShopContact()).toBe('unchanged');
    expect(mockEmail).not.toHaveBeenCalled();
  });

  it('emails once when the address is edited, then treats the new value as the baseline', async () => {
    mockContacts.mockResolvedValue([contact('')]);
    await checkShopContact();

    mockContacts.mockResolvedValue([contact('12 One-off Buyer Street')]);
    expect(await checkShopContact()).toBe('changed');
    expect(mockEmail).toHaveBeenCalledTimes(1);
    expect(mockEmail.mock.calls[0][0].html).toContain('12 One-off Buyer Street');

    expect(await checkShopContact()).toBe('unchanged');
    expect(mockEmail).toHaveBeenCalledTimes(1);
  });

  it('emails once if the contact disappears from HireHop', async () => {
    mockContacts.mockResolvedValue([contact('')]);
    await checkShopContact();
    mockContacts.mockResolvedValue([]);
    expect(await checkShopContact()).toBe('changed');
    expect(mockEmail.mock.calls[0][0].html).toContain('no longer');
    await checkShopContact();
    expect(mockEmail).toHaveBeenCalledTimes(1);
  });
});
