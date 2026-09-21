# Syncing entries to Google Sheets

Every night at 10pm, a script pulls the entries from the app (the `/api/export/entries` endpoint) and rebuilds three sheets.

The script keeps the sheets in this order, re-sorting them on every update:

| Order | Sheet | Contents |
|---|---|---|
| 1 | **總覽** (Overview) | Monthly and yearly spending and savings, three headline numbers, and a monthly spending bar chart |
| 2 | **帳目** (Entries) | Every entry, one per row |
| 3 | **省下** (Saved) | Only entries with a reference price, with the running savings total at the top |

The sheet and column names stay in Chinese because they match the app.

Column widths are calculated by the script from the content (CJK characters count as double width) instead of using Google's built-in auto-resize, which estimates by character count and cuts "省錢項目" down to "省錢". The date column is frozen on the left, so the day stays visible when scrolling right.

**One-way sync.** The spreadsheet mirrors the app, but edits made in the spreadsheet are not written back. Treat it as an always-current copy for analysis; the app remains the source of truth.

## Why a separate token

The script uses `EXPORT_TOKEN`, not the login password. It can only read entries: it can't log in or change anything. If it leaks, the damage is limited to someone seeing the entries, and it can be rotated on its own without signing the phone out.

## Setup

### 1. Create and set the token (in Cloudflare)

Pick a long random string (32+ characters; a password manager is the easiest way to generate one).

In the Cloudflare dashboard → Workers & Pages → travel-money → Settings → Variables and Secrets → Add, with **Type set to Secret**:

- Variable name: `EXPORT_TOKEN`
- Secret: the string you just generated

**After saving, click Deploy on the same page.** Workers separates versions from deployments: Save alone creates a new version that isn't live, so the code can't see the secret.

### 2. Create the spreadsheet and script

1. Create a new Google spreadsheet
2. In the menu, **Extensions → Apps Script**
3. Paste the whole of `Code.gs`, replacing the empty function
4. At the top, set `API_URL` to your own domain and `TOKEN` to the string from step 1
5. Save (the disk icon)

### 3. Set the time zone

Apps Script's "10pm" follows the project time zone, not where you are.

In Apps Script, **Project Settings (gear icon)** on the left → Time zone → pick one (for example `Europe/London` or `Asia/Taipei`). Remember to change it when you move.

### 4. Run once and authorize

In the function dropdown at the top of Apps Script, pick `updateEntries` → **Run**.

The first run asks for authorization: choose your Google account → "Advanced" → "Go to (unsafe)" → Allow. This appears because the script is your own and hasn't been reviewed by Google, not because anything is wrong.

When it finishes, all three sheets should have data.

### 5. Turn on the daily update

In the function dropdown, pick `installDailyTrigger` → Run.

This only needs to run once. From then on the sheets update every night at 10pm (within that hour).

To check it's set: the **clock icon (Triggers)** on the left of Apps Script should show one daily trigger for `updateEntries`.

## Day to day

After reloading the spreadsheet, a "**旅行記帳**" (Travel Money) menu appears at the top:

- **立即更新** (Update now): pull once by hand instead of waiting for 10pm
- **設定每天自動更新** (Set up daily update): recreates the trigger

## Columns

日期 (date), 類型 (type), 金額 (amount), 幣別 (currency), 匯率 (rate), 台幣 (TWD), 原價 (reference price), 省下 (saved), 省下台幣 (saved in TWD), 省錢項目 (how I saved), 分類 (category), 付款方式 (payment method), 國家 (country), 旅程 (trip), 備註 (note), 行前已付 (paid before the trip), 可退稅 (tax refundable), 誰先付 (who paid)

Money columns are rounded to sensible decimal places. **The exchange rate is deliberately kept at full precision**: it is the value frozen when the entry was logged, and rounding it would make the TWD amounts impossible to recompute.

## Two calculation rules

**Exchanging currency is not spending.** Turning TWD into GBP leaves the money yours, just in another currency. So the monthly and yearly figures on 總覽 only count rows where `類型 = 支出` (type = expense).

**Savings are never subtracted from spending.** Something bought at a discounted £30 still cost £30. The two numbers are shown separately; "might have spent" is spending plus savings, never spending minus savings.

## Adding your own analysis

Don't add columns next to these three sheets; every update clears them (charts included: the script removes old charts before redrawing, otherwise they would pile up).

Create a separate sheet that references them with formulas, for example:

```
=QUERY(帳目!A:R, "select K, sum(F) where B='支出' group by K order by sum(F) desc", 1)
```

Your analysis then survives every update.
