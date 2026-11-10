/**
 * Inbox Ledger
 * ------------
 * Keeps a running record of who emails you, how often, and whether they
 * actually stop after you unsubscribe. Runs inside your own Google account
 * (Google Apps Script) and writes everything to a private Google Sheet.
 *
 * This script only READS your email. It never sends, deletes, or moves mail.
 * The only thing it creates in Gmail is a label named "Unsubscribed".
 *
 * How to use:
 *   1. Run `setup` once. It creates the Google Sheet, the "Unsubscribed"
 *      label, and a nightly timer, then does the first scan.
 *   2. When you unsubscribe from a sender, add the "Unsubscribed" label to
 *      one of their emails (or type a date in the sheet's "Unsubscribed on"
 *      column). The next run records it.
 *   3. Check the "Senders" tab whenever you like.
 */

const CONFIG = {
  SPREADSHEET_NAME: 'Inbox Ledger',
  BACKFILL_DAYS: 90,          // how far back the first scan looks
  WINDOW_HOURS: 24,           // scan this many hours of mail at a time
  UNSUBSCRIBED_LABEL: 'Unsubscribed',
  GRACE_DAYS: 10,             // US law gives senders 10 business days to stop
  MAX_RUNTIME_MS: 4.5 * 60 * 1000, // Apps Script stops scripts at 6 minutes
  NIGHTLY_HOUR: 2,            // nightly run around 2 AM (your time zone)
  SEARCH_SCOPE: 'in:anywhere', // include Spam and Trash
};

const EMAILS_SHEET = 'Emails';
const SENDERS_SHEET = 'Senders';
const EMAIL_HEADERS = ['Date', 'From name', 'From email', 'Subject', 'Message ID'];
const SENDER_HEADERS = [
  'From name', 'From email', 'Domain', 'Total emails', 'First email', 'Last email',
  'Unsubscribed on', 'Emails since unsubscribing', 'Emails after grace period', 'Status',
];
const COL = { EMAIL: 1, UNSUB: 6 }; // zero-based positions in SENDER_HEADERS
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Functions you run yourself
// ---------------------------------------------------------------------------

/** Run once. Creates the sheet, label and nightly timer, then scans. */
function setup() {
  const ss = getOrCreateSpreadsheet_();
  ensureSheet_(ss, EMAILS_SHEET, EMAIL_HEADERS);
  ensureSheet_(ss, SENDERS_SHEET, SENDER_HEADERS);
  getOrCreateLabel_();
  installNightlyTrigger_();
  Logger.log('Inbox Ledger sheet: ' + ss.getUrl());
  run();
}

/** Prints the link to your sheet in the log. */
function showLink() {
  Logger.log(getOrCreateSpreadsheet_().getUrl());
}

/** The main job. The nightly timer calls this; you can also run it by hand. */
function run() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) return; // another run is already going
  try {
    const started = Date.now();
    const props = PropertiesService.getScriptProperties();
    const ss = getOrCreateSpreadsheet_();
    const emailsSheet = ensureSheet_(ss, EMAILS_SHEET, EMAIL_HEADERS);
    const sendersSheet = ensureSheet_(ss, SENDERS_SHEET, SENDER_HEADERS);

    const me = myAddresses_();
    const seen = readSeenIds_(emailsSheet);
    const now = Date.now();
    let cursor = Number(props.getProperty('cursorMs')) || now - CONFIG.BACKFILL_DAYS * DAY_MS;

    // 1. Log new emails, one time window at a time, saving progress as we go.
    while (cursor < now && Date.now() - started < CONFIG.MAX_RUNTIME_MS) {
      const end = Math.min(cursor + CONFIG.WINDOW_HOURS * 60 * 60 * 1000, now);
      const rows = fetchWindow_(cursor, end, seen, me);
      if (rows.length) {
        emailsSheet
          .getRange(emailsSheet.getLastRow() + 1, 1, rows.length, EMAIL_HEADERS.length)
          .setValues(rows);
      }
      cursor = end;
      props.setProperty('cursorMs', String(cursor));
    }

    // 2. Work out unsubscribe dates (sheet entries + "Unsubscribed" label).
    const unsub = readUnsubDates_(sendersSheet);
    applyUnsubscribeLabel_(unsub, me);

    // 3. Rebuild the Senders summary from the full email log.
    rebuildSenders_(emailsSheet, sendersSheet, unsub);

    // 4. If the first big scan isn't finished, keep going in a minute.
    if (cursor < now) scheduleContinuation_();
  } finally {
    lock.releaseLock();
  }
}

