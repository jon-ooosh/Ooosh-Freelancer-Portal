/**
 * "Whose invoice?" only ever suggests or links a person marked as a freelancer
 * (invoice 26/27052, Oct 2026: a freelancer's other record, not marked as one,
 * had the remittance email and an earlier link, so the invoice listed none of
 * their work and never reached their Earnings).
 */
export {};

jest.mock('../../config/database', () => ({ query: jest.fn() }));
jest.mock('../xero-broker', () => ({ xeroBroker: {} }));

import { query } from '../../config/database';
import { personIdByEmail, suggestInvoicePerson } from '../freelancer-invoice-person';

const mockQuery = query as jest.Mock;

const FREELANCER = { id: 'f-1', first_name: 'Chris', last_name: 'Woolison', preferred_name: null, email: 'chris@work.example', is_freelancer: true };
const TWIN = { id: 'p-2', first_name: 'Chris', last_name: 'Woollison', preferred_name: null, email: 'chris@company.example', is_freelancer: false };
const PEOPLE = [FREELANCER, TWIN];

/**
 * A tiny stand-in for the queries the service makes: earlier invoices, a
 * person by id, people by email, and every freelancer (the name match). People
 * are narrowed to freelancers only when the SQL itself asks for that, so a
 * query that forgets to is caught.
 */
function fakeDb(prior: Array<{ supplier_name: string; person_id: string | null; remittance_email: string | null }>) {
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM costs')) return { rows: prior };
    const pool = sql.includes('is_freelancer = true') ? PEOPLE.filter((p) => p.is_freelancer) : PEOPLE;
    if (sql.includes('WHERE id = $1')) return { rows: pool.filter((p) => p.id === params[0]) };
    if (sql.includes('LOWER(TRIM(email))')) {
      const e = String(params[0]).trim().toLowerCase();
      return { rows: pool.filter((p) => p.email.toLowerCase() === e) };
    }
    if (sql.includes('FROM people')) return { rows: pool };
    throw new Error(`unexpected query: ${sql}`);
  });
}

beforeEach(() => mockQuery.mockReset());

describe('personIdByEmail', () => {
  it('finds the freelancer with that address', async () => {
    fakeDb([]);
    expect(await personIdByEmail('Chris@Work.example ')).toBe('f-1');
  });

  it('never returns someone who is not marked as a freelancer, even when they are the only match', async () => {
    fakeDb([]);
    expect(await personIdByEmail('chris@company.example')).toBeNull();
  });
});

describe('suggestInvoicePerson', () => {
  it('passes over an earlier invoice linked to the non-freelancer record for an older one linked to the freelancer', async () => {
    // Newest first, as the query orders them.
    fakeDb([
      { supplier_name: 'Chris Woollison', person_id: 'p-2', remittance_email: 'chris@company.example' },
      { supplier_name: 'Chris Woollison', person_id: 'f-1', remittance_email: null },
    ]);
    const r = await suggestInvoicePerson('Chris Woollison', null);
    expect(r.source).toBe('remembered');
    expect(r.person?.id).toBe('f-1');
  });

  it('suggests nobody rather than the non-freelancer record', async () => {
    // The only earlier link and the only remittance are to the twin, and the
    // freelancer record's name is spelt differently, so nothing matches.
    fakeDb([{ supplier_name: 'Chris Woollison', person_id: 'p-2', remittance_email: 'chris@company.example' }]);
    expect(await suggestInvoicePerson('Chris Woollison', null)).toEqual({ person: null, source: 'none' });
  });

  it('still uses a remittance address that names a freelancer', async () => {
    fakeDb([{ supplier_name: 'Sound Co Ltd', person_id: null, remittance_email: 'chris@work.example' }]);
    const r = await suggestInvoicePerson('Sound Co', null);
    expect(r.source).toBe('remittance');
    expect(r.person?.id).toBe('f-1');
  });
});
