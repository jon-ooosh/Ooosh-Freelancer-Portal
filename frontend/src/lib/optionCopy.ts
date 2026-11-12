/**
 * Quote options — every user-facing string in one place (spec §12: jon tunes the
 * wording here rather than hunting through components).
 *
 * Vocabulary: an "option" is one alternative quote for one enquiry — its own
 * job, its own HireHop job, its own quote PDF, its own payment link. Not a
 * "version": that word is taken by the quote-PDF revisions on the Activity
 * Timeline. Hyphens not dashes, no emoji, short.
 */
export const OPTION_COPY = {
  // Job Detail header
  addLink: '+ Add an option',
  addLinkTitle: 'Quote this enquiry another way - a new job and HireHop job, copied from this one',

  // The bar under the header
  barCaption: (count: number) => `${count} option${count === 1 ? '' : 's'}`,
  barNoneChosen: 'client still choosing',
  barChosen: (optionNo: number) => `Option ${optionNo} confirmed`,
  barAddMore: '+ Add',
  barPin: 'Make this the lead option',
  barUnpin: 'Lead option (pinned) - click to let OP choose again',
  barAutoLead: 'Lead option (automatic) - what the pipeline board shows',
  barAddMoreTitle: 'Add another option',
  barRemove: 'Remove from group',
  barRemoveConfirm: 'Take this job out of the options group? Nothing else changes - it just stops being listed with the others.',
  barLabelPlaceholder: 'Name this set of options',
  barCompare: 'Compare',
  bottomCaption: (optionNo: number, total: number) => `This was Option ${optionNo} of ${total} quoted for this enquiry`,

  // Confirm panel — one option confirmed, the others still open
  confirmTitle: (optionNo: number, label: string | null) =>
    `Option ${optionNo}${label ? ` - ${label}` : ''} is confirmed`,
  confirmIntro: (n: number) => `${n} other option${n === 1 ? '' : 's'} of this enquiry ${n === 1 ? 'is' : 'are'} still open. Mark ${n === 1 ? 'it' : 'them'} lost?`,
  confirmExplain: 'Marking them lost uses the reason "Confirmed Alternative Quote (from us)" - not counted as lost business - moves their HireHop jobs to Not Interested and clears their chase dates. Untick any the client might still want.',
  confirmMark: (n: number) => `Mark the ${n} ticked as Lost`,
  confirmMarking: 'Marking...',
  confirmKeep: 'Keep them open for now',
  confirmNoteOnWinner: (losers: string, winnerNo: number) => `${losers} marked lost (Confirmed Alternative Quote) - client took Option ${winnerNo}`,
  confirmLostDetail: (winnerNo: number, label: string | null, ref: string) => `Client took Option ${winnerNo}${label ? ` - ${label}` : ''} (${ref})`,
  confirmTransitionNote: (winnerNo: number, ref: string) => `Client confirmed Option ${winnerNo} (${ref})`,

  // "None of them" — the client turned every option down (one reason, one go)
  barNoneOfThem: 'None of them',
  barNoneOfThemTitle: 'The client turned every option down - mark them all lost in one go',
  barAllClosed: 'none going ahead',
  noneTitle: 'None of the options going ahead',
  noneIntro: 'Mark these lost with one reason. Untick any the client might still want.',
  noneReason: 'Why was this lost?',
  noneDetailPlaceholder: 'Any details... (goes on every option)',
  noneExplain: 'Each option goes through the normal Lost step: open cards cancelled, chase date cleared, HireHop moved to Not Interested. This is a real loss, so it counts - once, as the group.',
  noneSubmit: (n: number) => `Mark ${n === 1 ? 'it' : `all ${n}`} as Lost`,
  noneMarking: 'Marking...',
  noneCancel: 'Cancel',
  noneTransitionNote: (total: number) => `Client chose none of the ${total} options`,

  // Lost banner on an option the client didn't pick
  lostAltBanner: 'The client chose another option of this enquiry - this slot is theirs, so there is no gap to fill.',

  // Compare slide-over
  compareTitle: 'Compare options',
  compareNoLabel: 'add a label',
  compareEditLabel: 'Click to edit what makes this option different',
  compareItemsNote: '"Items" counts everything physical on the HireHop job - a Fender Twin and a splitter cable both count. Hover a count for the names.',
  compareLeadLine: 'Lead option for the pipeline board:',
  compareLeadAuto: 'automatic - most progressed',
  compareLeadPinned: 'pinned',

  // Add-an-option modal
  modalTitle: 'Quote another option',
  modalBasedOn: (optionNo: number | null, label: string | null, ref: string) =>
    `Based on ${optionNo ? `Option ${optionNo}` : 'this job'}${label ? ` - ${label}` : ''} (${ref})`,
  modalIntro: 'Copies this job and its HireHop job. The new option gets its own quote and payment link - change the kit in HireHop as usual.',
  labelField: "What's different?",
  labelPlaceholder: 'e.g. Van + driver, whole stretch, with Fender Twin',
  labelHint: 'Shows on the option tab and in the comparison.',
  labelChips: ['Different dates', 'Van + driver', 'Self-drive', 'Add backline', 'Whole stretch'],
  datesHeading: 'Dates',
  datesHint: 'From this job. Times stay the same.',
  dateOut: 'Out',
  dateStart: 'Start',
  dateEnd: 'End',
  dateReturn: 'Return',
  hhCheckbox: 'Create the HireHop job now',
  hhUnavailable: 'This job is not in HireHop yet, so the option will be OP-only - use "Create in HireHop" on it afterwards.',
  submit: (optionNo: number) => `Create Option ${optionNo}`,
  submitting: 'Creating...',
  cancel: 'Cancel',
  linkExistingToggle: 'Already quoted this as a separate job? Link it instead',
  linkExistingTitle: 'Link an existing quote',
  linkExistingSearch: 'Search by job number or name',
  linkExistingSameClient: 'Other open quotes for this client',
  linkExistingNone: 'No other open quotes for this client. Search above to link one from elsewhere.',
  linkExistingDifferentClient: 'different client',
  linkExistingSubmit: 'Link as an option',
  linkExistingBack: 'Back',

  // The tag after a grouped job's name on global search and Hire History (spec §6.5)
  tag: (optionNo: number, total: number) => `Option ${optionNo} of ${total}`,
  tagTitle: (optionNo: number, total: number) => `One of ${total} alternative quotes for the same enquiry - this is Option ${optionNo}`,
  tagAltLostTitle: 'The client chose another option of this enquiry - not counted as lost business',

  // Results
  createdOpWarn: 'Created in OP, but the HireHop duplicate failed - open the new option and use "Create in HireHop".',
  warningsHeading: 'Done, with warnings:',
} as const;
