/**
 * The rule is small; the ways it silently fails are not.
 *
 * Every case here is one that has actually bitten this codebase: a preferred
 * name that was set and ignored, a field cleared to an empty string rather than
 * NULL, and a row that never SELECTed the column and so looked like it worked.
 */
import { greetingName, fullDisplayName, DISPLAY_NAME_SQL } from '../display-name';

describe('greetingName', () => {
  it('uses the preferred name when there is one', () => {
    expect(greetingName({ first_name: 'William', preferred_name: 'Will' })).toBe('Will');
  });

  it('falls back to the legal first name when none is set', () => {
    expect(greetingName({ first_name: 'Sarah', preferred_name: null })).toBe('Sarah');
  });

  it('treats an EMPTY preferred name as not set', () => {
    // Someone types a preferred name, thinks better of it and clears the box.
    // The field comes back '' rather than NULL, and a bare `||` would then
    // greet them by an empty string.
    expect(greetingName({ first_name: 'Robert', preferred_name: '' })).toBe('Robert');
    expect(greetingName({ first_name: 'Robert', preferred_name: '   ' })).toBe('Robert');
  });

  it('trims, so a stray space does not reach the greeting', () => {
    expect(greetingName({ first_name: 'William', preferred_name: ' Will ' })).toBe('Will');
  });

  it('falls back to "there" rather than greeting nobody', () => {
    expect(greetingName({ first_name: null, preferred_name: null })).toBe('there');
    expect(greetingName(null)).toBe('there');
    expect(greetingName(undefined)).toBe('there');
  });

  it('takes a caller-supplied fallback', () => {
    expect(greetingName({}, 'friend')).toBe('friend');
  });

  it('silently reads as correct when the query forgot to SELECT preferred_name', () => {
    // The trap worth knowing about: this is indistinguishable from "no
    // preferred name set". It returns the legal name and nothing errors, which
    // is exactly how the @mention surfaces ignored preferred names for weeks.
    // The fix is at the query, not here — assert the behaviour so the next
    // person reading this knows the function cannot catch it for them.
    expect(greetingName({ first_name: 'William' } /* no preferred_name key */)).toBe('William');
  });
});

describe('fullDisplayName', () => {
  it('keeps the real surname alongside the preferred first name', () => {
    expect(fullDisplayName({ first_name: 'William', last_name: 'Parish', preferred_name: 'Will' }))
      .toBe('Will Parish');
  });

  it('works with no preferred name', () => {
    expect(fullDisplayName({ first_name: 'Sarah', last_name: 'Jones' })).toBe('Sarah Jones');
  });

  it('does not leave a dangling space when half the name is missing', () => {
    expect(fullDisplayName({ first_name: 'Will', last_name: null })).toBe('Will');
    expect(fullDisplayName({ first_name: null, last_name: 'Parish' })).toBe('Parish');
  });

  it('falls back to the email, then to the caller fallback', () => {
    expect(fullDisplayName({ email: 'will@oooshtours.co.uk' })).toBe('will@oooshtours.co.uk');
    expect(fullDisplayName({}, 'Unknown')).toBe('Unknown');
    expect(fullDisplayName(null, 'Unknown')).toBe('Unknown');
  });

  it('returns an empty string by default rather than the word "undefined"', () => {
    expect(fullDisplayName({})).toBe('');
  });
});

describe('DISPLAY_NAME_SQL', () => {
  it('prefers preferred_name and treats an empty string as unset', () => {
    // Guards the NULLIF specifically: COALESCE alone would pass '' through and
    // render a name with a leading space. Checked against Postgres separately;
    // this stops the NULLIF being "tidied away" by someone who reads it as
    // redundant.
    expect(DISPLAY_NAME_SQL).toContain("NULLIF(p.preferred_name, '')");
    expect(DISPLAY_NAME_SQL).toContain('COALESCE');
    expect(DISPLAY_NAME_SQL).toContain('p.last_name');
  });
});
