import { describe, expect, it } from 'vitest';

import { decodeAnthropicMessagesStream } from '../../src/anthropic-messages/stream.ts';
import { decodeGeminiGenerateContentStream } from '../../src/gemini-generate-content/stream.ts';
import { decodeOpenAIAudioTranscriptionsStream } from '../../src/openai-audio/stream.ts';
import { decodeOpenAIChatCompletionsStream } from '../../src/openai-chat-completions/stream.ts';
import { decodeOpenAICompletionsStream } from '../../src/openai-completions/stream.ts';
import { decodeOpenAIResponsesStream } from '../../src/openai-responses/stream.ts';
import type { Result } from '@floway-dev/pipeline';

const encoder = new TextEncoder();
const wire = async function* <Failure>(...chunks: (string | { error: Failure })[]): AsyncGenerator<Result<Uint8Array, Failure>> {
  for (const chunk of chunks) {
    yield typeof chunk === 'string'
      ? { ok: true, value: encoder.encode(chunk) }
      : { ok: false, error: chunk.error };
  }
};

describe('SSE byte-result decoding', () => {
  it('accepts a sentinel-free Chat Completions EOF with a final data line', async () => {
    const result = await Array.fromAsync(decodeOpenAIChatCompletionsStream(wire('data: {"id":"a",', '"choices":[]}')));
    expect(result).toEqual([{ ok: true, value: { id: 'a', choices: [] } }]);
  });

  it.each(['abort', 'transport'] as const)('forwards a %s after the wire terminator', async kind => {
    const failure = { kind, cause: new Error('in-flight I/O failed') };
    const result = await Array.fromAsync(decodeOpenAIChatCompletionsStream(wire('data: [DONE]\n\n', { error: failure })));
    expect(result).toEqual([{ ok: false, error: failure }]);
    const item = result[0]!;
    if (item.ok) throw new Error('Expected the transport outcome');
    expect(item.error).toBe(failure);
  });

  it('emits one Err for malformed JSON without pulling another input chunk', async () => {
    const bytes = (async function* () {
      yield { ok: true, value: encoder.encode('data: {bad}\n\n') } as const;
      throw new Error('Read beyond the malformed event');
    })();
    expect(await Array.fromAsync(decodeOpenAIChatCompletionsStream(bytes))).toEqual([
      { ok: false, error: { kind: 'protocol', cause: expect.any(Error) } },
    ]);
  });

  it('requires an Anthropic Messages terminal on successful transport EOF', async () => {
    const event = { type: 'message_stop' };
    expect(await Array.fromAsync(decodeAnthropicMessagesStream(wire(`event: message_stop\ndata: ${JSON.stringify(event)}\n\n`)))).toEqual([
      { ok: true, value: event },
    ]);
    expect(await Array.fromAsync(decodeAnthropicMessagesStream(wire('event: ping\ndata: {"type":"ping"}\n\n')))).toEqual([
      { ok: true, value: { type: 'ping' } },
      { ok: false, error: { kind: 'protocol', cause: expect.any(Error) } },
    ]);
  });

  it('preserves a trailing bare Gemini error as a protocol event', async () => {
    const event = { candidates: [{ index: 0 }] };
    const error = { error: { code: 429, message: 'busy', status: 'RESOURCE_EXHAUSTED' } };
    const results = await Array.fromAsync(decodeGeminiGenerateContentStream(wire(`data: ${JSON.stringify(event)}\n\n`, `${JSON.stringify(error)}\n`)));
    expect(results).toEqual([
      { ok: true, value: event },
      { ok: true, value: error },
    ]);
  });

  it('expands partial output from the OpenAI Responses failed resource with continuous sequence numbers', async () => {
    const response = {
      id: 'resp_failed', object: 'response', status: 'failed', model: 'gpt-test',
      output: [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'some output', annotations: [] }] }],
      error: { code: 'server_error', message: 'failed' },
      incomplete_details: null,
    };
    const error = { type: 'error', sequence_number: 1, code: 'server_error', message: 'failed' };
    const failure = { type: 'response.failed', sequence_number: 2, response };
    const source = wire(`data: ${JSON.stringify(error)}\n\n`, `event: response.failed\ndata: ${JSON.stringify(failure)}\n\n`);
    const events = await Array.fromAsync(decodeOpenAIResponsesStream(source));
    expect(events[0]).toEqual({ ok: true, value: error });
    expect(events).toContainEqual({ ok: true, value: expect.objectContaining({ type: 'response.output_text.delta', delta: 'some output' }) });
    expect(events.at(-1)).toEqual({ ok: true, value: { ...failure, sequence_number: 10 } });
  });

  it('accepts a standalone OpenAI Responses error at native EOF', async () => {
    const error = { type: 'error', sequence_number: 1, message: 'resource gone' };
    expect(await Array.fromAsync(decodeOpenAIResponsesStream(wire(`data: ${JSON.stringify(error)}\n\n`)))).toEqual([{ ok: true, value: error }]);
  });

  it('accepts the Gemini sentinel when the preceding candidate has not finished', async () => {
    const event = { candidates: [{ index: 0 }] };
    expect(await Array.fromAsync(decodeGeminiGenerateContentStream(wire(`data: ${JSON.stringify(event)}\n\n`, 'data: [DONE]\n\n')))).toEqual([{ ok: true, value: event }]);
  });

  it('classifies invalid structures consumed by the protocol normalizers', async () => {
    expect(await Array.fromAsync(decodeOpenAIResponsesStream(wire('data: {"type":"response.completed","response":null}\n\n')))).toEqual([
      { ok: false, error: { kind: 'protocol', cause: expect.any(Error) } },
    ]);
    expect(await Array.fromAsync(decodeGeminiGenerateContentStream(wire('data: {"candidates":{}}\n\n')))).toEqual([
      { ok: false, error: { kind: 'protocol', cause: expect.any(Error) } },
    ]);
    const response = { status: 'failed', output: [{ type: 'message', id: 'm' }] };
    const invalidMessage = wire(`data: ${JSON.stringify({ type: 'response.failed', response })}\n\n`);
    expect(await Array.fromAsync(decodeOpenAIResponsesStream(invalidMessage))).toEqual([
      { ok: false, error: { kind: 'protocol', cause: expect.any(Error) } },
    ]);
  });

  it('requires the terminal for OpenAI Completions and Transcriptions at EOF', async () => {
    const completions = decodeOpenAICompletionsStream(wire('data: {"choices":[]}\n\n'));
    const transcriptions = decodeOpenAIAudioTranscriptionsStream(wire('data: {"type":"transcript.text.delta","delta":"hello"}\n\n'));
    for (const stream of [completions, transcriptions]) {
      expect(await stream.next()).toMatchObject({ done: false, value: { ok: true } });
      expect(await stream.next()).toMatchObject({ done: false, value: { ok: false, error: { kind: 'protocol', cause: expect.any(Error) } } });
      expect(await stream.next()).toMatchObject({ done: true });
    }
  });
});
