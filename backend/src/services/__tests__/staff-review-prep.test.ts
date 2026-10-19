/**
 * The review question set comes from system_settings so jon can rewrite the
 * wording without a deploy — which means a human can put anything in there.
 *
 * The rule these tests pin down: a bad value NEVER takes the review form down
 * and NEVER shows an empty one. An empty form is worse than the old wording,
 * and the person filling it in has no way to know something is broken.
 */
jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../../routes/system-settings', () => ({ getSystemSetting: jest.fn() }));

import { getSystemSetting } from '../../routes/system-settings';
import { getReviewQuestions, DEFAULT_QUESTIONS } from '../staff-review-prep';

const mockSetting = getSystemSetting as jest.MockedFunction<typeof getSystemSetting>;

beforeEach(() => {
  mockSetting.mockReset();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('review questions', () => {
  it('uses the configured set when it is a JSON array of strings', async () => {
    mockSetting.mockResolvedValue('["How did it go?","What next?"]');
    expect(await getReviewQuestions()).toEqual(['How did it go?', 'What next?']);
  });

  it('falls back when the setting is missing', async () => {
    mockSetting.mockResolvedValue(null);
    expect(await getReviewQuestions()).toEqual(DEFAULT_QUESTIONS);
  });

  it('falls back when the setting is blank', async () => {
    mockSetting.mockResolvedValue('   ');
    expect(await getReviewQuestions()).toEqual(DEFAULT_QUESTIONS);
  });

  it('falls back on unparseable JSON rather than throwing', async () => {
    mockSetting.mockResolvedValue('["unterminated');
    await expect(getReviewQuestions()).resolves.toEqual(DEFAULT_QUESTIONS);
  });

  it('falls back when the JSON is valid but not an array', async () => {
    mockSetting.mockResolvedValue('{"q1":"How did it go?"}');
    expect(await getReviewQuestions()).toEqual(DEFAULT_QUESTIONS);
  });

  it('falls back when an array contains no usable strings', async () => {
    mockSetting.mockResolvedValue('[1, 2, null, "   "]');
    expect(await getReviewQuestions()).toEqual(DEFAULT_QUESTIONS);
  });

  it('keeps the good entries and drops the junk, rather than failing outright', async () => {
    mockSetting.mockResolvedValue('["  Keep me  ", 7, "", "And me"]');
    expect(await getReviewQuestions()).toEqual(['Keep me', 'And me']);
  });

  it('ships six questions by default — about the ceiling before people write "n/a"', () => {
    expect(DEFAULT_QUESTIONS).toHaveLength(6);
  });
});
