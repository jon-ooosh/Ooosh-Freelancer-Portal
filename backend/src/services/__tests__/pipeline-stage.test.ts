import {
  isBackwardsTransition,
  isBookingWonTransition,
  isUnwonTransition,
  PRE_CONFIRMED_STATUSES,
} from '../pipeline-stage';

describe('isBookingWonTransition', () => {
  it('counts every pre-confirmed stage as winning the booking', () => {
    for (const s of PRE_CONFIRMED_STATUSES) {
      expect(isBookingWonTransition(s)).toBe(true);
    }
  });

  it('counts a resurrection from lost/cancelled as a win', () => {
    expect(isBookingWonTransition('lost')).toBe(true);
    expect(isBookingWonTransition('cancelled')).toBe(true);
  });

  it('rejects the corrections that caused the false last-minute alerts', () => {
    // Jobs 15912, 16453, 16491 — all prepped -> confirmed.
    expect(isBookingWonTransition('prepped')).toBe(false);
    expect(isBookingWonTransition('prepping')).toBe(false);
    expect(isBookingWonTransition('dispatched')).toBe(false);
    expect(isBookingWonTransition('returned')).toBe(false);
    expect(isBookingWonTransition('completed')).toBe(false); // job 15399
  });

  it('rejects a re-save of an already-confirmed job', () => {
    expect(isBookingWonTransition('confirmed')).toBe(false);
  });

  it('rejects an unknown or missing from-status rather than guessing', () => {
    expect(isBookingWonTransition(null)).toBe(false);
    expect(isBookingWonTransition(undefined)).toBe(false);
    expect(isBookingWonTransition('not_a_status')).toBe(false);
  });
});

describe('isBackwardsTransition', () => {
  it('spots a wind-back down the ladder', () => {
    expect(isBackwardsTransition('prepped', 'confirmed')).toBe(true);
    expect(isBackwardsTransition('completed', 'confirmed')).toBe(true);
    expect(isBackwardsTransition('dispatched', 'prepped')).toBe(true);
    expect(isBackwardsTransition('confirmed', 'provisional')).toBe(true);
  });

  it('does not call ordinary progress backwards', () => {
    expect(isBackwardsTransition('provisional', 'confirmed')).toBe(false);
    expect(isBackwardsTransition('confirmed', 'prepped')).toBe(false);
    expect(isBackwardsTransition('returned', 'completed')).toBe(false);
  });

  it('treats a same-status re-save as not backwards', () => {
    expect(isBackwardsTransition('confirmed', 'confirmed')).toBe(false);
  });

  it('declines to rank the off-ramps', () => {
    // Losing a confirmed job is not "backwards"; the routes handle lost and
    // cancelled by name, and answering true here would double up on that.
    expect(isBackwardsTransition('confirmed', 'lost')).toBe(false);
    expect(isBackwardsTransition('cancelled', 'confirmed')).toBe(false);
    expect(isBackwardsTransition('paused', 'confirmed')).toBe(false);
  });
});

describe('isUnwonTransition', () => {
  it('un-wins a job dropped back below confirmed', () => {
    expect(isUnwonTransition('confirmed', 'provisional')).toBe(true);
    expect(isUnwonTransition('prepped', 'new_enquiry')).toBe(true);
    expect(isUnwonTransition('dispatched', 'paused')).toBe(true);
  });

  it('leaves forward progress alone', () => {
    expect(isUnwonTransition('provisional', 'confirmed')).toBe(false);
    expect(isUnwonTransition('confirmed', 'prepped')).toBe(false);
  });

  it('does not un-win a shuffle inside the enquiry stages', () => {
    expect(isUnwonTransition('new_enquiry', 'provisional')).toBe(false);
    expect(isUnwonTransition('paused', 'quoting')).toBe(false);
  });

  it('does not treat a lost/cancelled resurrection as un-winning', () => {
    // Those clear their own fields by name; double-handling would wipe a
    // confirmation stamp the resurrection path means to keep.
    expect(isUnwonTransition('lost', 'new_enquiry')).toBe(false);
    expect(isUnwonTransition('cancelled', 'provisional')).toBe(false);
  });

  it('never fires on a move INTO a post-confirmation status', () => {
    expect(isUnwonTransition('prepped', 'confirmed')).toBe(false);
    expect(isUnwonTransition('completed', 'returned')).toBe(false);
  });
});
