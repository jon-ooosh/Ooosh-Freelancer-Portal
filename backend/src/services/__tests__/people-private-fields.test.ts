/**
 * Guards the fix for the leak found in spec §13.1: `GET /api/people` and
 * `GET /api/people/:id` both `SELECT p.*` behind STAFF_ROLES, so every private
 * column migration 206 added to `people` was being served to the whole team.
 *
 * These tests exist to fail loudly if somebody shortens the redaction list or
 * makes the helper mutate its input.
 */

import {
  PRIVATE_PERSON_FIELDS,
  redactPrivateFields,
  redactPrivateFieldsAll,
} from '../people-private-fields';

function personRow() {
  return {
    id: 'p1',
    first_name: 'Will',
    last_name: 'Parish',
    email: 'will@oooshtours.co.uk',
    // The private five (migration 206).
    ni_number_encrypted: 'abc:def:0123456789',
    rtw_checked_on: '2026-01-10',
    rtw_document_type: 'Biometric residence permit',
    rtw_expires_on: '2027-01-10',
    rtw_checked_by: 'u1',
  };
}

describe('people private fields', () => {
  it('strips every private field from a single row', () => {
    const out = redactPrivateFields(personRow());
    for (const field of PRIVATE_PERSON_FIELDS) {
      expect(out).not.toHaveProperty(field);
    }
  });

  it('keeps everything else intact', () => {
    const out = redactPrivateFields(personRow());
    expect(out.id).toBe('p1');
    expect(out.first_name).toBe('Will');
    expect(out.email).toBe('will@oooshtours.co.uk');
  });

  it('does not mutate the input — an audit snapshot off the same row keeps the lot', () => {
    const row = personRow();
    redactPrivateFields(row);
    expect(row.ni_number_encrypted).toBe('abc:def:0123456789');
    expect(row.rtw_document_type).toBe('Biometric residence permit');
  });

  it('strips across a list', () => {
    const out = redactPrivateFieldsAll([personRow(), personRow()]);
    expect(out).toHaveLength(2);
    for (const row of out) {
      for (const field of PRIVATE_PERSON_FIELDS) {
        expect(row).not.toHaveProperty(field);
      }
    }
  });

  it('covers the immigration-status fields specifically', () => {
    // The ones that read as ordinary columns but say something about a
    // colleague's right to be in the country. Named explicitly so removing one
    // from the list is a deliberate act, not a quiet edit.
    expect(PRIVATE_PERSON_FIELDS).toContain('rtw_document_type');
    expect(PRIVATE_PERSON_FIELDS).toContain('rtw_expires_on');
    expect(PRIVATE_PERSON_FIELDS).toContain('ni_number_encrypted');
  });

  it('handles a row that has none of them', () => {
    const out = redactPrivateFields({ id: 'p2', first_name: 'Tom' });
    expect(out).toEqual({ id: 'p2', first_name: 'Tom' });
  });
});
