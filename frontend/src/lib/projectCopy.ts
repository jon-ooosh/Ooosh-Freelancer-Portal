/**
 * Job projects — every user-facing string in one place, for jon to tune
 * (docs/JOB-PROJECTS-SPEC.md). A project is "these jobs all belong to the same
 * overall thing" — a festival's core backline, outlier stages and band
 * spot-hires. Not quote options (those are "pick ONE"). Hyphens not dashes,
 * no emoji, short.
 */
export const PROJECT_COPY = {
  // Job Detail header
  addLink: '+ Add to a project',
  addLinkTitle: 'Group this job with others for the same festival or event - a panel on each job shows them all',

  // The panel (right-hand column on Job Detail)
  panelHeading: 'Project',
  panelCollapse: 'Hide',
  panelExpand: 'Show',
  client: 'Client',
  lead: 'Lead',
  noLead: 'nobody yet',
  dates: 'Dates for new jobs',
  noDates: 'not set',
  confirmed: 'Confirmed',
  quoted: 'Still quoted',
  valueNote: 'Ex VAT. Lost, cancelled and dismissed jobs are left out; quote options count once.',
  jobCount: (n: number) => `${n} job${n === 1 ? '' : 's'}`,
  thisJob: 'this job',
  newJob: '+ New job in this project',
  newJobTitle: "A new enquiry with this project's client and dates filled in",
  addExisting: '+ Add an existing job',
  edit: 'Edit',
  removeThis: 'Take this job out of the project',
  removeConfirm: (name: string) => `Take this job out of "${name}"? The job itself doesn't change.`,
  loadFailed: 'Could not load the project.',

  // Add to a project (modal)
  addTitle: 'Add to a project',
  addIntro: 'Pick the project this job belongs to, or start a new one from it.',
  addSearch: 'Search projects by name or client',
  addNone: 'No projects yet - start one below.',
  addPick: 'Add to this project',
  addNew: 'Start a new project',
  addNewIntro: "Its client and dates start as this job's - change them if the project's differ.",
  addBack: 'Back',
  saving: 'Saving...',
  cancel: 'Cancel',

  // Edit (modal) — also the "new project" form
  editTitle: 'Edit project',
  newTitle: 'New project',
  nameField: 'Name',
  namePlaceholder: 'e.g. Bloodstock 2027',
  clientField: 'Client (the festival or organiser)',
  clientSearch: 'Search organisations',
  clientClear: 'Clear',
  leadField: 'Lead Ooosh-er',
  datesField: 'Dates for new jobs',
  datesNote: 'Filled in on every NEW job started from this project. Existing jobs keep their own dates - change those on each job.',
  outField: 'Out',
  startField: 'Start',
  endField: 'End',
  returnField: 'Return',
  save: 'Save',
  create: 'Create project',

  // Add an existing job (modal)
  existingTitle: 'Add an existing job',
  existingSearch: 'Search by job number, name or client',
  existingSuggested: "This client's jobs and jobs on these dates",
  existingNone: 'Nothing found.',
  existingInOther: (name: string) => `in "${name}" - adding moves it`,
  existingAdd: 'Add',

  // Pipeline card chip / new enquiry
  chipTitle: (name: string) => `Part of the project "${name}"`,
  enquiryBanner: (name: string) => `Will be added to the project "${name}".`,
  enquiryLinkFailed: (name: string) => `The enquiry was created, but adding it to "${name}" failed - use "+ Add to a project" on the job.`,

  // Global search
  searchLabel: 'Project',
} as const;
