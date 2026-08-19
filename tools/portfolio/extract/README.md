# `tools/portfolio/extract` — the AI extraction layer

Path C of the input flow: the user hands Claude their statements, Claude reads
them, and the result lands in the review table. This package is that call and
nothing else — the schema Claude is constrained to, the prompt that carries the
judgement the schema cannot, and one function that sends both and classifies
what comes back.

There is no UI here. There is no maths here. The output of this package is
reviewed by a human before a single number reaches `analyse`.

```
src/schema.ts     the JSON Schema, its enums, and the result types
src/prompt.ts     the system prompt and the re-extraction wrapper
src/validate.ts   client-side validation, sign normalisation, the cross-check
src/stream.ts     the SSE decoder and the response reassembler
src/extract.ts    the one model call and its typed outcomes
src/types.ts      the types the rest of the flow reads
```

Zero runtime dependencies. No DOM beyond `fetch`, `AbortController` and
`TextDecoder` — no `FileReader`, no `Blob`, no `atob`. Callers hand in base64
they produced themselves, so the same module runs unchanged in a published
artifact, in the offline single-file build, and under Node.

```
npm test          209 tests, no network
npm run typecheck
```

---

## Measured fact vs. assumption

**Read this before changing anything in `extract.ts`.** The design is not a
reading of the API documentation; it is a reading of fourteen probes run from a
published claude.ai artifact against the proxy on 2026-08-19. Where the two
disagree, the probes win, because the proxy is what actually serves this code.

### Measured, 2026-08-19 — from a published artifact, not inferred

| Fact | Where it shows up here |
|---|---|
| The proxy **silently remaps the model**. Requesting `claude-sonnet-5` served `claude-sonnet-4-6` on HTTP 200 with no warning. | `DEFAULT_MODEL = 'claude-sonnet-4-6'`; `json.model` is read on every response — from `message_start` on a stream — and a mismatch is its own outcome. |
| **`output_config.format` shapes generation.** Paired A/B on a prose-inviting prompt, three trials each way: with the schema, bare JSON 3/3 and a marker key present 3/3; without it, bare JSON 0/3. | `output_config: { format: { type: 'json_schema', schema } }` is the only shaping mechanism sent. |
| **`output_config` and a base64 `document` work TOGETHER.** Probed as a pair, because feature pairs 400 in this API and the parts passing separately proves nothing about the combination. | This is the shipped request shape. |
| **Tools are stripped.** A forced `tool_choice` came back as a chatty markdown table. | No `tools`, no `tool_choice`. There is no fallback behind `output_config`. |
| **Assistant prefill is rejected** with a 400 ("does not support assistant message prefill"). | One `user` message, always. |
| **base64 `document` (PDF) and `image` blocks both pass.** | Attachments go straight in. No `pdf.js`, no client-side text extraction. INTERACTION.md's three-rung fallback ladder collapses to rung one. |
| **`thinking` is honoured**, and thinking blocks come back with signatures. | On by default at 8,000 tokens. See below. |
| **`stream: true` is honoured, and it is TRUE streaming** — 11 SSE events, first byte at 2591ms of a 3287ms call, not buffered-then-flushed. | On by default. `src/stream.ts`, and three separate timeout budgets. |
| **`system` is honoured, and is ADDITIVE** to the proxy's own ~4.2k system prompt rather than replacing it. | The extraction prompt goes in `system` and does not assume it is the only one there. |
| **All three of `thinking` + `document` + `output_config` at once work.** | The shipped shape, probed as a whole. |
| **The full production shape took 24.7 seconds on a trivial ONE-PAGE document.** | Latency is the binding constraint. `onProgress` exists because of this number. |
| **Logged out is not an HTTP status.** claude.ai intercepts with a modal; the request never reaches the API and the promise never settles — so no SSE event ever arrives either. | `DEFAULT_FIRST_EVENT_TIMEOUT_MS`. There is no 401 branch because there is no 401. |
| **~4,200 input tokens of proxy overhead per call**, billed to the viewer (`input_tokens: 4179` for "Reply with the single word: ok"). | One call, never a conversation, and **no retry loop**. |

