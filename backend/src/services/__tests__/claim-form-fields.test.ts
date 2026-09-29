import {
  CLAIM_SECTIONS, sanitiseSection, resolveOutlineType, sanitiseDamageMarks, isFieldShown, CLIENT_SECTION_KEYS,
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
});
