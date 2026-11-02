import {
  CLAIM_SECTIONS, sanitiseSection, resolveOutlineType, sanitiseDamageMarks, isFieldShown, CLIENT_SECTION_KEYS,
  sectionMissing, sectionFormatErrors, fieldFormatError,
} from '../claim-form-fields';

const section = (key: string) => CLAIM_SECTIONS.find((s) => s.key === key)!;

describe('claim-form-fields', () => {
  it('client sections never include the Ooosh-only or driver ones', () => {
    expect(CLIENT_SECTION_KEYS).not.toContain('cover');
    expect(CLIENT_SECTION_KEYS).not.toContain('our_vehicle');
    expect(CLIENT_SECTION_KEYS).not.toContain('driver');
    expect(CLIENT_SECTION_KEYS).toContain('incident');
  });

  it('sanitiseSection drops unknown keys and wrong types', () => {
    const out = sanitiseSection(section('incident'), {
      date: '2026-09-25', time: '9pm', concerns: false, evil: '<script>', our_speed: 123, speed_limit: '30',
    });
    expect(out).toEqual({ date: '2026-09-25', time: '9pm', concerns: false, speed_limit: '30' });
  });

  it('sanitiseSection rejects a malformed date and a yes/no that is not boolean', () => {
    expect(sanitiseSection(section('incident'), { date: 'yesterday', concerns: 'yes' })).toEqual({});
  });

  it('list sections keep only known roles and cap rows', () => {
    const rows = sanitiseSection(section('people'), [{ roles: ['Witness', 'Hacker'], name: 'Wendy' }]) as Array<Record<string, unknown>>;
    expect(rows).toEqual([{ roles: ['Witness'], name: 'Wendy' }]);
    const many = sanitiseSection(section('people'), Array.from({ length: 50 }, () => ({ name: 'x' }))) as unknown[];
    expect(many).toHaveLength(30);
    expect(sanitiseSection(section('people'), 'nope')).toEqual([]);
  });

  it('choice fields only accept listed options', () => {
    expect(sanitiseSection(section('driver'), { title: 'Mr' })).toEqual({ title: 'Mr' });
    expect(sanitiseSection(section('driver'), { title: 'Emperor' })).toEqual({});
  });

  it('resolveOutlineType: explicit wins, then a guess from the model text', () => {
    expect(resolveOutlineType({ outline_type: 'vito', model: 'Sprinter LWB' })).toBe('vito');
    expect(resolveOutlineType({ model: 'Vito Tourer' })).toBe('vito');
    expect(resolveOutlineType({ model: 'V-Class' })).toBe('vito');
    expect(resolveOutlineType({ model: 'Sprinter 316', vehicle_type: 'PREMIUM LWB (A)' })).toBe('sprinter_lwb');
    expect(resolveOutlineType({ model: 'Sprinter 314 MWB' })).toBe('sprinter_mwb');
    expect(resolveOutlineType({ model: 'Sprinter' })).toBe('sprinter_mwb');
    expect(resolveOutlineType({ model: 'Transit' })).toBe('generic');
  });

  it('sanitiseDamageMarks keeps valid marks, normalises angles, drops the rest', () => {
    expect(sanitiseDamageMarks([
      { x: 20, y: 30, kind: 'cross', note: 'dent' },
      { x: 150, y: 1 },
      { x: 50, y: 50, kind: 'arrow', angle: 450 },
      { x: 50, y: 50, kind: 'arrow', angle: -45 },
      'junk',
    ])).toEqual([
      { x: 20, y: 30, kind: 'cross', note: 'dent' },
      { x: 50, y: 50, kind: 'arrow', angle: 90 },
      { x: 50, y: 50, kind: 'arrow', angle: 315 },
    ]);
    expect(sanitiseDamageMarks('nope')).toEqual([]);
  });

  it('isFieldShown handles the NOT: form', () => {
    const f = section('cover').fields.find((x) => x.key === 'owner_details')!;
    expect(isFieldShown(f, { ownership: 'Owned' })).toBe(false);
    expect(isFieldShown(f, { ownership: 'Hired' })).toBe(true);
    expect(isFieldShown(f, {})).toBe(false);
  });

  it('client sections never include the staff-only non-hire driver', () => {
    expect(CLIENT_SECTION_KEYS).not.toContain('non_hire_driver');
  });

  it('showIf on a multi-choice field matches when the value includes it', () => {
    const knows = section('people').fields.find((f) => f.key === 'knows_us')!;
    expect(isFieldShown(knows, { roles: ['Other driver', 'Witness'] })).toBe(true);
    expect(isFieldShown(knows, { roles: ['Other driver'] })).toBe(false);
  });

  it('sectionMissing: plain section needs its required fields, conditional ones only when shown', () => {
    expect(sectionMissing(section('incident'), {})).toEqual(['Date', 'Place (junction name and town)']);
    expect(sectionMissing(section('incident'), { incident: { date: '2026-09-30', place: 'Brighton' } })).toEqual([]);
    expect(sectionMissing(section('incident'), { incident: { date: '2026-09-30', place: 'Brighton', concerns: true } }))
      .toEqual(['Describe the concerns']);
  });

  it('sectionMissing: police needs a reference or station only when informed', () => {
    expect(sectionMissing(section('police'), { police: { informed: false } })).toEqual([]);
    expect(sectionMissing(section('police'), { police: { informed: true } })).toEqual(['Police reference number or station']);
    expect(sectionMissing(section('police'), { police: { informed: true, station: 'Hove' } })).toEqual([]);
  });

  it('sectionMissing: a list needs its gate answered, a row when yes, and each row complete', () => {
    const people = section('people');
    expect(sectionMissing(people, {})).toEqual([people.gate!.label]);
    expect(sectionMissing(people, { people_involved: false })).toEqual([]);
    expect(sectionMissing(people, { people_involved: true })).toEqual(['At least one person']);
    expect(sectionMissing(people, { people_involved: true, people: [{ phone: '0123 456789' }] })).toEqual(['Person 1: Name']);
    // Rows without the gate count as a yes.
    expect(sectionMissing(people, { people: [{ name: 'Wendy' }] })).toEqual([]);
    const ov = section('other_vehicles');
    expect(sectionMissing(ov, { other_vehicles_involved: true, other_vehicles: [{ owner_name: 'Bob' }] }))
      .toEqual(['Vehicle / property 1: Make and model, or registration']);
  });

  it('sectionMissing: account description needs some length; driver details needed when any declaration is yes', () => {
    expect(sectionMissing(section('account'), { account: { description: 'Hit a post', at_fault: true } }))
      .toEqual(['What happened, in detail (a little more detail, please)']);
    const drv = { title: 'Mr', occupation: 'Tour manager', decl_accidents: false, decl_convictions: true, decl_disability: false };
    expect(sectionMissing(section('driver'), { driver: drv })).toEqual(['Full details if yes to any of the above']);
    expect(sectionMissing(section('driver'), { driver: { ...drv, decl_details: 'SP30 2024' } })).toEqual([]);
  });

  it('fieldFormatError: email needs @ and a dot; phone is loose but digits-only', () => {
    const email = section('people').fields.find((f) => f.key === 'email')!;
    const phone = section('people').fields.find((f) => f.key === 'phone')!;
    expect(fieldFormatError(email, 'a@b.co')).toBeNull();
    expect(fieldFormatError(email, 'a@b')).not.toBeNull();
    expect(fieldFormatError(email, '')).toBeNull();
    expect(fieldFormatError(phone, '+44 (0)7700 900123')).toBeNull();
    expect(fieldFormatError(phone, '+49 30 123456')).toBeNull();
    expect(fieldFormatError(phone, 'ask at venue')).not.toBeNull();
    expect(fieldFormatError(phone, '12345')).not.toBeNull();
    expect(sectionFormatErrors(section('people'), [{ name: 'W', email: 'nope' }])).toHaveLength(1);
  });
});
