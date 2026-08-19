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
src/validate.ts   client-side validation, plus the value-level cross-check
src/extract.ts    the one model call and its typed outcomes
src/types.ts      the types the rest of the flow reads
```

Zero runtime dependencies. No DOM beyond `fetch` and `AbortController` — no
`FileReader`, no `Blob`, no `atob`. Callers hand in base64 they produced
themselves, so the same module runs unchanged in a published artifact, in the
offline single-file build, and under Node.

```
npm test          134 tests, no network
npm run typecheck
```

---

## Measured fact vs. assumption

**Read this before changing anything in `extract.ts`.** The design is not a
reading of the API documentation; it is a reading of eight probes run from a
published claude.ai artifact against the proxy on 2026-08-19. Where the two
disagree, the probes win, because the proxy is what actually serves this code.

### Measured, 2026-08-19 — from a published artifact, not inferred

| Fact | Where it shows up here |
|---|---|
| The proxy **silently remaps the model**. Requesting `claude-sonnet-5` served `claude-sonnet-4-6` on HTTP 200 with no warning. | `DEFAULT_MODEL = 'claude-sonnet-4-6'`; `json.model` is read on every response and a mismatch is its own outcome. |
| **`output_config.format` shapes generation.** Paired A/B on a prose-inviting prompt, three trials each way: with the schema, bare JSON 3/3 and a marker key present 3/3; without it, bare JSON 0/3. | `output_config: { format: { type: 'json_schema', schema } }` is the only shaping mechanism sent. |
| **Tools are stripped.** A forced `tool_choice` came back as a chatty markdown table. | No `tools`, no `tool_choice`. There is no fallback behind `output_config`. |
| **Assistant prefill is rejected** with a 400 ("does not support assistant message prefill"). | One `user` message, always. |
| **base64 `document` (PDF) and `image` blocks both pass.** | Attachments go straight in. No `pdf.js`, no client-side text extraction. INTERACTION.md's three-rung fallback ladder collapses to rung one. |
| **Logged out is not an HTTP status.** claude.ai intercepts with a modal; the request never reaches the API and the promise never settles. | `DEFAULT_TIMEOUT_MS`. There is no 401 branch because there is no 401. |
| **~4,200 input tokens of proxy overhead per call**, billed to the viewer (`input_tokens: 4179` for "Reply with the single word: ok"). | One call, never a conversation, and **no retry loop**. |

### Assumption — believed, not probed

Each of these is a place where a future probe could change the design. None of
them is load-bearing for correctness, because `validate.ts` runs regardless.

- **That `output_config` is a hard grammar constraint rather than the schema
  being read as instruction.** This is the most important open question in the
  package, and the evidence points the other way. `claude-sonnet-4-6` — the
  model the proxy actually serves — is **not** on the documented
  structured-outputs support list. So the A/B tells us the schema changes what
  the model writes; it does not tell us the schema is *enforced*. Treat the
  reply as strongly-shaped free text that usually parses. That is precisely why
  every reply is validated client-side and why `schema-mismatch` is a real,
  reachable outcome rather than defensive dead code.
- **That `stream: true` works through the proxy.** Not probed. The request here
  is non-streaming, which is why `DEFAULT_TIMEOUT_MS` and `DEFAULT_MAX_TOKENS`
  are coupled (see below). Probing streaming is the single highest-value next
  experiment: it would decouple them and give the progress indicator something
  real to show.
- **That `thinking` is accepted at all.** Not probed, and not sent. On
  `claude-sonnet-4-6`, omitting `thinking` means no thinking — so the quarterly
  reconstruction and the transfer trap rest entirely on the prompt. This is a
  real cost of the remap: the flow plan assumed Sonnet 5, where adaptive
  thinking is the default.
- **That page limits behave as documented** (600 pages base64, 100 on a
  200K-context model). Not enforced here — we cannot count pages without a PDF
  parser, and adding one would undo the "no `pdf.js`" win. The 32MB request
  ceiling **is** enforced, as `MAX_BASE64_BYTES`.
- **That a 429 carries a usable `retry-after`.** Read if present, `null` if not.
- **That `stop_details.category` is populated on a refusal.** Read defensively;
  `null` is handled.

### Documented, from the API reference — not probed here

- The API's JSON Schema subset supports `type`, `enum`, `const`, `anyOf`,
  `additionalProperties: false`, and the `date` string format. It does **not**
  support `minimum`, `maximum`, `minLength`, `maxLength`, `pattern` or
  `multipleOf`, and **drops them silently rather than rejecting them**. A schema
  carrying them would read as if it validated ranges and would not. `schema.test.ts`
  asserts none appear.
- `output_config.format` is incompatible with citations (400), which is why
  there are none.
- Recursive schemas are unsupported. There are none.

---

## The two things that are easy to get wrong

### 1. `stop_reason` is checked before `content` is touched

A refusal is HTTP 200 with an **empty** `content` array. A truncation is HTTP
200 with `content` holding JSON that is correctly *shaped* and cannot be parsed.
Reading `content[0].text` first turns both into a confusing parse error, and
tells the user their statement was malformed when in fact Claude declined to
read it, or ran out of room.

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

---

## Failure taxonomy

`extract()` never throws for an expected condition. Every outcome carries
`status`, `ok`, `message` (showable verbatim), `durationMs`, `requestedModel`,
`servedModel` and `usage`.

| `status` | Trigger | What the UI should say |
|---|---|---|
| `ok` | Parsed, validated, model matched | Land in the table. Render `warnings` above it. |
| `truncated` | `stop_reason === 'max_tokens'` | "Too long to read in one pass — split into fewer pages." Never "invalid". |
| `timeout` | Nothing settled inside `timeoutMs` | "Claude did not respond. You may be signed out. Everything you have entered is still here." |
| `invalid-json` | Text block is not JSON, or is empty | "Claude's reply was not usable data. Nothing has been added to the table." |
| `schema-mismatch` | Parsed, failed validation | Show the count. Offer the raw reply. Route to Path A/B. |
| `model-mismatch` | `json.model !== requestedModel` | "Read by *X*, not *Y*." Carries the validated `result`, so the UI can offer it with a caution. |
| `refused` | `stop_reason === 'refusal'` | "Claude declined to read these documents." No retry. |
| `api-error` | Non-2xx, non-JSON body, network failure, or a pre-flight refusal | Sub-code (`rate-limited`, `overloaded`, `http`, `non-json-body`, `network`, `request-too-large`, `nothing-to-send`) selects the copy. |

Two notes on that table.

**`refused` is an addition to the taxonomy the brief specified**, and it earns
its place. Without its own status a refusal lands in `invalid-json` and the user
is told to fix a document that is fine. It is checked before `content` is read,
which is the only safe order anyway.

**`model-mismatch` carries the result.** It is `ok: false` because the caller
must make a decision, not because the data is unusable — the reply has already
passed full validation by the time the mismatch is reported. A shape problem is
reported ahead of a model problem, because it is the more actionable of the two.

### There is no retry

Not anywhere, not with backoff, not on 429. Every call bills the viewer's own
Claude account roughly 4,200 tokens of proxy overhead before a page of statement
is counted. Retrying without asking is spending someone else's money. Where a
retry is the right answer the outcome says so — `retryAfterSeconds` on a 429,
`code: 'overloaded'` on a 529 — and the caller decides. A test asserts that
exactly one request is sent for every failure shape, and that the module exports
nothing matching `/retry/i`.

---

## The timeout, and why it is 180 seconds

`DEFAULT_TIMEOUT_MS` is doing two jobs at once and they pull in opposite
directions.

**Job one: it is the only signal a signed-out viewer will ever produce.** There
is no 401 to catch — claude.ai intercepts with its own modal and the fetch never
resolves. Without a timeout that viewer watches a spinner forever. That argues
short.

**Job two: it must not kill a real extraction.** A dense forty-page statement
set is a large prefill before the first output token, and a full extraction of
it runs to a few thousand output tokens. End to end that is comfortably inside
two minutes, with prefill on a 20MB attachment as the long pole rather than
generation. That argues long.

180,000ms sits above a realistic worst case with roughly two to three times
headroom, and caps the signed-out wait at something a person will tolerate once
with a progress indicator running.

It is deliberately **not** sized for `max_tokens` being fully consumed. A run
that actually generates 32,000 tokens will time out, and that is the correct
outcome: it is a runaway, not an extraction, and the honest message is "that
took too long, split the documents" rather than a six-minute spinner.

`DEFAULT_MAX_TOKENS` and `DEFAULT_TIMEOUT_MS` are therefore **coupled**, and
they are coupled only because the request is non-streaming. Raise one and you
must raise the other — and at that point what you actually want is streaming,
which has not been probed through the proxy. Both are per-call options.

---

## Using it

```ts
import { extract } from '@ahumanflourish/portfolio-extract';

const outcome = await extract({
  attachments: [
    { kind: 'pdf', mediaType: 'application/pdf', data: base64Pdf, name: 'q4.pdf' },
    { kind: 'image', mediaType: 'image/png', data: base64Screenshot },
  ],
  text: pastedCsv,          // optional
  correction: userNote,     // optional — the "ask again" button
});

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
  than 0.1pp. That must not depend on the model noticing. `findMatchedFlows` in
  core is the load-bearing detector; this is the second pair of eyes.
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