/** Called by a one-time timer to continue a long first scan. */
function continueBackfill() {
  deleteTriggers_('continueBackfill');
  run();
}

// ---------------------------------------------------------------------------
// Reading Gmail
// ---------------------------------------------------------------------------

/** Returns sheet rows for every email received between startMs and endMs. */
function fetchWindow_(startMs, endMs, seen, me) {
  const query = CONFIG.SEARCH_SCOPE +
    ' after:' + Math.floor(startMs / 1000) +
    ' before:' + Math.ceil(endMs / 1000);
  const rows = [];
  const pageSize = 100;
  for (let offset = 0; ; offset += pageSize) {
    const threads = GmailApp.search(query, offset, pageSize);
    threads.forEach(function (thread) {
      thread.getMessages().forEach(function (msg) {
        const t = msg.getDate().getTime();
        if (t < startMs || t >= endMs) return;
        const id = msg.getId();
        if (seen.has(id)) return;
        const from = parseFrom_(msg.getFrom());
        if (!from.email || me.has(from.email)) return; // skip mail you sent
        seen.add(id);
        rows.push([msg.getDate(), from.name, from.email, msg.getSubject(), id]);
      });
    });
    if (threads.length < pageSize) break;
  }
  return rows;
}

/** Splits 'Name <name@example.com>' into its parts. */
function parseFrom_(raw) {
  const m = String(raw).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  return { name: '', email: String(raw).trim().toLowerCase() };
}

/** Your own addresses, so emails you sent aren't counted. */
function myAddresses_() {
  const list = [Session.getEffectiveUser().getEmail()].concat(GmailApp.getAliases());
  return new Set(list.map(function (a) { return String(a).toLowerCase(); }));
}

/** Records today's date for senders whose emails carry the "Unsubscribed" label. */
function applyUnsubscribeLabel_(unsub, me) {
  const label = getOrCreateLabel_();
  const today = startOfDay_(new Date());
  for (let offset = 0; ; offset += 100) {
    const threads = label.getThreads(offset, 100);
    threads.forEach(function (thread) {
      thread.getMessages().forEach(function (msg) {
        const email = parseFrom_(msg.getFrom()).email;
        if (email && !me.has(email) && !unsub.has(email)) unsub.set(email, today);
      });
    });
    if (threads.length < 100) break;
  }
}

// ---------------------------------------------------------------------------
// Writing the sheet
// ---------------------------------------------------------------------------