### Assumption — believed, not probed

Each of these is a place where a future probe could change the design. None of
them is load-bearing for correctness, because `validate.ts` runs regardless.

- **That `output_config` is a hard grammar constraint rather than the schema
  being read as instruction.** This is the most important open question in the
  package, and the evidence points the other way. `claude-sonnet-4-6` — the
  model the proxy actually serves — is **not** on the documented
  structured-outputs support list, and probe batch 2 caught it returning
  `type: "transfer"` (outside a closed enum) and `amount: -450.00` (against the
  stated contract) in the same reply. Treat the reply as strongly-shaped free
  text that usually parses. That is precisely why every reply is validated
  client-side and why `schema-mismatch` is a real, reachable outcome rather
  than defensive dead code.
- **That page limits behave as documented** (600 pages base64, 100 on a
  200K-context model). Not enforced here — we cannot count pages without a PDF
  parser, and adding one would undo the "no `pdf.js`" win. The 32MB request
  ceiling **is** enforced, as `MAX_BASE64_BYTES`.
- **That a 429 carries a usable `retry-after`.** Read if present, `null` if not.
- **That `stop_details.category` is populated on a refusal.** Read defensively;
  `null` is handled.
- **That a `stream: true` the proxy decides to strip would come back as an
  ordinary JSON message.** Not probed — but silent stripping is this proxy's
  house style (`tool_choice`), so the streaming reader falls back to plain JSON
  parsing when a 200 arrives carrying no SSE events at all. Costs nothing;
  removes a whole failure mode if it ever happens.

### Documented, from the API reference — not probed here

- The API's JSON Schema subset supports `type`, `enum`, `const`, `anyOf`,
  `additionalProperties: false`, and the `date` string format. It does **not**
  support `minimum`, `maximum`, `minLength`, `maxLength`, `pattern` or
  `multipleOf`, and **drops them silently rather than rejecting them**. A schema
  carrying them would read as if it validated ranges and would not. `schema.test.ts`
  asserts none appear. This is why `normaliseAmounts` exists.
- `output_config.format` is incompatible with citations (400), which is why
  there are none.
- Recursive schemas are unsupported. There are none.
- `max_tokens` counts thinking **and** answer; `budget_tokens` must be at least
  1,024 and strictly less than `max_tokens`. Both are checked before the
  request leaves, because the API's 400 would arrive after the viewer has
  uploaded 26MB.

---

## Thinking, and why the budget is 8,000

The silent remap to `claude-sonnet-4-6` cost this flow adaptive thinking, and
the two extraction traps that produced real errors in the original analysis —
reconstructing a period figure by differencing cumulative year-to-date columns,
and spotting that a withdrawal on one statement is the other leg of a deposit on
another — are exactly the reasoning-heavy cases. Probe 6 shows the model, with
thinking on, reasoning explicitly that *"the balance column is cumulative (not
transactions), so I should not include those"*. That is the trap, caught in the
reasoning pass rather than not caught.

**The prompt keeps its explicit procedures anyway.** Thinking is a second pair
of eyes on the cases that have actually gone wrong, not a replacement for
spelling them out. A reasoning pass improves the odds on a hard document; a
spelled-out procedure holds on an easy one where the model does not think for
long. Both are cheap, and the failure they prevent is a plausible wrong number
the person will believe.

**Why 8,000.**

- The API's floor is 1,024, and it is far too small. Transfer pairing is the
  reasoning-heaviest step and it is quadratic in candidate flows: every outflow
  held against every inflow within a few days, across accounts, across
  documents. A forty-page set with sixty flows does not fit in a thousand
  tokens.
- **The budget is a ceiling, not an allocation.** The model stops thinking when
  it is done, so a generous cap costs nothing on the easy documents that are
  most of them. The cost of setting it too low is paid precisely on the hard
  documents, where the reasoning pass is cut off mid-way.
- It is not free either. Thinking tokens are output tokens: billed to the
  viewer, generated at output speed, on a call that already takes 24.7 seconds
  on a trivial document.
