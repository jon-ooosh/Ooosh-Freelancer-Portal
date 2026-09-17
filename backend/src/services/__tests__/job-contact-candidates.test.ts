/**
 * "Who could we contact on this job?" — the shared candidate pool.
 *
 * Three features read this list and do different things with it: client email
 * routing (`job_contacts`), hire-form recipients
 * (`services/hire-form-contacts.ts`) and, since Sep 2026, who the driver calls
 * on a transport leg (`quote_contacts`). The pool query used to live inline in
 * `GET /api/pipeline/:jobId/contacts`; a second copy would have drifted the
 * moment somebody added a source, which is exactly what happened to the
 * hire-form resolver before it was centralised.
 *
 * Two properties are load-bearing and easy to break:
 *   - it reaches people via `job_organisations`, not just `jobs.client_id`.
 *     A job whose client is the band's company but whose actual contact is a
 *     manager on a linked org is the common case, and the narrow version
 *     returned nobody for it.
 *   - it does NOT require an email. A transport contact is someone the driver
 *     PHONES; filtering on email would hide exactly the site contacts this
 *     was built to surface.
 */
jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));

import { query } from '../../config/database';
import { resolveJobContactCandidates } from '../job-contact-candidates';

const mockQuery = query as jest.MockedFunction<any>;
const JOB_ID = '0f1bc4f0-9414-4837-b59b-5cf4dc022043';

beforeEach(() => mockQuery.mockReset());

function sql(): string {
  return String(mockQuery.mock.calls[0][0]).replace(/\s+/g, ' ');
}

describe('resolveJobContactCandidates', () => {
  it('reaches people through job_organisations, not just the client org', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await resolveJobContactCandidates(JOB_ID);

    expect(sql()).toContain('o.id = j.client_id');
    expect(sql()).toContain('SELECT organisation_id FROM job_organisations WHERE job_id = j.id');
  });

  it('does not require an email — a phone-only site contact must survive', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await resolveJobContactCandidates(JOB_ID);

    const s = sql();
    expect(s).not.toContain('p.email IS NOT NULL');
    expect(s).toContain('p.mobile');
  });

  it('dedupes per person, client org winning over a linked org', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await resolveJobContactCandidates(JOB_ID);

    const s = sql();
    expect(s).toContain('DISTINCT ON (p.id)');
    expect(s).toContain('ORDER BY p.id, source_priority, por.is_primary DESC');
  });

  it('skips deleted people and deleted orgs, and inactive roles', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await resolveJobContactCandidates(JOB_ID);

    const s = sql();
    expect(s).toContain('p.is_deleted = false');
    expect(s).toContain('o.is_deleted = false');
    expect(s).toContain("por.status = 'active'");
  });

  it('shapes a row into a display-ready candidate', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        person_id: 'p1', first_name: 'Sarah', last_name: 'Kane',
        email: 'sarah@atclive.com', phone: null, mobile: '07700900000',
        role: 'Tour Manager', is_org_primary: true,
        source_org_id: 'o1', source_org_name: 'ATC Live',
      }],
    });
    const [c] = await resolveJobContactCandidates(JOB_ID);

    expect(c).toEqual({
      person_id: 'p1',
      name: 'Sarah Kane',
      email: 'sarah@atclive.com',
      phone: null,
      mobile: '07700900000',
      role: 'Tour Manager',
      is_org_primary: true,
      source_org_id: 'o1',
      source_org_name: 'ATC Live',
    });
  });

  it('normalises blanks to null rather than empty strings', async () => {
    // Empty strings render as a clickable tel: link to nowhere on the portal.
    mockQuery.mockResolvedValueOnce({
      rows: [{
        person_id: 'p1', first_name: 'Tom', last_name: '',
        email: '', phone: '', mobile: '',
        role: null, is_org_primary: false,
        source_org_id: null, source_org_name: null,
      }],
    });
    const [c] = await resolveJobContactCandidates(JOB_ID);

    expect(c.name).toBe('Tom');
    expect(c.email).toBeNull();
    expect(c.phone).toBeNull();
    expect(c.mobile).toBeNull();
  });

  it('returns an empty list for a job with nothing linked', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await resolveJobContactCandidates(JOB_ID)).toEqual([]);
  });
});
