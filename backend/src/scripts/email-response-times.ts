/**
 * Email response times — a one-off, READ-ONLY research report on info@.
 *
 * Question it answers: when a client emails info@, how long until we reply —
 * and what happens to the emails that arrive while we're closed (overnight)?
 * Research for a response-time policy, not a feature (jon, Nov 2026).
 *
 * How it works: reads every info@ conversation with a message since --since
 * (straight from Gmail, read-only scope — nothing is written to Gmail or OP's
 * database), then walks each conversation in time order:
 *   - a client email starts a "wait" (more client emails before we answer join
 *     the same wait and count as the client chasing);
 *   - our first email from info@ TO one of those clients ends it.
 * If the reply went out as a separate email (new thread / changed subject),
 * the first email we sent that client after they wrote counts instead.
 *
 * Counted as a client email: anything from an outside address that isn't
 * automated (Auto-Submitted, bulk/list mail, newsletters, no-reply senders),
 * plus website enquiry form emails (From info@, the client in Reply-To).
 * Our own system mail (notifications@) and internal mail are ignored.
 *
 * "Working time" = time inside the open hours only (--open/--close, every day,
 * UK time). An email at 02:00 answered at 09:30 has a 30-minute working wait.
 *
 * Known blind spots: replies from someone's own address (not info@), replies
 * by phone, and emails that genuinely needed no reply (invoices, "thanks!")
 * all show as "not answered" — that list is for a person to skim, not a score.
 *
 * Usage (cd backend):
 *   npx tsx src/scripts/email-response-times.ts
 *   npx tsx src/scripts/email-response-times.ts --since 2026-08-24 --open 09:00 --close 18:00
 *   npx tsx src/scripts/email-response-times.ts --csv /tmp/email-response-times.csv
 *
 * Writes a summary to the screen and one CSV row per client wait (default
 * /tmp/email-response-times.csv — it holds client names and email snippets,
 * so it is created readable by its owner only).
 */
import dotenv from 'dotenv';
dotenv.config();
import { writeFileSync } from 'fs';
import { gmailApiGet, getPrimaryMailbox, isGmailConfigured } from '../config/gmail';

// ── Settings ───────────────────────────────────────────────────────────────

const OWN_DOMAIN = 'oooshtours.co.uk';
// The website enquiry form sends From info@ with the real client in Reply-To.
const WEBSITE_FORM_SENDER = 'info@oooshtours.co.uk';
// Senders that are machines, not people (local part before the @).
const MACHINE_SENDER = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|alerts?|automated)([+._-].*)?$/i;
// Waits that started in the last day are too fresh to judge — left out.
const JUDGE_AFTER_HOURS = 24;
// Parallel Gmail calls, and a pace limit across all of them. Gmail caps
// requests per mailbox per MINUTE, and OP's live ingestion shares that cap for
// info@ — the first run hit it at full speed (403 "Quota exceeded"). One call
// every 250ms (~2,400 quota units a minute) leaves plenty of room for both.
const CONCURRENCY = 4;
const MIN_GAP_MS = 250;

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function parseHhMm(value: string, label: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
    throw new Error(`--${label} must look like 09:00 (got "${value}")`);
  }
  return Number(m[1]) * 60 + Number(m[2]);
}

// ── UK time helpers ────────────────────────────────────────────────────────

const PARTS_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
});

interface LondonParts { y: number; m: number; d: number; hh: number; mm: number; weekday: string }

function londonParts(ms: number): LondonParts {
  const parts = PARTS_FMT.formatToParts(new Date(ms));
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? '';
  const hh = Number(get('hour'));
  return {
    y: Number(get('year')), m: Number(get('month')), d: Number(get('day')),
    hh: hh === 24 ? 0 : hh, mm: Number(get('minute')), weekday: get('weekday'),
  };
}

