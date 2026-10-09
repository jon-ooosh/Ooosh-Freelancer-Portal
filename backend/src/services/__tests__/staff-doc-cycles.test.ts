/**
 * Document review intervals come from system_settings, so a human can put
 * anything in there. Same rule as the review questions: a bad value must
 * never take the scan down — chasing nothing is a silent failure and chasing
 * everything is a flood.
 */
jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../../routes/system-settings', () => ({ getSystemSetting: jest.fn() }));

import { getSystemSetting } from '../../routes/system-settings';
import { getReviewIntervals, DEFAULT_INTERVALS } from '../staff-doc-cycles';

const mockSetting = getSystemSetting as jest.MockedFunction<typeof getSystemSetting>;

beforeEach(() => {
  mockSetting.mockReset();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('document review intervals', () => {
  it('reads the configured map', async () => {
    mockSetting.mockResolvedValue('{"dvla_check":6,"passport":24}');
    const out = await getReviewIntervals();
    expect(out.dvla_check).toBe(6);
    expect(out.passport).toBe(24);
  });

  it('keeps built-in defaults for types the setting does not mention', async () => {
    mockSetting.mockResolvedValue('{"dvla_check":6}');
    const out = await getReviewIntervals();
    expect(out.licence).toBe(DEFAULT_INTERVALS.licence);
  });

  it('falls back when the setting is missing', async () => {
    mockSetting.mockResolvedValue(null);
    expect(await getReviewIntervals()).toEqual(DEFAULT_INTERVALS);
  });

  it('falls back on unparseable JSON rather than throwing', async () => {
    mockSetting.mockResolvedValue('{"dvla_check":');
    await expect(getReviewIntervals()).resolves.toEqual(DEFAULT_INTERVALS);
  });

  it('falls back when the JSON is an array, not a map', async () => {
    mockSetting.mockResolvedValue('[12, 24]');
    expect(await getReviewIntervals()).toEqual(DEFAULT_INTERVALS);
  });

  it('ignores junk values but keeps the good ones', async () => {
    mockSetting.mockResolvedValue('{"dvla_check":6,"licence":"soon","passport":-4}');
    const out = await getReviewIntervals();
    expect(out.dvla_check).toBe(6);
    expect(out.licence).toBe(DEFAULT_INTERVALS.licence);   // "soon" rejected
    expect(out.passport).toBe(DEFAULT_INTERVALS.passport); // negative rejected
  });

  it('allows 0 — "never re-check" is a real answer, not a missing one', async () => {
    mockSetting.mockResolvedValue('{"dvla_check":0}');
    expect((await getReviewIntervals()).dvla_check).toBe(0);
  });

  it('defaults the DVLA check to twelve months, which is the whole ask', () => {
    expect(DEFAULT_INTERVALS.dvla_check).toBe(12);
  });

  it('gives a contract no cycle — it does not expire and re-reading it yearly is noise', () => {
    expect(DEFAULT_INTERVALS.contract).toBe(0);
  });
});