- 8,000 is roughly a hundred flows' worth of pairing plus a dozen
  cumulative-column reconstructions with their arithmetic shown, plus the
  boundary-rule pass over each account. It is a quarter of the answer budget
  rather than a multiple of it, so the failure mode is "reasoning was slightly
  clipped on a pathological document", not "the answer was crowded out".

`DEFAULT_MAX_TOKENS` is **40,000 = 8,000 thinking + 32,000 answer**. The budget
is added to the answer headroom, not taken out of it; bolting it onto the old
32,000 ceiling would have made truncation likelier, which is the opposite of
what was wanted.

**`content[0]` is no longer the text block.** With thinking on, the reply opens
with a `{type: "thinking"}` block and the JSON is in a later one. `readText`
filters by block type and always has, so nothing here broke — but anything that
reaches for `content[0].text` will read `undefined` and report a perfectly good
extraction as an empty reply. There is a test pinning it.

---

## Streaming, and why it is the default

`stream: true` is on unless the caller passes `stream: false`. That is a
reversal of the previous design and the argument is worth stating in full.

1. **It is the only way to tell silence from slowness.** A signed-out viewer
   produces no events, ever — claude.ai intercepts with a modal and the fetch
   never resolves. A working forty-page extraction produces a steady stream of
   them. Non-streaming cannot distinguish the two states, so its single ceiling
   has to be long enough for the slowest legitimate run, which makes it useless
   as a sign-out detector. Streaming turns a guess into a measurement.
2. **It removes the `max_tokens` / timeout coupling**, which is the compromise
   the previous design documented and disliked.
3. **Latency is the binding constraint now.** 24.7 seconds on a one-page
   document; a real statement set will be minutes. A minute of unbroken spinner
   reads as a broken tool.

The cost is one more thing to get wrong: an SSE decoder between the API and the
classifier. That cost is bounded deliberately. `src/stream.ts` ends at
`StreamAssembler.envelope()`, which produces the **same shape a non-streaming
reply has**, and `extract.ts` then runs exactly one classification path over it.
A second copy of the taxonomy for the streaming case is how truncation detection
regresses on the branch nobody exercises.

**Non-streaming is kept working, not kept around.** `stream: false` is the right
choice for a batch harness with nobody watching, and `extract.test.ts` re-runs
six representative outcomes through it. The fake transport reads `stream` out of
the request body and answers in whichever shape was asked for, so the ordinary
outcome tests exercise the shipped path by construction rather than by a
parallel set of streaming-only tests.

### Progress means a count, not an animation

`onProgress` reports a phase (`sent → connected → thinking → writing → done`)
and four numbers, throttled to 250ms. `rows` and `exclusions` are **counted out
of the partial JSON**: `"amountConfidence"` appears exactly once per row and
`"pairedWith"` exactly once per exclusion, counted incrementally so a
forty-page reply is not re-scanned a thousand times. "Read 31 rows so far" is a
true statement about a call with another minute to run.

### `stop_reason` still arrives, in `message_delta`

Truncation detection depends entirely on that one event. A reader that only
accumulates text would report a truncated forty-page extraction as invalid
JSON — telling the user to fix a document that is fine. There is a test that
asserts the fixture carries `stop_reason` in `message_delta` **and nowhere
else**, so it cannot pass against a reader that never looks there.

A stream that ends without `message_stop` **and** without any `stop_reason` did
not finish: that is `api-error` / `stream-incomplete`, not `invalid-json`. Where
a `stop_reason` did arrive, generation genuinely completed and a missing
`message_stop` is only a lost tail frame, so the normal path runs and
`max_tokens` is still reported as truncation.

---

## The timeout — three budgets, doing three different jobs

The previous design had one number doing two contradictory jobs. Streaming
splits them.

