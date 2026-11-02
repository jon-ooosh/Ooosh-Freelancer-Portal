/**
 * The staff "needs arranging" reminder's wording. The last reminder normally
 * lands the day before, but lands on the day itself when the date was brought
 * forward after the previous morning's run (Frazey Ford, HH 16391, Oct 2026:
 * "TOMORROW — not yet arranged … that's today away" on the day).
 */
export {};

jest.mock('../../config/database', () => ({ query: jest.fn() }));
jest.mock('../email-service', () => ({ emailService: { send: jest.fn() } }));
jest.mock('../../config/app-urls', () => ({ getFrontendUrl: () => 'https://staff.example' }));

import { levelLabel, whenLabel, levelDueForDaysUntil } from '../arranging-chaser';
import emailTemplates from '../email-templates';

describe('arranging reminder wording', () => {
  it('says TODAY when the last reminder lands on the day', () => {
    expect(levelLabel(3, 0)).toBe('TODAY — not yet arranged');
    expect(whenLabel(0)).toBe('today');
  });

  it('says TOMORROW the day before', () => {
    expect(levelLabel(3, 1)).toBe('TOMORROW — not yet arranged');
    expect(whenLabel(1)).toBe('tomorrow');
  });

  it('keeps the earlier headlines and counts days further out', () => {
    expect(levelLabel(2, 3)).toBe('Arriving soon — needs arranging');
    expect(levelLabel(1, 5)).toBe('Needs arranging');
    expect(whenLabel(3)).toBe('3 days away');
  });

  it('on the day, the due level is the last one', () => {
    expect(levelDueForDaysUntil(0, 2)).toBe(3);
  });

  it('the template no longer adds its own "away"', () => {
    const body = emailTemplates.arranging_reminder.body;
    expect(body).toContain("that's\n        <strong>{{daysUntilLabel}}</strong> and needs picking up.");
    expect(body).not.toContain('</strong> away');
  });
});
