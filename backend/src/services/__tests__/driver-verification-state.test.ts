import { computeVerificationState } from '../driver-verification-state';
import { addDaysYmd } from '../driver-validity';

const TODAY = '2026-08-19';
const stage = (s: ReturnType<typeof computeVerificationState>, key: string) =>
  s.stages.find(x => x.key === key)!;

/** A UK driver with everything in order. */
const healthy = {
  full_name: 'Test Driver',
  email: 'test@example.com',
  phone: '07700900000',
  insurance_status: 'Approved',
  signature_date: '2026-08-01',
  licence_issued_by: 'DVLA',
  licence_valid_to: '2029-04-18',
  idenfy_check_date: addDaysYmd(TODAY, -10),
  dvla_check_date: addDaysYmd(TODAY, -5),
  poa1_doc_date: addDaysYmd(TODAY, -10),
  poa2_doc_date: addDaysYmd(TODAY, -10),
};

describe('healthy driver', () => {
  const state = computeVerificationState(healthy, TODAY);

  it('shows every applicable stage done', () => {
    for (const key of ['contact', 'insurance', 'identity', 'poa1', 'poa2', 'dvla', 'signature']) {
      expect([key, stage(state, key).state]).toEqual([key, 'done']);
    }
  });

  it('marks passport not required for a UK driver', () => {
    expect(stage(state, 'passport').state).toBe('not_required');
  });

  it('has nothing to action', () => {
    expect(state.allClear).toBe(true);
  });
});

describe('identity review', () => {
  it('blocks the identity stage and leads the actions', () => {
    const state = computeVerificationState(
      { ...healthy, identity_check_status: 'needs_review', idenfy_face_result: 'FACE_MISMATCH' },
      TODAY,
    );
    expect(stage(state, 'identity').state).toBe('blocked');
    expect(state.actions[0].severity).toBe('red');
    expect(state.actions[0].kind).toBe('compare_identity');
    expect(state.actions[0].message).toMatch(/FACE_MISMATCH/);
    expect(state.allClear).toBe(false);
  });

  it('clears once staff accept', () => {
    const state = computeVerificationState({ ...healthy, identity_check_status: 'accepted' }, TODAY);
    expect(stage(state, 'identity').state).toBe('done');
    expect(state.allClear).toBe(true);
  });
});

describe('a DENIED check with no licence details', () => {
  // manjagoproduction@: check date written, no licence identity behind it.
  const state = computeVerificationState({
    ...healthy,
    licence_issued_by: null,
    licence_valid_to: null,
    signature_date: null,
  }, TODAY);

  it('blocks identity rather than showing a green window', () => {
    expect(stage(state, 'identity').state).toBe('blocked');
  });

  it('tells staff to send a new hire form', () => {
    const action = state.actions.find(a => a.kind === 'send_hire_form');
    expect(action?.severity).toBe('red');
  });
});

describe('a stale identity check is AMBER, never red', () => {
  // 186 drivers sit past their 90-day window. Red would block over half the
  // signed roster; the physical licence is what stops someone driving.
  const state = computeVerificationState({
    ...healthy,
    idenfy_check_date: addDaysYmd(TODAY, -120),
  }, TODAY);

  it('never raises a red action for it', () => {
    const staleActions = state.actions.filter(a => a.message.match(/identity check lapsed/i));
    expect(staleActions).toHaveLength(1);
    expect(staleActions[0].severity).toBe('amber');
  });
});

describe('POA independence', () => {
  const state = computeVerificationState({
    ...healthy,
    poa2_doc_date: addDaysYmd(TODAY, -200), // lapsed; POA1 still good
  }, TODAY);

  it('blocks only the lapsed one', () => {
    expect(stage(state, 'poa1').state).toBe('done');
    expect(stage(state, 'poa2').state).toBe('blocked');
  });

  it('asks for only the lapsed one back', () => {
    const msgs = state.actions.map(a => a.message).join(' | ');
    expect(msgs).toMatch(/Proof of address 2 expired/);
    expect(msgs).not.toMatch(/Proof of address 1 expired/);
  });
});

describe('non-UK driver', () => {
  const state = computeVerificationState({
    ...healthy,
    licence_issued_by: 'Bundesdruckerei',
    licence_issue_country: 'DE',
    passport_check_date: addDaysYmd(TODAY, -5),
    passport_expiry: '2030-01-01',
  }, TODAY);

  it('swaps DVLA for passport', () => {
    expect(stage(state, 'dvla').state).toBe('not_required');
    expect(stage(state, 'passport').state).toBe('done');
  });

  it('does not chase a DVLA check they cannot produce', () => {
    expect(state.actions.map(a => a.message).join(' ')).not.toMatch(/DVLA/);
  });
});

describe('a missing date is surfaced as its own to-do', () => {
  it('asks for the date rather than a new document', () => {
    const state = computeVerificationState({ ...healthy, dvla_check_date: null }, TODAY);
    const action = state.actions.find(a => a.slot === 'dvla');
    expect(action?.kind).toBe('set_date');
    expect(action?.message).toMatch(/no date recorded/i);
  });
});

describe('signed before, but not for the hire in front of them', () => {
  // Cameron Williams-Hill / job 16618: every document re-verified, April
  // signature still on file, closed the tab before signing. Everything read
  // green while nothing linked him to the hire.
  const state = computeVerificationState({ ...healthy, unsigned_job_number: 16618 }, TODAY);

  it('does not show the signature stage as done', () => {
    expect(stage(state, 'signature').state).toBe('todo');
    expect(stage(state, 'signature').detail).toContain('#16618');
  });

  it('raises an amber action naming the hire', () => {
    const a = state.actions.find(x => x.slot === 'signature');
    expect(a?.severity).toBe('amber');
    expect(a?.message).toContain('#16618');
    expect(state.allClear).toBe(false);
  });

  it('is done again once they have signed for it', () => {
    const done = computeVerificationState({ ...healthy, unsigned_job_number: null }, TODAY);
    expect(stage(done, 'signature').state).toBe('done');
  });
});
