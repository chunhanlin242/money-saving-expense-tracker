# travel-money

A multi-currency travel expense PWA running on Cloudflare Workers + D1, deployed on a personal domain.

The user will be moving around the UK and Europe for long stretches. This is a travel ledger kept **completely separate from their day-to-day budget in Taiwan**.
For the full product picture and phase status, see [README.md](README.md).

> This file is the standing brief I give AI coding agents working on this repo. The original is in Chinese; this is an English translation.

---

## Decisions already made: don't ask again, don't revert

These were confirmed with the user, not defaults picked on a whim:

| Decision | Reason |
|---|---|
| **Zero dependencies, vanilla JS** | No front-end frameworks or third-party libraries (including chart libraries and SheetJS). The PWA has to open instantly offline; every KB counts. |
| **Minimal black and white + tangerine `#E8590C`** | White text on an orange background uses `--accent-ink: #CC4D0A` instead, because `#E8590C` with white text has a contrast ratio of only 3.58 and fails WCAG AA. |
| **Light first, dark follows the system** | Both sets of CSS variables must be maintained. |
| **Bill splitting is single-user "I fronted it" tracking only** | Companions don't need accounts; no shared multi-user ledger. |
| **Exchange rates are fetched automatically; no manual override UI** | The user chose this explicitly. The schema has a `rate_to_twd` column so it's technically possible, but don't add an override screen unprompted. |

## Architecture that must not be broken

**Frozen exchange rates.** Every `entries` row stores the `rate_to_twd` and `amount_twd` at the moment it was logged.
Don't change this to "recalculate with the current rate when displaying". That would turn "how much has this trip cost in TWD" into a number that changes every day and can never be reconciled.
When editing: a new amount keeps the original frozen rate; only a new currency uses `fx.rateOn(date, code)` to fetch the rate **for that entry's date**.

**IndexedDB is the single source of truth.** The UI only reads and writes locally and never waits for the network. Sync happens in the background.
Don't change it to "update the screen once the API call succeeds". The user often logs spending on the underground with no signal, or just after landing before roaming is on.

**Sync relies on `server_seq`, not timestamps.** The server issues monotonically increasing numbers; the client remembers its position and asks for everything after it.
`updated_at` is only used to resolve conflicts (rare with a single user). Wrong device clocks or time zones must never affect what gets pulled.

**No foreign keys.** During sync, child rows (splits) can arrive before their parents (entries), and foreign keys would reject them.
Integrity is handled in the application layer.

**All deletes are soft deletes.** Keep a row with `deleted_at` set, otherwise the deletion never reaches other devices.

**Dates are local dates.** `spent_date` stores the local `YYYY-MM-DD` (`fx.localDate()`), not UTC.
Dinner at 11pm in London shouldn't count as the next day. Likewise, rate freshness is judged by **actual age** (`fx.isFresh()`, within four days),
never by comparing a date string with today's local date: the server records dates in UTC, and the local date is often a day ahead.

**"Saved" never offsets spending.** `entries.reference_amount` is "what it would have cost";
saved = reference price − amount paid. This number must never be subtracted from spending or appear in any net figure.
A coat bought at a discounted £30 isn't "£20 saved", it's "£30 spent". If savings offset spending,
the app would stop helping you see your spending and start helping you justify it. The explanation of this on the stats page must stay.

**Exchanging currency is not spending.** Entries with `type: 'exchange'` are excluded from every spending figure (filter with `isExpense()`,
which only accepts `type === 'expense'`). Turning TWD into GBP leaves the money yours. The exchange spread is calculated separately for the user.

**Cash balances only count movements in the same currency.** A euro expense is not deducted from a sterling wallet; instead the app shows "N entries in other currencies not counted".
That situation almost always means the wrong wallet was picked while logging, and silently deducting it would let the balance drift without anyone noticing.

## What each page is for

| Page | Question it answers |
|---|---|
| Home | How much today? How much this trip? What did I just log? (**Deliberately only three blocks; don't pile more on top**) |
| Entries | Every entry, tap to edit |
| Stats | Where did the money go (category share, spending by country) |
| Accounts | How much do I have left (cash balances, card limit this month). Opened from 💳 in the home header or from Settings |
| Settings | Trips, payment methods, exchange rates, sync |

Logging is **three fast steps**: amount → category → save, all on one screen with no scrolling. Tapping a category saves immediately;
a long press opens the detail form. Don't break this flow to fit in more fields.

## Files

```
src/index.js        Worker: login, /api/sync, exchange-rate API, daily rate cron
schema.sql          D1 schema (10 tables; synced tables all have id/updated_at/deleted_at/server_seq)
public/app.js       Screens and interaction (one file, split into commented sections)
public/db.js        IndexedDB + sync queue
public/fx.js        Currency conversion, amount formatting, local dates
public/countries.js Country list
public/app.css      Styles (CSS variables at the top)
public/sw.js        Service worker
```

## Development

```bash
npm install
cp .dev.vars.example .dev.vars
npx wrangler d1 execute travel-money --local --file=./schema.sql
npm run dev
```

**If a change under public/ doesn't show up, suspect the service worker first.** It is cache-first (the price of instant offline launch),
so the browser serves the old version and only updates in the background; you need to open the app twice to see the new one. Clearing it is fastest when testing:

```js
for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
for (const k of await caches.keys()) await caches.delete(k);
location.reload();
```

When the list of files under `public/` changes, update the `SHELL` array in `sw.js` too, and bump `VERSION`
(bumping it triggers the in-app "new version available" prompt).

## What a cloud session (Claude Code on the phone) can and can't do

**Can**: change code, commit, open PRs.

**Can't** (don't try, and don't pretend it worked):

- `wrangler deploy`: the sandbox has no Cloudflare credentials. Deployment is handled by GitHub Actions on push to `main`
- `wrangler d1 execute --local/--remote`: same reason
- Verifying screens with browser tools: there is no dev server

So when changing things from the cloud, **say explicitly in the PR or commit message which parts were not actually run**,
and don't use the word "verified". Checking screens and numbers is left to an environment with a dev server.

## Standard of verification

Every change in this project is actually run before it's called "done". Methods used so far, and the problems they caught:

- Offline: **stop the dev server entirely**, then log an entry and reload the page; don't just check `navigator.onLine`
- Sync: write one entry from each of two sources, confirm two-way sync and that soft deletes propagate
- Frozen rates: manually change today's rate in `fx_rates`, confirm old entries' TWD amounts don't move and new entries use the new rate
- Layout: measure at 375×812 and 1280×800, check for horizontal overflow and tap targets ≥ 44px
- Money calculations: compare against hand-calculated expected values, not "looks about right"

Don't report something as done after only a static check.

## Language

The user speaks Chinese; reply in Traditional Chinese. Code comments are also in Traditional Chinese and explain "why", not "what".
