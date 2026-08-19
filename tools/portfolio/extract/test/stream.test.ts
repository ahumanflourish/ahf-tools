/**
 * The SSE decoder and the reassembler, on their own.
 *
 * These are the pieces `extract.ts` gained when `stream: true` was measured to
 * work through the proxy, and they sit between the network and every outcome in
 * the taxonomy. A bug here does not look like a bug here — it looks like a
 * truncated extraction reported as invalid JSON, or twelve rows silently
 * dropped out of the middle of a statement because a frame straddled a chunk
 * boundary. So they are tested directly, not only through `extract`.
 */

import { describe, expect, it } from 'vitest';

import { MarkerCounter, StreamAssembler, decodeSseFrames } from '../src/stream';
import { sseFramesFor, thinkingEnvelope, VALID } from './fixtures';

const feedAll = (frames: string[], sliceBytes?: number): StreamAssembler => {
  const sink = new StreamAssembler();
  const text = frames.join('');
  let pending = '';
  const pieces: string[] = [];
  if (sliceBytes) {
    for (let i = 0; i < text.length; i += sliceBytes) pieces.push(text.slice(i, i + sliceBytes));
  } else {
    pieces.push(text);
  }
  for (const piece of pieces) {
    const { events, rest } = decodeSseFrames(pending + piece);
    pending = rest;
    for (const event of events) sink.feed(event);
  }
  return sink;
};

describe('decodeSseFrames', () => {
  it('reads a complete frame and keeps the partial tail', () => {
    const { events, rest } = decodeSseFrames(
      'event: ping\ndata: {"type":"ping"}\n\nevent: message_stop\ndata: {"type":"mes',
    );
    expect(events).toEqual([{ type: 'ping' }]);
    expect(rest).toBe('event: message_stop\ndata: {"type":"mes');
  });

  it('trusts the payload’s own type rather than the event: line', () => {
    // The event name and the payload type are redundant. Reading the payload
    // means a proxy that rewrites one of them cannot desynchronise us.
    const { events } = decodeSseFrames('event: nonsense\ndata: {"type":"message_stop"}\n\n');
    expect(events[0].type).toBe('message_stop');
  });

  it('ignores comment keepalives and blank lines', () => {
    const { events } = decodeSseFrames(': keepalive\n\ndata: {"type":"ping"}\n\n');
    expect(events).toHaveLength(1);
  });

  it('survives CRLF line endings', () => {
    const { events } = decodeSseFrames('event: ping\r\ndata: {"type":"ping"}\r\n\r\n');
    expect(events).toEqual([{ type: 'ping' }]);
  });

  it('skips a frame that is not JSON rather than failing the stream', () => {
    const { events } = decodeSseFrames('data: not json\n\ndata: {"type":"ping"}\n\n');
    expect(events).toEqual([{ type: 'ping' }]);
  });

  it('accepts data with no space after the colon', () => {
    const { events } = decodeSseFrames('data:{"type":"ping"}\n\n');
    expect(events).toEqual([{ type: 'ping' }]);
  });
});

describe('MarkerCounter', () => {
  it('counts markers that straddle a chunk boundary exactly once', () => {
    const counter = new MarkerCounter(['"amountConfidence"']);
    counter.push('{"amountCon');
    counter.push('fidence":"read","amountConfidence":"derived"}');
    expect(counter.counts[0]).toBe(2);
  });

  it('agrees with a whole-string count on real extraction JSON', () => {
    const text = JSON.stringify(VALID);
    const counter = new MarkerCounter(['"amountConfidence"', '"pairedWith"']);
    for (let i = 0; i < text.length; i += 7) counter.push(text.slice(i, i + 7));
    expect(counter.counts[0]).toBe(VALID.rows.length);
    expect(counter.counts[1]).toBe(VALID.excluded.length);
  });
});

describe('StreamAssembler', () => {
  const frames = sseFramesFor(thinkingEnvelope(VALID));

  it('rebuilds the envelope the non-streaming path would have seen', () => {
    const sink = feedAll(frames);
    const envelope = sink.envelope();
    expect(envelope.model).toBe('claude-sonnet-4-6');
    expect(envelope.stop_reason).toBe('end_turn');
    expect(envelope.usage).toEqual({ input_tokens: 4179, output_tokens: 812 });
    expect(JSON.parse((envelope.content as any[])[1].text)).toEqual(VALID);
  });

  it('puts the thinking block FIRST, which is where the API puts it', () => {
    const content = feedAll(frames).envelope().content as any[];
    expect(content[0].type).toBe('thinking');
    expect(content[0].thinking).toContain('cumulative');
    expect(content[0].signature).toBe('sig_test_abc123');
    expect(content[1].type).toBe('text');
  });

  it('reassembles identically when every frame is split across byte slices', () => {
    expect(feedAll(frames, 13).envelope()).toEqual(feedAll(frames).envelope());
  });

  it('reports message_stop, which is the only proof the stream finished', () => {
    expect(feedAll(frames).sawMessageStop).toBe(true);
    expect(feedAll(sseFramesFor(thinkingEnvelope(VALID), { omitMessageStop: true }))
      .sawMessageStop).toBe(false);
  });

  it('takes stop_reason from message_delta and nowhere else', () => {
    const truncated = sseFramesFor(
      thinkingEnvelope(VALID, 'thinking', { stop_reason: 'max_tokens' }),
    );
    expect(feedAll(truncated).envelope().stop_reason).toBe('max_tokens');
    // Drop message_delta and the stop_reason is genuinely unknown — not
    // defaulted to end_turn, which would hide a truncation.
    const noDelta = sseFramesFor(
      thinkingEnvelope(VALID, 'thinking', { stop_reason: 'max_tokens' }),
      { omitMessageDelta: true, omitMessageStop: true },
    );
    expect(feedAll(noDelta).envelope().stop_reason).toBeNull();
  });

  it('captures a mid-stream error event', () => {
    const sink = feedAll(
      sseFramesFor(thinkingEnvelope(VALID), {
        errorEvent: { type: 'overloaded_error', message: 'busy' },
      }),
    );
    expect(sink.apiError).toEqual({ type: 'overloaded_error', message: 'busy' });
  });

  it('counts ping frames as events, because that is what they are for', () => {
    const sink = new StreamAssembler();
    sink.feed({ type: 'ping' });
    expect(sink.events).toBe(1);
  });
});