/** Rebuilds the Senders tab: one row per sender, most frequent first. */
function rebuildSenders_(emailsSheet, sendersSheet, unsub) {
  const stats = new Map();
  const last = emailsSheet.getLastRow();
  if (last > 1) {
    emailsSheet.getRange(2, 1, last - 1, 3).getValues().forEach(function (r) {
      const date = r[0] instanceof Date ? r[0] : new Date(r[0]);
      const email = String(r[2]).toLowerCase();
      if (!email) return;
      let s = stats.get(email);
      if (!s) { s = { name: r[1], total: 0, first: date, last: date, dates: [] }; stats.set(email, s); }
      s.total++;
      s.dates.push(date);
      if (date < s.first) s.first = date;
      if (date >= s.last) { s.last = date; if (r[1]) s.name = r[1]; }
    });
  }
  // Keep senders you marked as unsubscribed even if none of their mail is logged yet.
  unsub.forEach(function (_, email) {
    if (!stats.has(email)) stats.set(email, { name: '', total: 0, first: '', last: '', dates: [] });
  });

  const rows = [];
  stats.forEach(function (s, email) {
    const unsubDate = unsub.get(email) || '';
    let since = '', afterGrace = '', status = 'Subscribed';
    if (unsubDate) {
      const sinceCut = unsubDate.getTime() + DAY_MS;              // after the unsubscribe day
      const graceCut = unsubDate.getTime() + CONFIG.GRACE_DAYS * DAY_MS;
      since = s.dates.filter(function (d) { return d.getTime() >= sinceCut; }).length;
      afterGrace = s.dates.filter(function (d) { return d.getTime() >= graceCut; }).length;
      status = afterGrace > 0 ? 'STILL EMAILING' : since > 0 ? 'Slowing down (in grace period)' : 'Stopped';
    }
    rows.push([s.name, email, email.split('@')[1] || '', s.total, s.first, s.last,
      unsubDate, since, afterGrace, status]);
  });
  rows.sort(function (a, b) { return b[3] - a[3]; });

  const oldRows = sendersSheet.getLastRow() - 1;
  if (oldRows > 0) sendersSheet.getRange(2, 1, oldRows, SENDER_HEADERS.length).clearContent();
  if (rows.length) {
    sendersSheet.getRange(2, 1, rows.length, SENDER_HEADERS.length).setValues(rows);
    sendersSheet.getRange(2, 5, rows.length, 3).setNumberFormat('yyyy-mm-dd');
  }
}

/** Reads the 'Unsubscribed on' dates already in the Senders tab. */
function readUnsubDates_(sendersSheet) {
  const map = new Map();
  const last = sendersSheet.getLastRow();
  if (last < 2) return map;
  sendersSheet.getRange(2, 1, last - 1, SENDER_HEADERS.length).getValues().forEach(function (r) {
    const email = String(r[COL.EMAIL]).trim().toLowerCase();
    const v = r[COL.UNSUB];
    if (!email || v === '' || v === null) return;
    const d = v instanceof Date ? v : new Date(v);
    if (!isNaN(d)) map.set(email, startOfDay_(d));
  });
  return map;
}

/** Message IDs already logged, so nothing is counted twice. */
function readSeenIds_(emailsSheet) {
  const last = emailsSheet.getLastRow();
  if (last < 2) return new Set();
  const ids = emailsSheet.getRange(2, 5, last - 1, 1).getValues();
  return new Set(ids.map(function (r) { return String(r[0]); }));
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

function getOrCreateSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('spreadsheetId');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) { /* deleted; make a new one */ }
  }
  const ss = SpreadsheetApp.create(CONFIG.SPREADSHEET_NAME);
  props.setProperty('spreadsheetId', ss.getId());
  return ss;
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    const blank = ss.getSheetByName('Sheet1');
    if (blank && ss.getSheets().length > 1) ss.deleteSheet(blank);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    if (name === EMAILS_SHEET) {
      sheet.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm');
      sheet.getRange('E:E').setNumberFormat('@'); // keep message IDs as text
    }
  }
  return sheet;
}

function getOrCreateLabel_() {
  return GmailApp.getUserLabelByName(CONFIG.UNSUBSCRIBED_LABEL) ||
    GmailApp.createLabel(CONFIG.UNSUBSCRIBED_LABEL);
}

function installNightlyTrigger_() {
  deleteTriggers_('run');
  ScriptApp.newTrigger('run').timeBased().everyDays(1).atHour(CONFIG.NIGHTLY_HOUR).create();
}

function scheduleContinuation_() {
  deleteTriggers_('continueBackfill');
  ScriptApp.newTrigger('continueBackfill').timeBased().after(60 * 1000).create();
}

function deleteTriggers_(handler) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
  });
}

function startOfDay_(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
