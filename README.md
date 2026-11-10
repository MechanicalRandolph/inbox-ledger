# Inbox Ledger

A small Google Apps Script that keeps a running record of **who emails you, how often, and whether they actually stop after you unsubscribe**.

It runs every night inside your own Google account and writes to a private Google Sheet. No server, no cost, and your email never leaves Google.

## What you get

A Google Sheet with two tabs:

**Senders**: one row per sender, most frequent first

| From email | Total emails | First email | Last email | Unsubscribed on | Emails since unsubscribing | Emails after grace period | Status |
|---|---|---|---|---|---|---|---|
| hello@example.com | 9 | 2026-10-28 | 2026-11-09 | 2026-11-10 | 0 | 0 | Stopped |

**Emails**: every email received, with date, sender and subject

### Status meanings

| Status | Meaning |
|---|---|
| Subscribed | You haven't unsubscribed from this sender |
| Stopped | No email since the day you unsubscribed |
| Slowing down (in grace period) | They've emailed since, but are still inside the 10-day window US law allows |
| **STILL EMAILING** | They're ignoring your unsubscribe. Mark them as spam. |

## Safety

- **Read-only:** the script never sends, deletes or moves email. The only thing it creates in Gmail is a label called `Unsubscribed`.
- **Your data stays private:** emails are logged only to your own Google Sheet. Nothing about your inbox is stored in this repository.

## Setup (about 10 minutes)

1. Go to [script.google.com](https://script.google.com) and click **New project**.
2. Rename it **Inbox Ledger** (top left).
3. Delete everything in `Code.gs` and paste in this repo's [`Code.gs`](Code.gs).
4. Click the gear icon (**Project Settings**), turn on **Show "appsscript.json" manifest file**, then replace its contents with this repo's [`appsscript.json`](appsscript.json). Change `timeZone` if you're not in Mountain Time.
5. Back in the editor, pick **`setup`** from the function dropdown and click **Run**.
6. Google asks for permission. Click **Review permissions**, choose your account, then **Advanced → Go to Inbox Ledger (unsafe) → Allow**. ("Unsafe" only means Google hasn't reviewed your personal script.)
7. When it finishes, open **View → Logs** (or the Execution log) and click the link to your new sheet.

The first scan covers the last 90 days. If that takes longer than Google's 6-minute limit, it automatically continues every minute until done.

## Recording an unsubscribe

Do either of these:

- **In Gmail:** add the `Unsubscribed` label to any email from that sender. The next run records today's date.
- **In the sheet:** type a date in the sender's **Unsubscribed on** column.

## Settings

Change these at the top of `Code.gs`:

| Setting | Default | What it does |
|---|---|---|
| `BACKFILL_DAYS` | 90 | How far back the first scan looks |
| `GRACE_DAYS` | 10 | Days a sender gets to stop before being flagged |
| `NIGHTLY_HOUR` | 2 | Hour the nightly run happens |
| `SEARCH_SCOPE` | `in:anywhere` | Which mail to count (includes Spam and Trash) |

## Optional: deploy from your computer with clasp

[clasp](https://github.com/google/clasp) lets you push code from this folder straight to Apps Script:

```bash
npm install -g @google/clasp
clasp login
clasp create --type standalone --title "Inbox Ledger"
clasp push
```