/** The instant (UTC ms) of a UK wall-clock time: day y-m-d, `minuteOfDay` past midnight. */
function londonToUtc(y: number, m: number, d: number, minuteOfDay: number): number {
  const asIfUtc = Date.UTC(y, m - 1, d, 0, minuteOfDay);
  const offsetAt = (ms: number) => {
    const p = londonParts(ms);
    return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) - Math.floor(ms / MIN_MS) * MIN_MS;
  };
  const first = asIfUtc - offsetAt(asIfUtc);
  return asIfUtc - offsetAt(first);
}

function nextDay(y: number, m: number, d: number): [number, number, number] {
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

interface Hours { open: number; close: number } // minutes past midnight, UK time

function isOpenAt(ms: number, h: Hours): boolean {
  const p = londonParts(ms);
  const mod = p.hh * 60 + p.mm;
  return mod >= h.open && mod < h.close;
}

/** Minutes between two instants that fall inside open hours. */
function openMinutesBetween(startMs: number, endMs: number, h: Hours): number {
  if (endMs <= startMs) return 0;
  const p = londonParts(startMs);
  let [y, m, d] = [p.y, p.m, p.d];
  let total = 0;
  for (let i = 0; i < 1000; i++) {
    const windowStart = londonToUtc(y, m, d, h.open);
    if (windowStart >= endMs) break;
    const windowEnd = londonToUtc(y, m, d, h.close);
    const overlap = Math.min(endMs, windowEnd) - Math.max(startMs, windowStart);
    if (overlap > 0) total += overlap;
    [y, m, d] = nextDay(y, m, d);
  }
  return total / MIN_MS;
}

/** When we next open at or after `ms` (itself, if we're open then). */
function nextOpeningAt(ms: number, h: Hours): number {
  const p = londonParts(ms);
  const mod = p.hh * 60 + p.mm;
  if (mod >= h.open && mod < h.close) return ms;
  if (mod < h.open) return londonToUtc(p.y, p.m, p.d, h.open);
  const [y, m, d] = nextDay(p.y, p.m, p.d);
  return londonToUtc(y, m, d, h.open);
}

/** Closing time of the first open day at or after `ms` — "same working day". */
function sameDayDeadline(ms: number, h: Hours): number {
  const p = londonParts(nextOpeningAt(ms, h));
  return londonToUtc(p.y, p.m, p.d, h.close);
}

function fmtWhen(ms: number): string {
  const p = londonParts(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.weekday} ${pad(p.d)}/${pad(p.m)}/${p.y} ${pad(p.hh)}:${pad(p.mm)}`;
}

function fmtHhMm(minuteOfDay: number): string {
  return `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`;
}

// ── Gmail reading ──────────────────────────────────────────────────────────

interface GmailHeader { name: string; value: string }
interface GmailThreadMessage {
  id: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: { headers?: GmailHeader[] };
}
interface GmailThread { id: string; messages?: GmailThreadMessage[] }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shared pace limit: each call takes the next free slot, MIN_GAP_MS apart.
let nextSlotAt = 0;
async function paced(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextSlotAt);
  nextSlotAt = slot + MIN_GAP_MS;
  if (slot > now) await sleep(slot - now);
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await paced();
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Gmail reports its rate limits as 403 (not only 429). The limit is per
      // minute, so wait the minute out rather than retrying straight away.
      const quota = /Gmail API (403|429)/.test(msg) && /quota|rate ?limit/i.test(msg);
      const transient = /Gmail API 5\d\d|fetch failed|ECONNRESET|ETIMEDOUT/i.test(msg);
      if ((!quota && !transient) || attempt >= 8) throw err;
      const waitMs = quota ? 65_000 : 2000 * 2 ** attempt;
      console.log(`  ${quota ? 'Gmail asked us to slow down' : 'Gmail hiccup'}; waiting ${Math.round(waitMs / 1000)}s and carrying on…`);
      await sleep(waitMs);
    }
  }
}

async function listThreadIds(mailbox: string, sinceMs: number): Promise<string[]> {
  const ids = new Set<string>();
  let pageToken: string | undefined;
  do {
    const qs = new URLSearchParams({ q: `after:${Math.floor(sinceMs / 1000)} -in:chats`, maxResults: '500' });
    if (pageToken) qs.set('pageToken', pageToken);
    const page = await withRetry(() =>
      gmailApiGet<{ threads?: { id: string }[]; nextPageToken?: string }>(`/threads?${qs.toString()}`, mailbox),
    );
    for (const t of page.threads || []) ids.add(t.id);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return [...ids];
}

const WANTED_HEADERS = ['From', 'To', 'Cc', 'Reply-To', 'Subject', 'Auto-Submitted', 'Precedence', 'List-Unsubscribe', 'List-Id'];

async function getThread(mailbox: string, threadId: string): Promise<GmailThread> {
  const qs = new URLSearchParams({ format: 'metadata' });
  for (const h of WANTED_HEADERS) qs.append('metadataHeaders', h);
  return withRetry(() => gmailApiGet<GmailThread>(`/threads/${encodeURIComponent(threadId)}?${qs.toString()}`, mailbox));
}

// ── Classifying messages ───────────────────────────────────────────────────

interface Msg {
  at: number;
  kind: 'client' | 'ours' | 'ignore';
  /** The client's address (Reply-To when set, else From) — client messages only. */
  clientAddr: string | null;
  /** Outside addresses we sent to — our messages only. */
  sentTo: string[];
  fromWebsiteForm: boolean;
  subject: string;
  snippet: string;
}

const ADDRESS_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function addresses(...values: (string | null)[]): string[] {
  const out: string[] = [];
  for (const v of values) for (const a of v?.match(ADDRESS_RE) || []) out.push(a.toLowerCase());
  return out;
}

function isOwn(addr: string): boolean {
  const domain = addr.slice(addr.lastIndexOf('@') + 1);
  return domain === OWN_DOMAIN || domain.endsWith(`.${OWN_DOMAIN}`);
}

function decodeSnippet(s: string): string {
  return s
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function classify(m: GmailThreadMessage): Msg | null {
  const labels = m.labelIds || [];
  if (labels.includes('DRAFT') || !m.internalDate) return null;
  const header = (name: string): string | null =>
    m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;

  const base = {
    at: Number(m.internalDate),
    subject: header('Subject') || '(no subject)',
    snippet: decodeSnippet(m.snippet || ''),
  };
  const from = addresses(header('From'))[0] ?? null;
  const replyTo = addresses(header('Reply-To'))[0] ?? null;

  // Sent from info@ in Gmail → ours, if it went to someone outside.
  if (labels.includes('SENT')) {
    const sentTo = addresses(header('To'), header('Cc')).filter((a) => !isOwn(a));
    if (sentTo.length === 0) return { ...base, kind: 'ignore', clientAddr: null, sentTo: [], fromWebsiteForm: false };
    return { ...base, kind: 'ours', clientAddr: null, sentTo, fromWebsiteForm: false };
  }

  const ignore: Msg = { ...base, kind: 'ignore', clientAddr: null, sentTo: [], fromWebsiteForm: false };
  if (!from) return ignore;

  // Website enquiry form: From info@, the client in Reply-To.
  if (from === WEBSITE_FORM_SENDER && replyTo && !isOwn(replyTo)) {
    return { ...base, kind: 'client', clientAddr: replyTo, sentTo: [], fromWebsiteForm: true };
  }
  if (isOwn(from)) return ignore; // our system mail, internal mail

  const autoSubmitted = (header('Auto-Submitted') || '').toLowerCase().trim();
  const precedence = (header('Precedence') || '').toLowerCase().trim();
  const automated =
    (autoSubmitted !== '' && autoSubmitted !== 'no') ||
    ['bulk', 'list', 'junk'].includes(precedence) ||
    header('List-Unsubscribe') != null ||
    header('List-Id') != null ||
    MACHINE_SENDER.test(from.slice(0, from.indexOf('@')));
  if (automated) return ignore;

  const clientAddr = replyTo && !isOwn(replyTo) ? replyTo : from;
  return { ...base, kind: 'client', clientAddr, sentTo: [], fromWebsiteForm: false };
}

// ── Waits ──────────────────────────────────────────────────────────────────

interface Wait {
  threadId: string;
  startAt: number;
  clientAddrs: Set<string>;
  clientMsgTimes: number[];
  fromWebsiteForm: boolean;
  subject: string;
  snippet: string;
  /** Our reply in the same conversation, if any. */
  inThreadReplyAt: number | null;
}

/** Walk one conversation in time order and cut it into client waits. */
function waitsInThread(threadId: string, msgs: Msg[]): Wait[] {
  const out: Wait[] = [];
  let open: Wait | null = null;
  for (const m of msgs) {
    if (m.kind === 'client' && m.clientAddr) {
      if (!open) {
        open = {
          threadId, startAt: m.at, clientAddrs: new Set([m.clientAddr]), clientMsgTimes: [m.at],
          fromWebsiteForm: m.fromWebsiteForm, subject: m.subject, snippet: m.snippet, inThreadReplyAt: null,
        };
        out.push(open);
      } else {
        open.clientAddrs.add(m.clientAddr);
        open.clientMsgTimes.push(m.at);
      }
    } else if (m.kind === 'ours' && open) {
      // Only an email TO the client answers them — a forward to a supplier doesn't.
      if (m.sentTo.some((a) => open!.clientAddrs.has(a))) {
        open.inThreadReplyAt = m.at;
        open = null;
      }
    }
  }
  return out;
}

/** First time after `afterMs` we emailed any of `addrs`, from any conversation. */
function firstSentAfter(sentIndex: Map<string, number[]>, addrs: Set<string>, afterMs: number): number | null {
  let best: number | null = null;
  for (const a of addrs) {
    for (const t of sentIndex.get(a) || []) {
      if (t > afterMs) {
        if (best == null || t < best) best = t;
        break; // lists are sorted
      }
    }
  }
  return best;
}

interface Row {
  wait: Wait;
  from: string;
  replyAt: number | null;
  replyHow: 'same conversation' | 'separate email' | '';
  arrivedOpen: boolean;
  clockMins: number | null;
  workMins: number | null;
  sameDay: boolean | null;
  beforeOpening: boolean | null;
  chased: boolean;
  weekday: string;
  hour: number;
}

// ── Stats helpers ──────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function fmtMins(mins: number | null): string {
  if (mins == null) return '-';
  const total = Math.round(mins);
  if (total < 1) return '<1m';
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function pct(n: number, of: number): string {
  return of ? `${Math.round((100 * n) / of)}%` : '-';
}

function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => '  ' + cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('   ');
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

/** Count / answered / typical working wait / within 1h / same day / chased, for a group of rows. */
function groupCells(rows: Row[]): string[] {
  const answered = rows.filter((r) => r.replyAt != null);
  const work = answered.map((r) => r.workMins!).sort((a, b) => a - b);
  return [
    String(rows.length),
    pct(answered.length, rows.length),
    fmtMins(percentile(work, 50)),
    fmtMins(percentile(work, 90)),
    pct(answered.filter((r) => r.workMins! <= 60).length, answered.length),
    pct(answered.filter((r) => r.sameDay).length, answered.length),
    pct(rows.filter((r) => r.chased).length, rows.length),
  ];
}
const GROUP_HEADER = ['answered', 'typical wait', '1 in 10 over', 'within 1h', 'same day', 'client chased'];

function csvCell(v: string | number | null): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`; // stop a spreadsheet treating it as a formula
  return `"${s.replace(/"/g, '""')}"`;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!isGmailConfigured()) {
    console.error('Gmail is not configured on this server (GMAIL_SERVICE_ACCOUNT_JSON / GMAIL_DELEGATED_USER).');
    process.exit(1);
  }
  const mailbox = getPrimaryMailbox();
  const hours: Hours = { open: parseHhMm(arg('open') || '09:00', 'open'), close: parseHhMm(arg('close') || '18:00', 'close') };
  if (hours.close <= hours.open) throw new Error('--close must be later than --open');

  const sinceArg = arg('since');
  let sinceMs: number;
  if (sinceArg) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sinceArg);
    if (!m) throw new Error(`--since must look like 2026-08-24 (got "${sinceArg}")`);
    sinceMs = londonToUtc(Number(m[1]), Number(m[2]), Number(m[3]), 0);
  } else {
    sinceMs = Date.now() - 70 * DAY_MS; // ten weeks
  }
  const judgeBefore = Date.now() - JUDGE_AFTER_HOURS * HOUR_MS;
  const csvPath = arg('csv') || '/tmp/email-response-times.csv';

  console.log(`Reading ${mailbox} since ${fmtWhen(sinceMs)} (read-only)…`);
  const threadIds = await listThreadIds(mailbox, sinceMs);
  console.log(`${threadIds.length} conversations to read.`);

  const threads: { id: string; msgs: Msg[] }[] = [];
  let next = 0;
  let done = 0;
  let messageCount = 0;
  async function worker() {
    while (next < threadIds.length) {
      const id = threadIds[next++];
      const t = await getThread(mailbox, id);
      const msgs = (t.messages || []).map(classify).filter((m): m is Msg => m != null).sort((a, b) => a.at - b.at);
      messageCount += msgs.length;
      threads.push({ id, msgs });
      if (++done % 250 === 0) console.log(`  …${done}/${threadIds.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // Everything we sent, by recipient — to spot a reply sent as a separate email.
  const sentIndex = new Map<string, number[]>();
  for (const t of threads) {
    for (const m of t.msgs) {
      if (m.kind !== 'ours') continue;
      for (const a of m.sentTo) {
        const list = sentIndex.get(a) || [];
        list.push(m.at);
        sentIndex.set(a, list);
      }
    }
  }
  for (const list of sentIndex.values()) list.sort((a, b) => a - b);

  const ignoredCount = threads.reduce((n, t) => n + t.msgs.filter((m) => m.kind === 'ignore').length, 0);

  const rows: Row[] = [];
  for (const t of threads) {
    for (const w of waitsInThread(t.id, t.msgs)) {
      if (w.startAt < sinceMs || w.startAt > judgeBefore) continue;
      const separate = firstSentAfter(sentIndex, w.clientAddrs, w.startAt);
      let replyAt = w.inThreadReplyAt;
      let replyHow: Row['replyHow'] = replyAt != null ? 'same conversation' : '';
      if (separate != null && (replyAt == null || separate < replyAt)) {
        replyAt = separate;
        replyHow = 'separate email';
      }
      const p = londonParts(w.startAt);
      const arrivedOpen = isOpenAt(w.startAt, hours);
      rows.push({
        wait: w,
        from: [...w.clientAddrs][0],
        replyAt,
        replyHow,
        arrivedOpen,
        clockMins: replyAt != null ? (replyAt - w.startAt) / MIN_MS : null,
        workMins: replyAt != null ? openMinutesBetween(w.startAt, replyAt, hours) : null,
        sameDay: replyAt != null ? replyAt <= sameDayDeadline(w.startAt, hours) : null,
        beforeOpening: replyAt != null && !arrivedOpen ? replyAt < nextOpeningAt(w.startAt, hours) : null,
        // The client emailed again before we replied (or before now, if we never did).
        chased: w.clientMsgTimes.filter((at) => at < (replyAt ?? Infinity)).length > 1,
        weekday: p.weekday,
        hour: p.hh,
      });
    }
  }
  rows.sort((a, b) => a.wait.startAt - b.wait.startAt);

  // ── Report ───────────────────────────────────────────────────────────────
  const out: string[] = [];
  const say = (s = '') => out.push(s);
  const answered = rows.filter((r) => r.replyAt != null);
  const unanswered = rows.filter((r) => r.replyAt == null);
  const work = answered.map((r) => r.workMins!).sort((a, b) => a - b);
  const clock = answered.map((r) => r.clockMins!).sort((a, b) => a - b);
  const daytime = rows.filter((r) => r.arrivedOpen);
  const overnight = rows.filter((r) => !r.arrivedOpen);
  const nights = Math.max(1, Math.round((judgeBefore - sinceMs) / DAY_MS));

  say('='.repeat(78));
  say(`EMAIL RESPONSE TIMES: ${mailbox}`);
  say('='.repeat(78));
  say(`Period: ${fmtWhen(sinceMs)} to ${fmtWhen(judgeBefore)} (the last ${JUDGE_AFTER_HOURS}h left out: too soon to judge)`);
  say(`Open hours counted: ${fmtHhMm(hours.open)}-${fmtHhMm(hours.close)}, every day, UK time.`);
  say('"Wait" below = WORKING time (inside open hours) from the client\'s email to our reply,');
  say('unless it says "clock". An email at 02:00 answered at 09:30 is a 30-minute wait.');
  say();
  say('WHAT WAS READ');
  say(`  Conversations: ${threadIds.length}   Messages: ${messageCount}   Ignored (automated / newsletters / our own system or internal mail): ${ignoredCount}`);
  say(`  Client emails waiting for a reply: ${rows.length}  (several client emails before we answer count once)`);
  say(`    of which website enquiry form: ${rows.filter((r) => r.wait.fromWebsiteForm).length}`);
  say();
  say('1. OVERALL');
  say(`  Answered: ${answered.length} (${pct(answered.length, rows.length)})   Not answered from info@: ${unanswered.length} (${pct(unanswered.length, rows.length)})`);
  say(`    answered as a separate email (not in the same conversation): ${answered.filter((r) => r.replyHow === 'separate email').length}`);
  say(`  Wait, of those answered:  typical (median) ${fmtMins(percentile(work, 50))}   1 in 4 over ${fmtMins(percentile(work, 75))}   1 in 10 over ${fmtMins(percentile(work, 90))}`);
  say(`  Clock time, same emails:  typical ${fmtMins(percentile(clock, 50))}   1 in 4 over ${fmtMins(percentile(clock, 75))}   1 in 10 over ${fmtMins(percentile(clock, 90))}`);
  say(`  Answered within 1h: ${pct(work.filter((m) => m <= 60).length, answered.length)}   2h: ${pct(work.filter((m) => m <= 120).length, answered.length)}   4h: ${pct(work.filter((m) => m <= 240).length, answered.length)}   same working day: ${pct(answered.filter((r) => r.sameDay).length, answered.length)}`);
  say(`  Client emailed again before we replied: ${rows.filter((r) => r.chased).length} (${pct(rows.filter((r) => r.chased).length, rows.length)})`);
  say();
  say('2. ARRIVED WHILE OPEN vs WHILE CLOSED');
  say(table(['arrived', 'emails', ...GROUP_HEADER], [
    ['while open', ...groupCells(daytime)],
    ['while closed', ...groupCells(overnight)],
    ['website form', ...groupCells(rows.filter((r) => r.wait.fromWebsiteForm))],
  ]));
  say();
  say('3. EMAILS THAT ARRIVED WHILE CLOSED');
  const oAnswered = overnight.filter((r) => r.replyAt != null);
  const oClock = oAnswered.map((r) => r.clockMins!).sort((a, b) => a - b);
  say(`  Arrived while closed: ${overnight.length} (${pct(overnight.length, rows.length)} of all, about ${(overnight.length / nights).toFixed(1)} a night)`);
  say(`  Answered before we opened (someone replied out of hours): ${oAnswered.filter((r) => r.beforeOpening).length}`);
  say(`  Answered within 1h of opening (incl. before): ${oAnswered.filter((r) => r.workMins! <= 60).length} (${pct(oAnswered.filter((r) => r.workMins! <= 60).length, overnight.length)})`);
  say(`  Answered 1-2h after opening: ${oAnswered.filter((r) => r.workMins! > 60 && r.workMins! <= 120).length}`);
  say(`  Answered more than 2h after opening: ${oAnswered.filter((r) => r.workMins! > 120).length}`);
  say(`  Not answered from info@: ${overnight.length - oAnswered.length}`);
  say(`  Clock time the client actually waited: typical ${fmtMins(percentile(oClock, 50))}, 1 in 10 over ${fmtMins(percentile(oClock, 90))}`);
  say(`  Client emailed again before we replied: closed ${pct(overnight.filter((r) => r.chased).length, overnight.length)} vs open ${pct(daytime.filter((r) => r.chased).length, daytime.length)}`);
  say();
  say('4. BY HOUR THE EMAIL ARRIVED (UK time)');
  const hourRows: string[][] = [];
  for (let h = 0; h < 24; h++) {
    const g = rows.filter((r) => r.hour === h);
    if (g.length) hourRows.push([`${String(h).padStart(2, '0')}:00`, ...groupCells(g)]);
  }
  say(table(['hour', 'emails', ...GROUP_HEADER], hourRows));
  say();
  say('5. BY DAY OF THE WEEK');
  say(table(['day', 'emails', ...GROUP_HEADER],
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => [d, ...groupCells(rows.filter((r) => r.weekday === d))])));
  say();
  say('6. DO SLOWER REPLIES MAKE CLIENTS CHASE?');
  const buckets: [string, (m: number) => boolean][] = [
    ['up to 1h', (m) => m <= 60],
    ['1h-4h', (m) => m > 60 && m <= 240],
    ['4h-1 working day', (m) => m > 240 && m <= hours.close - hours.open],
    ['over 1 working day', (m) => m > hours.close - hours.open],
  ];
  say(table(['wait', 'emails', 'client chased'], buckets.map(([label, test]) => {
    const g = answered.filter((r) => test(r.workMins!));
    return [label, String(g.length), pct(g.filter((r) => r.chased).length, g.length)];
  })));
  say();
  say('7. NOT ANSWERED FROM info@: WHO THEY WERE FROM (top 15 domains)');
  say('  Many will not have needed a reply (invoices, suppliers, a closing "thanks!"),');
  say('  or were answered by phone or from someone\'s own address. Skim the CSV.');
  const domains = new Map<string, number>();
  for (const r of unanswered) {
    const d = r.from.slice(r.from.lastIndexOf('@') + 1);
    domains.set(d, (domains.get(d) || 0) + 1);
  }
  say(table(['domain', 'emails'], [...domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([d, n]) => [d, String(n)])));
  say();
  say('8. THE 15 LONGEST WAITS THAT WERE ANSWERED');
  say(table(['arrived', 'wait', 'clock', 'from', 'subject'],
    [...answered].sort((a, b) => b.workMins! - a.workMins!).slice(0, 15).map((r) => [
      fmtWhen(r.wait.startAt), fmtMins(r.workMins), fmtMins(r.clockMins), r.from, r.wait.subject.slice(0, 50),
    ])));
  say();

  // ── CSV, one row per client wait ─────────────────────────────────────────
  const header = ['arrived (UK)', 'day', 'hour', 'arrived while', 'from', 'website form', 'subject', 'snippet',
    'client emails before reply', 'replied (UK)', 'replied how', 'wait (working mins)', 'wait (clock mins)',
    'same working day', 'gmail link'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push([
      fmtWhen(r.wait.startAt), r.weekday, r.hour, r.arrivedOpen ? 'open' : 'closed', r.from,
      r.wait.fromWebsiteForm ? 'yes' : '', r.wait.subject, r.wait.snippet.slice(0, 200),
      r.wait.clientMsgTimes.filter((at) => at < (r.replyAt ?? Infinity)).length,
      r.replyAt != null ? fmtWhen(r.replyAt) : 'not answered', r.replyHow,
      r.workMins != null ? Math.round(r.workMins) : '', r.clockMins != null ? Math.round(r.clockMins) : '',
      r.sameDay == null ? '' : r.sameDay ? 'yes' : 'no',
      `https://mail.google.com/mail/u/?authuser=${mailbox}#all/${r.wait.threadId}`,
    ].map(csvCell).join(','));
  }
  writeFileSync(csvPath, lines.join('\n') + '\n', { mode: 0o600 });

  say(`CSV, one row per client email: ${csvPath}`);
  console.log(out.join('\n'));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
