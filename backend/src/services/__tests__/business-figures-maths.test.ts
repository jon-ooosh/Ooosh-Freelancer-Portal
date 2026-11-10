import {
  EnquiryRow, londonToUtcMs, officeMinutesBetween, replyBucket, summarise, tally, valueBand,
} from '../business-figures-maths';

const at = (iso: string) => Date.parse(iso);

describe('office time (09:00–18:00 UK, every day)', () => {
  it('converts London wall time in summer and winter', () => {
    expect(new Date(londonToUtcMs('2026-07-01', 9 * 60)).toISOString()).toBe('2026-07-01T08:00:00.000Z');
    expect(new Date(londonToUtcMs('2026-12-01', 9 * 60)).toISOString()).toBe('2026-12-01T09:00:00.000Z');
  });

  it('counts only the open hours', () => {
    // 22:00 UK in winter, answered 09:30 next morning → 30 office minutes.
    expect(officeMinutesBetween(at('2026-11-10T22:00:00Z'), at('2026-11-11T09:30:00Z'))).toBe(30);
    // Within a summer day: 10:00–11:15 UK.
    expect(officeMinutesBetween(at('2026-07-01T09:00:00Z'), at('2026-07-01T10:15:00Z'))).toBe(75);
    // Across a whole day: 17:00 day 1 → 10:00 day 3 = 60 + 540 + 60.
    expect(officeMinutesBetween(at('2026-11-10T17:00:00Z'), at('2026-11-12T10:00:00Z'))).toBe(660);
    expect(officeMinutesBetween(at('2026-11-12T10:00:00Z'), at('2026-11-10T17:00:00Z'))).toBe(0);
  });
});

describe('buckets', () => {
  it('value bands', () => {
    expect(valueBand(null)).toBe('No value yet');
    expect(valueBand(499.99)).toBe('Under £500');
    expect(valueBand(500)).toBe('£500–£2k');
    expect(valueBand(4999)).toBe('£2k–£5k');
    expect(valueBand(12000)).toBe('£5k+');
  });
  it('reply speed', () => {
    expect(replyBucket(null)).toBeNull();
    expect(replyBucket(59)).toBe('Under 1 hour');
    expect(replyBucket(239)).toBe('1–4 hours');
    expect(replyBucket(500)).toBe('4 hours – 1 day');
    expect(replyBucket(540)).toBe('Over 1 day');
  });
});

const row = (o: Partial<EnquiryRow>): EnquiryRow => ({
  jobId: Math.random().toString(36), month: '2026-10', outcome: 'open', lostReason: null, channel: null,
  likelihood: null, value: null, services: [], owner: null, replyMinutes: null, replyBy: null, quoteMinutes: null, ...o,
});

describe('tally', () => {
  it('counts a cancelled booking as booked, and leaves open ones out of the rate', () => {
    const t = tally('x', [
      row({ outcome: 'booked', value: 1000 }), row({ outcome: 'cancelled', value: 800 }),
      row({ outcome: 'lost' }), row({ outcome: 'not_followed_up' }), row({ outcome: 'open' }),
    ]);
    expect(t).toMatchObject({ enquiries: 5, booked: 2, cancelled: 1, lost: 1, notFollowedUp: 1, open: 1, rate: 0.5, bookedValue: 1000 });
  });
  it('has no rate until something is decided', () => {
    expect(tally('x', [row({ outcome: 'open' })]).rate).toBeNull();
  });
});

describe('summarise', () => {
  it('groups by month, service (a row in several), reply speed and lost reason', () => {
    const s = summarise([
      row({ month: '2026-09', outcome: 'booked', services: ['vans', 'backline'], replyMinutes: 20, replyBy: 'Will' }),
      row({ month: '2026-10', outcome: 'lost', lostReason: 'Price', services: ['vans'], replyMinutes: 600, replyBy: 'Will' }),
      row({ month: '2026-10', outcome: 'lost', lostReason: null }),
    ]);
    expect(s.byMonth.map((t) => t.key)).toEqual(['2026-09', '2026-10']);
    expect(s.byService.find((t) => t.key === 'vans')?.enquiries).toBe(2);
    expect(s.byService.find((t) => t.key === 'other')?.enquiries).toBe(1);
    expect(s.byReplySpeed.map((t) => [t.key, t.rate])).toEqual([['Under 1 hour', 1], ['Over 1 day', 0]]);
    expect(s.byReplier[0]).toMatchObject({ key: 'Will', replies: 2, medianReplyMins: 310 });
    expect(s.lostReasons).toEqual([{ reason: 'Price', count: 1 }, { reason: 'No reason given', count: 1 }]);
  });
});