| Budget | Default | Job |
|---|---|---|
| `DEFAULT_FIRST_EVENT_TIMEOUT_MS` | 120,000 | **The sign-out detector**, and now its only job. It covers everything before the first token: up to 26MB of base64 uploaded (~40s on a 5 Mbps uplink), the proxy's own ~4.2k system prompt, and prefill on forty pages. It does **not** have to cover generation. |
| `DEFAULT_STALL_TIMEOUT_MS` | 30,000 | **The load-bearing one.** Once events flow they flow continuously — 11 events in 3.3 seconds on the probe — and `ping` frames fill any genuine pause and count as events. A thirty-second gap is a dead socket, not a model thinking. Short enough to tell the user quickly; long enough that a network hiccup does not kill a three-minute extraction that was going fine. |
| `DEFAULT_TIMEOUT_MS` | 600,000 | **A backstop, not the mechanism.** A stream dribbling one token every twenty-nine seconds would never trip the stall timer. Ten minutes is above any legitimate run and below the point where the user has gone elsewhere. |

**The copy keys off the event count, not off which timer fired.** Zero events
means nothing ever came back, which is the signed-out signature whatever killed
the wait — so a ceiling expiry with no events still says "you may be signed
out". Some events then silence says "Claude began reading and then stopped
partway through", because a viewer who got that far is demonstrably signed in
and sending them off to check their login would be wrong.

**`max_tokens` is no longer coupled to any of them.** Raising it costs tokens
and wall-clock and does not bring the request closer to being killed. On a
`stream: false` call the coupling returns in full — there are no events to time
between, so the ceiling is the only timer and a signed-out viewer waits the
whole ten minutes. That is the clearest argument for leaving streaming on.

---

## The three things that are easy to get wrong

### 1. `stop_reason` is checked before `content` is touched

A refusal is HTTP 200 with an **empty** `content` array. A truncation is HTTP
200 with `content` holding JSON that is correctly *shaped* and cannot be parsed.
Reading `content[0].text` first turns both into a confusing parse error, and
tells the user their statement was malformed when in fact Claude declined to
read it, or ran out of room. With thinking on, `content[0]` is not the text
block at all.

Truncation is the likeliest real failure on a forty-page statement. It is
reported as `truncated`, with the copy "split the documents into fewer pages" —
never as `invalid-json`.

### 2. Shape failures fail the call; value failures do not

`validateExtraction` returns **shape** issues — a wrong enum, a missing field,
an extra property, `2025-02-30`. Any of them means the reply is not an
`ExtractionResult` and nothing may read it. The call fails.

`crossCheck` returns **value** warnings — a zero balance, a future date, a
duplicate triple, mixed currencies, an unmatched transfer leg, and above all a
summary whose totals disagree with the rows it claims to summarise. None of
these fails the call, because the review table is the source of truth by
construction and a warning on one cell beats discarding two hundred good rows.

That split is why asking for `summary` at all is worth the tokens. Every figure
the model reports is recomputed from the model's own rows; when the two
disagree, that is a red banner — *"Claude's totals do not match the rows it
produced"* — and it catches a class of extraction error no schema can see, for
free.

### 3. A signed amount is corrected, loudly — the one exception to "never fix"

The contract is that **all three row types carry positive amounts and direction
comes from `type`**. The schema cannot enforce it: `minimum` is not in the API's
supported subset and is dropped *silently*, so a schema carrying it would read
as if it validated the range and would not. And the model's instinct runs the
other way — probe batch 2 returned `amount: -450.00` for a withdrawal on a
one-page document.

A negative withdrawal that reaches the engine is subtracted as a negative: money
leaving becomes money arriving, the direction is counted twice in opposite
senses, and nothing downstream can see it. That is a plausible wrong number the
user will believe, which is the exact failure class this tool exists to catch.

`normaliseAmounts` therefore **corrects rather than rejects**, and gates:

- Rejecting would mean a `schema-mismatch` on the whole extraction — two
  hundred good rows discarded over one sign convention, against a review table
  that exists precisely to let a person fix one cell.
- The **magnitude** is never in doubt. `|−450|` is 450 under every reading.
- The **direction** is. `-450` on a withdrawal is either a redundant sign (the
  common case, and what probe 2 produced) or a sign contradicting the type.
  Nothing in the reply distinguishes them.
