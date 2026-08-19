/**
 * Server-sent events, decoded and reassembled into the response envelope the
 * non-streaming path already knows how to classify.
 *
 * WHY THIS EXISTS. `stream: true` was measured through the claude.ai proxy on
 * 2026-08-19 and it is TRUE streaming, not buffered-then-flushed: 11 SSE
 * events, 8 chunks, first byte at 2591ms of a 3287ms call. That measurement
 * changes two things in the call module. It decouples `max_tokens` from the
 * timeout — the wait can now be policed by the gap BETWEEN events rather than
 * by one wall-clock ceiling sized for the worst case — and it gives the
 * progress indicator something real to count.
 *
 * THE DESIGN RULE HERE IS "REASSEMBLE, DO NOT RECLASSIFY". Everything in this
 * file ends at `StreamAssembler.envelope()`, which produces the same shape a
 * non-streaming reply has: `{ model, stop_reason, stop_details, content,
 * usage }`. `extract.ts` then runs exactly one classification path over it.
 * The alternative — a second copy of the taxonomy for the streaming case — is
 * how truncation detection regresses on the branch nobody exercises.
 *
 * NO DOM BEYOND `TextDecoder`, which exists wherever `fetch` does. The reader
 * is taken structurally rather than as a `ReadableStream`, so an offline build
 * or a fake transport can supply anything with the same two methods.
 */

/* ─────────────────────────────────────────────────────────── SSE frames */

/**
 * Decode as many complete SSE frames as `text` contains.
 *
 * Frames are separated by a blank line. Only `data:` lines are read: the
 * `event:` name is redundant because every Anthropic event carries its own
 * `type` field, and trusting the payload over the envelope means a proxy that
 * rewrites one and not the other cannot desynchronise us. Comment lines
 * (`: keepalive`) are ignored, which is what they are for.
 *
 * `rest` is the trailing partial frame. Hand it back on the next call — a
 * chunk boundary lands mid-frame constantly and a decoder that loses the tail
 * silently drops rows out of the middle of an extraction.
 */
export function decodeSseFrames(text: string): {
  events: Record<string, unknown>[];
  rest: string;
} {
  const normalised = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const parts = normalised.split('\n\n');
  const rest = parts.pop() ?? '';
  const events: Record<string, unknown>[] = [];

  for (const frame of parts) {
    const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const value = line.slice(5);
      data.push(value.startsWith(' ') ? value.slice(1) : value);
    }
    if (data.length === 0) continue;
    const payload = data.join('\n');
    if (payload === '[DONE]') continue;
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        events.push(parsed as Record<string, unknown>);
      }
    } catch {
      // A frame that is not JSON is not an event. It is not fatal either: the
      // stream may still deliver a usable message, and the absence of
      // `message_stop` is what reports a broken stream. Skipping is the only
      // behaviour that does not turn one malformed keepalive into a failure.
    }
  }

  return { events, rest };
}

/* ───────────────────────────────────────────────────── marker counting */

/**
 * Count fixed markers in a string that arrives in pieces.
 *
 * Used for progress: `"amountConfidence"` appears exactly once per row and
 * `"pairedWith"` exactly once per exclusion, so counting them in the partial
 * JSON gives a REAL "31 rows read so far", not an animation. Latency is the
 * binding constraint now — 24.7 seconds on a trivial one-page document — and a
 * spinner for a minute is the difference between a tool that is working and a
 * tool that is broken.
 *
 * Incremental on purpose. Re-scanning the whole accumulated reply on every one
 * of a thousand deltas is quadratic in the reply size, which on a forty-page
 * extraction is real time spent doing nothing.
 */
export class MarkerCounter {
  readonly counts: number[];
  private tail = '';
  private readonly overlap: number;

  constructor(private readonly markers: string[]) {
    this.counts = markers.map(() => 0);
    this.overlap = Math.max(0, ...markers.map((m) => m.length - 1));
  }

  push(chunk: string): void {
    if (chunk === '') return;
    const hay = this.tail + chunk;
    const boundary = this.tail.length;
    this.markers.forEach((marker, m) => {
      let from = 0;
      for (;;) {
        const at = hay.indexOf(marker, from);
        if (at === -1) break;
        // Only a match that extends past the carried-over tail is new; one that
        // sits wholly inside the tail was counted on the previous push.
        if (at + marker.length > boundary) this.counts[m] += 1;
        from = at + 1;
      }
    });
    this.tail = hay.slice(Math.max(0, hay.length - this.overlap));
  }
}

/* ───────────────────────────────────────────────────────── assembly */

/** One content block, rebuilt from its start event and its deltas. */
interface AssembledBlock {
  type: string;
  text: string;
  thinking: string;
  signature: string;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/**
 * Fold a stream of Anthropic SSE events back into one message envelope.
 *
 * The events it reads, and why each one matters:
 *
 *  - `message_start`   — the only place `model` appears. The proxy silently
 *                        remaps models, so losing this loses the one signal
 *                        that a remap happened.
 *  - `content_block_*` — thinking blocks arrive BEFORE the text block. Both
 *                        are kept, in order, so the rebuilt `content` array is
 *                        the same array the non-streaming path would have seen.
 *  - `message_delta`   — WHERE `stop_reason` LIVES ON A STREAM. Truncation
 *                        detection depends entirely on this event; a reader
 *                        that only accumulates text will report a truncated
 *                        forty-page extraction as invalid JSON.
 *  - `message_stop`    — the only proof the stream finished. Its absence is
 *                        the difference between "Claude stopped" and "the
 *                        connection dropped", and those need different copy.
 *  - `error`           — the API can fail mid-stream, after a 200.
 */
export class StreamAssembler {
  /** Every event seen, including `ping`. The stall timer counts these. */
  events = 0;
  sawMessageStop = false;
  apiError: { type: string | null; message: string } | null = null;

