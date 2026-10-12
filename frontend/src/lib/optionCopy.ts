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
  barAddMoreTitle: 'Add another option',
  barRemove: 'Remove from group',
  barRemoveConfirm: 'Take this job out of the options group? Nothing else changes - it just stops being listed with the others.',
  barLabelPlaceholder: 'Name this set of options',

  // Add-an-option modal
  modalTitle: 'Quote another option',
  modalBasedOn: (optionNo: number | null, label: string | null, ref: string) =>
    `Based on ${optionNo ? `Option ${optionNo}` : 'this job'}${label ? ` - ${label}` : ''} (${ref})`,
  modalIntro: 'Copies this job and its HireHop job - items, notes, client and contacts - so the new option has its own quote and its own payment link. Then change whatever is different.',
  labelField: "What's different?",
  labelPlaceholder: 'e.g. Van + driver, whole stretch, with Fender Twin',
  labelHint: 'Shows on the option tab and in the comparison.',
  labelChips: ['Different dates', 'Van + driver', 'Self-drive', 'Add backline', 'Whole stretch', 'Extra van'],
  datesHeading: 'Dates',
  datesHint: 'Pre-filled from this job. Times stay the same.',
  dateOut: 'Out',
  dateStart: 'Start',
  dateEnd: 'End',
  dateReturn: 'Return',
  hhCheckbox: 'Create the HireHop job now',
  hhCheckboxHint: 'Needed to send the client a quote. Uses HireHop\'s own duplicate, like Re-open.',
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

  // Results
  createdOpWarn: 'Created in OP, but the HireHop duplicate failed - open the new option and use "Create in HireHop".',
  warningsHeading: 'Done, with warnings:',
} as const;