- So: keep the declared `type`, correct the magnitude, and raise a
  **`negative-amount` warning at `error` severity** naming the row. `error`
  blocks compute in the review table, so a human must check that one row
  against the statement before any arithmetic runs. A silent wrong number
  becomes a hard gate on one cell.
- **Balances are deliberately not touched.** A negative account value is not a
  sign slip; it is meaningless or a real margin debit, and flipping it would
  invent a number. `crossCheck` reports `non-positive-balance` at `error` and
  leaves it alone.
- **Exclusions are corrected at `warning` severity.** Nothing in `excluded`
  reaches the maths, so a sign slip there is a display problem.
- **Zero is left alone.** It has no sign to correct and no direction to be
  ambiguous about; it stays a `non-positive-amount` warning.

`outcome.raw` still holds exactly what came back, and `normaliseAmounts` never
mutates its input.

**`type: "transfer"` is the other half of the same finding, and it is rejected
outright.** The model tried it in probe batch 2. Transfers belong in `excluded`
with reason `internal-transfer`, both legs keeping their own direction — so
`ROW_TYPES` stays a closed three-value enum, the validator reports `not-in-enum`
at `rows[n].type`, and the call fails with `schema-mismatch` carrying the raw
reply. There is no rerouting: turning a row the model typed as `transfer` into
an exclusion would be this module inventing an intent, which is the thing it
refuses to do everywhere else. The prompt and the schema descriptions both now
say plainly that there is no `transfer` type.

---

## Failure taxonomy

`extract()` never throws for an expected condition. Every outcome carries
`status`, `ok`, `message` (showable verbatim), `durationMs`, `requestedModel`,
`servedModel`, `usage`, `thinking` and `events`.

| `status` | Trigger | What the UI should say |
|---|---|---|
| `ok` | Parsed, validated, model matched | Land in the table. Render `warnings` above it. |
| `truncated` | `stop_reason === 'max_tokens'` (from `message_delta` on a stream) | "Too long to read in one pass — split into fewer pages." Never "invalid". |
| `timeout` | A budget expired. `phase` says which; `events` says whether anything arrived | Zero events: "Claude did not respond. You may be signed out." Some events: "began reading and then stopped partway through." |
| `invalid-json` | Text block is not JSON, or is empty | "Claude's reply was not usable data. Nothing has been added to the table." |
| `schema-mismatch` | Parsed, failed validation | Show the count. Offer the raw reply. Route to Path A/B. |
| `model-mismatch` | `json.model !== requestedModel` | "Read by *X*, not *Y*." Carries the validated `result`, so the UI can offer it with a caution. |
| `refused` | `stop_reason === 'refusal'` | "Claude declined to read these documents." No retry. |
| `api-error` | Non-2xx, non-JSON body, network failure, a broken stream, or a pre-flight refusal | Sub-code selects the copy: `rate-limited`, `overloaded`, `http`, `non-json-body`, `network`, `request-too-large`, `nothing-to-send`, `invalid-options`, `stream-incomplete`. |

Three notes on that table.

**`refused` is an addition to the taxonomy the brief specified**, and it earns
its place. Without its own status a refusal lands in `invalid-json` and the user
is told to fix a document that is fine. It is checked before `content` is read,
which is the only safe order anyway.

**`model-mismatch` carries the result.** It is `ok: false` because the caller
must make a decision, not because the data is unusable — the reply has already
passed full validation by the time the mismatch is reported. A shape problem is
reported ahead of a model problem, because it is the more actionable of the two.

**`stream-incomplete` and `invalid-options` are the two new codes.** The first
keeps a dropped connection from being reported as a malformed reply. The second
catches a `thinking` budget that is below the API's floor or would swallow
`max_tokens`, *before* the request leaves — the API's own 400 would arrive after
the viewer had uploaded 26MB and paid the 4,200-token floor for it.

### There is no retry