  /** Answer text so far, across every text block. */
  text = '';
  /** Reasoning so far, across every thinking block. */
  thinking = '';

  private id: string | null = null;
  private role: string | null = null;
  private model: string | null = null;
  private stopReason: string | null = null;
  private stopSequence: string | null = null;
  private stopDetails: Record<string, unknown> | null = null;
  private inputTokens: number | null = null;
  private outputTokens: number | null = null;
  private readonly blocks = new Map<number, AssembledBlock>();

  /** Fires with each new slice of answer text, for the progress counter. */
  onText?: (chunk: string) => void;
  /** Fires with each new slice of reasoning. */
  onThinking?: (chunk: string) => void;

  feed(event: Record<string, unknown>): void {
    this.events += 1;
    const type = str(event.type);

    switch (type) {
      case 'message_start': {
        const message = (event.message ?? {}) as Record<string, unknown>;
        this.id = str(message.id);
        this.role = str(message.role);
        this.model = str(message.model);
        this.stopReason = str(message.stop_reason) ?? this.stopReason;
        const usage = message.usage;
        if (usage && typeof usage === 'object') {
          const u = usage as Record<string, unknown>;
          this.inputTokens = numOrNull(u.input_tokens) ?? this.inputTokens;
          this.outputTokens = numOrNull(u.output_tokens) ?? this.outputTokens;
        }
        break;
      }

      case 'content_block_start': {
        const index = numOrNull(event.index) ?? this.blocks.size;
        const block = (event.content_block ?? {}) as Record<string, unknown>;
        const assembled: AssembledBlock = {
          type: str(block.type) ?? 'text',
          text: str(block.text) ?? '',
          thinking: str(block.thinking) ?? '',
          signature: str(block.signature) ?? '',
        };
        this.blocks.set(index, assembled);
        if (assembled.text) this.appendText(assembled.text);
        if (assembled.thinking) this.appendThinking(assembled.thinking);
        break;
      }

      case 'content_block_delta': {
        const index = numOrNull(event.index) ?? 0;
        const delta = (event.delta ?? {}) as Record<string, unknown>;
        const block =
          this.blocks.get(index) ??
          ({ type: 'text', text: '', thinking: '', signature: '' } as AssembledBlock);
        this.blocks.set(index, block);
        // Keyed off the DELTA's own type, not the block's. They agree in
        // practice; keying off the delta means a block whose start event was
        // dropped by a bad chunk boundary still lands in the right place.
        switch (str(delta.type)) {
          case 'text_delta': {
            const chunk = str(delta.text) ?? '';
            block.text += chunk;
            this.appendText(chunk);
            break;
          }
          case 'thinking_delta': {
            const chunk = str(delta.thinking) ?? '';
            block.thinking += chunk;
            this.appendThinking(chunk);
            break;
          }
          case 'signature_delta': {
            block.signature += str(delta.signature) ?? '';
            break;
          }
          default:
            break;
        }
        break;
      }

      case 'content_block_stop':
        break;

      case 'message_delta': {
        const delta = (event.delta ?? {}) as Record<string, unknown>;
        this.stopReason = str(delta.stop_reason) ?? this.stopReason;
        this.stopSequence = str(delta.stop_sequence) ?? this.stopSequence;
        const details = delta.stop_details;
        if (details && typeof details === 'object' && !Array.isArray(details)) {
          this.stopDetails = details as Record<string, unknown>;
        }
        const usage = event.usage;
        if (usage && typeof usage === 'object') {
          const u = usage as Record<string, unknown>;
          this.outputTokens = numOrNull(u.output_tokens) ?? this.outputTokens;
          this.inputTokens = numOrNull(u.input_tokens) ?? this.inputTokens;
        }
        break;
      }

      case 'message_stop':
        this.sawMessageStop = true;
        break;

      case 'error': {
        const err = (event.error ?? {}) as Record<string, unknown>;
        this.apiError = {
          type: str(err.type),
          message: str(err.message) ?? 'the stream reported an error',
        };
        break;
      }

      default:
        // `ping`, and anything the API adds later. Counted as an event — which
        // is the point of `ping` — and otherwise ignored.
        break;
    }
  }

  private appendText(chunk: string): void {
    this.text += chunk;
    this.onText?.(chunk);
  }

  private appendThinking(chunk: string): void {
    this.thinking += chunk;
    this.onThinking?.(chunk);
  }

  /**
   * The rebuilt message, in the exact shape `extract.ts` classifies.
   *
   * `content` is ordered by block index, so a thinking block comes back FIRST,
   * ahead of the text — which is what the API sends and what any consumer
   * indexing `content[0]` would trip over.
   */
  envelope(): Record<string, unknown> {
    const content = [...this.blocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, block]) => {
        if (block.type === 'thinking') {
          return { type: 'thinking', thinking: block.thinking, signature: block.signature };
        }
        if (block.type === 'redacted_thinking') {
          return { type: 'redacted_thinking', data: block.signature };
        }
        return { type: block.type, text: block.text };
      });

    return {
      id: this.id,
      type: 'message',
      role: this.role ?? 'assistant',
      model: this.model,
      content,
      stop_reason: this.stopReason,
      stop_sequence: this.stopSequence,
      ...(this.stopDetails ? { stop_details: this.stopDetails } : {}),
      usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens },
    };
  }
}
