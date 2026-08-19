/**
 * Monitored UK venues for the Lead Finder.
 *
 * Ported verbatim from the standalone `ooosh-tour-finder` (`config.py`
 * MONITORED_VENUES). Mid-size venues (200-2,000 cap) are the sweet spot — the
 * acts playing them are the ones that need van hire + backline. `tmDiscoveryId`
 * is resolved from `tmWebsiteId` at runtime and cached in-process.
 *
 * Kept in code (not the DB) for now — jon's call (Jul 2026) is that we won't
 * widen the net. Move to a table only if that changes.
 */
export interface MonitoredVenue {
  name: string;
  city: string;
  tmWebsiteId: string;
  approxCapacity: number;
  /** Resolved at runtime; null = resolve on next run. */
  tmDiscoveryId: string | null;
}

export const MONITORED_VENUES: MonitoredVenue[] = [
  { name: 'Hoxton Hall',            city: 'London',      tmWebsiteId: '451096', approxCapacity: 300,  tmDiscoveryId: null },
  { name: 'XOYO Birmingham',        city: 'Birmingham',  tmWebsiteId: '255903', approxCapacity: 450,  tmDiscoveryId: null },
  { name: 'Manchester Academy',     city: 'Manchester',  tmWebsiteId: '254282', approxCapacity: 1000, tmDiscoveryId: null },
  { name: 'Manchester Academy 2',   city: 'Manchester',  tmWebsiteId: '255420', approxCapacity: 500,  tmDiscoveryId: null },
  { name: 'Manchester Academy 3',   city: 'Manchester',  tmWebsiteId: '254711', approxCapacity: 250,  tmDiscoveryId: null },
  { name: 'Manchester Club Academy',city: 'Manchester',  tmWebsiteId: '256072', approxCapacity: 400,  tmDiscoveryId: null },
  { name: 'Electric Ballroom',      city: 'London',      tmWebsiteId: '254126', approxCapacity: 600,  tmDiscoveryId: null },
  { name: 'Roundhouse',             city: 'London',      tmWebsiteId: '254429', approxCapacity: 1700, tmDiscoveryId: null },
  { name: '229',                    city: 'London',      tmWebsiteId: '254421', approxCapacity: 250,  tmDiscoveryId: null },
  { name: 'Brighton Dome',          city: 'Brighton',    tmWebsiteId: '254679', approxCapacity: 1700, tmDiscoveryId: null },
  { name: 'Concorde 2',             city: 'Brighton',    tmWebsiteId: '255354', approxCapacity: 600,  tmDiscoveryId: null },
  { name: 'Green Door Store',       city: 'Brighton',    tmWebsiteId: '435143', approxCapacity: 200,  tmDiscoveryId: null },
  { name: '1865',                   city: 'Southampton', tmWebsiteId: '435305', approxCapacity: 400,  tmDiscoveryId: null },
  { name: 'King Tuts Wah Wah Hut',  city: 'Glasgow',     tmWebsiteId: '444104', approxCapacity: 300,  tmDiscoveryId: null },
  { name: 'O2 Academy Bristol',     city: 'Bristol',     tmWebsiteId: '509558', approxCapacity: 1600, tmDiscoveryId: null },
  { name: 'Stylus',                 city: 'Leeds',       tmWebsiteId: '443638', approxCapacity: 1000, tmDiscoveryId: null },
  { name: 'Brudenell Social Club',  city: 'Leeds',       tmWebsiteId: '434834', approxCapacity: 400,  tmDiscoveryId: null },
  { name: 'O2 Academy Liverpool',   city: 'Liverpool',   tmWebsiteId: '509729', approxCapacity: 1200, tmDiscoveryId: null },
  { name: 'Rescue Rooms',           city: 'Nottingham',  tmWebsiteId: '452069', approxCapacity: 450,  tmDiscoveryId: null },
  { name: 'Rock City',              city: 'Nottingham',  tmWebsiteId: '254420', approxCapacity: 2000, tmDiscoveryId: null },
  { name: 'Liquid Room',            city: 'Edinburgh',   tmWebsiteId: '443089', approxCapacity: 700,  tmDiscoveryId: null },
  { name: 'Tramshed',               city: 'Cardiff',     tmWebsiteId: '256153', approxCapacity: 1000, tmDiscoveryId: null },
  { name: 'Clwb Ifor Bach',         city: 'Cardiff',     tmWebsiteId: '254055', approxCapacity: 350,  tmDiscoveryId: null },
  { name: 'Boiler Shop',            city: 'Newcastle',   tmWebsiteId: '256720', approxCapacity: 1000, tmDiscoveryId: null },
];

// ---------------------------------------------------------------------------
// Heuristic filters (pre-AI), ported from tour_detector.py / config.py
// ---------------------------------------------------------------------------
export const EXCLUDE_CLASSIFICATIONS = [
  'Comedy', 'Theatre', 'Arts', 'Film', 'Sport', 'Miscellaneous',
];

export const EXCLUDE_EVENT_PATTERNS = [
  'tribute', 'dj set', 'comedy', 'spoken word', 'club night',
  'karaoke', 'quiz night', 'open mic', 'drag', 'burlesque',
];