Not anywhere, not with backoff, not on 429, not on a stream that dies half a
row from the end. Every call bills the viewer's own Claude account roughly 4,200
tokens of proxy overhead before a page of statement is counted. Retrying without
asking is spending someone else's money. Where a retry is the right answer the
outcome says so — `retryAfterSeconds` on a 429, `code: 'overloaded'` on a 529 —
and the caller decides. Tests assert that exactly one request is sent for every
failure shape on both the streaming and the non-streaming path, and that the
module exports nothing matching `/retry/i`.

---

## Using it

```ts
import { extract } from '@ahumanflourish/portfolio-extract';

const outcome = await extract(
  {
    attachments: [
      { kind: 'pdf', mediaType: 'application/pdf', data: base64Pdf, name: 'q4.pdf' },
      { kind: 'image', mediaType: 'image/png', data: base64Screenshot },
    ],
    text: pastedCsv,          // optional
    correction: userNote,     // optional — the "ask again" button
  },
  {
    onProgress: (p) => {
      // A forty-page statement is minutes. Show the count, not a spinner.
      status.set(
        p.phase === 'thinking'
          ? 'Working out how these statements fit together…'
          : `Read ${p.rows} rows and ${p.exclusions} exclusions so far…`,
      );
    },
  },
);

switch (outcome.status) {
  case 'ok':
    table.load(outcome.result, outcome.warnings, outcome.recomputed);
    break;
  case 'model-mismatch':
    table.load(outcome.result!, outcome.warnings, outcome.recomputed!);
    banner.caution(outcome.message);
    break;
  default:
    banner.error(outcome.message);   // every status has specific copy
}
```

Any warning at `severity: 'error'` — a non-positive balance, mixed currencies, a
corrected sign — must block the "looks right" button until the user has dealt
with that row.

Then, once the user has reviewed and pressed "looks right":

```ts
import { toInputRows } from '@ahumanflourish/portfolio-extract';
analyse({ rows: toInputRows(reviewedRows), feePct, now }, benchmarks, strategies, ref);
```

`toInputRows` strips `source`, `account`, `currency` and both confidence fields
— UI-layer fields the engine ignores. They are preserved on the way out to the
JSON export, which is what makes a re-import show the same struck-through
transfers and the same estimated markers the user last saw.

---

## What this package deliberately does not do

- **Transfer detection.** The prompt asks for it and the schema records it, but
  `synthetic.test.ts` §6 pins the cost of missing one — a month-straddling pair
  moves the reference ending value by $434.69 and the headline capture by more
  than 0.1pp. That must not depend on the model noticing, thinking or not.
  `findMatchedFlows` in core is the load-bearing detector; this is the second
  pair of eyes.
- **Ticker classification.** The prompt explicitly forbids it. Whether VXUS is
  international equity is a fact, and a wrong guess silently flips
  `regional-tilt`. A shipped lookup table decides.
- **Date-format disambiguation as a policy.** The prompt tells the model to
  decide across the whole document and to flag when it cannot; the parser does
  the same job deterministically for pasted CSVs. A per-row model guess here is
  invisible and wrong half the time.
- **Currency conversion.** Extract faithfully, flag the mixture, never convert.
  A conversion needs a rate on a date, which is a number nobody has.
- **Encoding files.** No `FileReader`, by design — see the top of this file.
- **Rerouting a mistyped row.** `type: "transfer"` fails the call. Guessing
  what the model meant is not this module's job.

---

## Privacy

Path C is the only route in the tool where data leaves the browser, and the copy
at the point of choice must say so. From INTERACTION.md, verbatim:

> Your statements are sent to Claude under **your own** Claude account, subject
> to your own account's terms. They are never sent to me, and I never see them.
> If you'd rather not, use manual entry or paste a CSV — those never leave your
> browser.

Do not write "nothing leaves your browser" anywhere this package is reachable.
Once Path C has been used in a session, the session is AI-touched and the
results page's export and share affordances must not carry the A/B claim.

`outcome.thinking` carries the model's reasoning about the user's financial
documents. It stays in the browser like everything else, and it is there because
it is the most useful thing to show beside a `schema-mismatch` — but it is the
user's data and belongs behind the same "show me what came back" affordance as
`raw`, not on screen by default.
