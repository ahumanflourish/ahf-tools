---
name: analyse
description: Compare a portfolio's history against passive reference strategies over the same period with the same cash flows. Use when someone wants to know how much of the available investment gain their strategy actually captured, or asks to analyse brokerage statements, portfolio returns, or investment performance against a benchmark.
allowed-tools: Read, Write, Bash
---

# Portfolio vs. Strategy — local analysis

You are turning someone's portfolio history into a dashboard that runs on their
machine. Their figures are sensitive. Two rules govern everything below.

**Their data never leaves this machine.** Do not send balances, contributions,
account numbers or statement contents to any network service. Do not fetch
benchmark data — it is bundled. If you cannot complete a step locally, stop and
say so rather than reaching for a network.

**You format; the dashboard computes.** Never calculate returns, XIRR or
benchmark comparisons yourself, and never estimate a number to fill a gap. Your
job ends at a validated CSV. The engine does the maths, and it has been checked
against a verified fixture.

## Run these steps in order, and stop at any gate that fails

Show the user each step as you complete it. A gate that fails halts the run —
a malformed input must never produce a plausible-looking dashboard.

### 1. Get the data

Ask what they have. Any of these work:

- A brokerage export (CSV) — the common case
- Statements (PDF) they can point you at on disk
- Numbers they will read out: year-end balances and what they put in each year

The minimum useful input is roughly eight numbers: a balance at the end of each
year, and the total contributed each year. Say that plainly — most people expect
this to require far more and give up before starting.

### 2. Produce the CSV

Three columns, one row per event:

    date,type,amount
    2021-10-12,contribution,10000
    2021-12-31,balance,16500.81
    2023-01-15,withdrawal,3000

- `date` — ISO `YYYY-MM-DD`.
- `type` — `contribution`, `withdrawal`, or `balance`.
- `amount` — a positive number for all three types. `balance` is what the
  account was worth on that date, not a change.

Traps that produced real errors in the source analysis:

- **Internal transfers are not contributions.** Money moving between the user's
  own accounts inflates contributions and destroys the result. If you see two
  flows of equal size and opposite sign within about a week, ask before
  including them.
- **Quarterly statements often show period totals, not balances.** Read the
  ending value, not the sum of the activity.
- **Do not invent dates.** If a statement gives only a month, use the month end
  and tell the user you did.

### 3. Gate: check it before computing

Confirm all of the following and show the user the summary:

- At least two `balance` rows. One starting and one ending value is the minimum;
  fewer cannot produce an answer.
- No balance dated before the first contribution, unless the user confirms it is
  an opening balance.
- Every date parses, every amount is a number, no negatives.
- The earliest date is on or after **2021-10**. Earlier histories are not yet
  supported — the monthly benchmark series does not reach back further. Say this
  plainly and offer to analyse the covered portion.

Then state the totals back: total contributed, total withdrawn, number of
balance observations, first and last date. Ask them to confirm before you
continue. If anything looks wrong, it is far cheaper to fix here.

### 4. Render the dashboard

Populate the bundled template with the validated CSV and write it to a file the
user chooses, defaulting to the current directory:

- Template: `${CLAUDE_PLUGIN_ROOT}/dashboard.html`
- The template carries a `<script id="portfolio-data" type="application/json">`
  element. Replace its contents with the parsed rows as JSON. Change nothing
  else in the file.

Tell them the path and that opening it needs no internet connection.

### 5. Say what the numbers do and do not mean

Whatever the result, state these — they are not boilerplate, they are the
difference between a useful tool and a misleading one:

- This is not investment advice.
- The answer depends on the reference strategy and the period chosen. A
  different one gives a different answer.
- A short history is a small sample.
- If they pay a fee, that fee may also buy tax work, planning, or the coaching
  that stopped them selling at the bottom. This measures none of that.
- If they **beat** the reference, say so first and plainly. A tool that always
  finds fault is not worth trusting.
