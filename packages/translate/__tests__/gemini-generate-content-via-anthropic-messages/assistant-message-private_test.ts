import { expect, test } from 'vitest';

import { translateGeminiGenerateContentViaAnthropicMessages } from '../../src/gemini-generate-content-via-anthropic-messages/translate.ts';
import { privateContext, referencedTextHash } from '../test-utils/assistant-message-private.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame } from '@floway-dev/protocols/common';
import { collectGeminiGenerateContentProtocolEventsToResult, type GeminiGenerateContentPart } from '@floway-dev/protocols/gemini-generate-content';

test('native thinking, signatures, redaction, and block boundaries survive replay without public thought text', async () => {
  const context = privateContext();
  const trip = await translateGeminiGenerateContentViaAnthropicMessages({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }, { model: 'm', privateContext: context });
  const events: AnthropicMessagesStreamEventEx[] = [
    { type: 'message_start', message: { container: null, diagnostics: null, stop_details: null, id: 'msg', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: null, input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'A' } },
    { type: 'message_delta', delta: { container: null, stop_details: null, stop_sequence: null, stop_reason: null }, usage: { input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null, output_tokens: 1 } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'B' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 's' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'ig' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'redacted' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '', citations: null } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'answer' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { container: null, stop_details: null, stop_sequence: null, stop_reason: 'end_turn' }, usage: { input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null, output_tokens: 2 } },
    { type: 'message_stop' },
  ];
  const frames = [];
  for await (const frame of trip.events((async function* () { for (const event of events) yield eventFrame(event); })())) frames.push(frame);
  const finish = frames.filter(frame => frame.type === 'event' && !('error' in frame.event) && frame.event.candidates?.some(candidate => candidate.finishReason !== undefined));
  expect(finish).toHaveLength(1);
  expect(frames.at(-1)).toBe(finish[0]);
  const result = await collectGeminiGenerateContentProtocolEventsToResult((async function* () { yield* frames; })());
  const parts = result.candidates?.[0].content?.parts;
  if (parts === undefined) throw new Error('Expected content');
  const carrier = parts.at(-1);
  expect(Object.keys(carrier!)).toEqual(['thoughtSignature']);
  const value = await context.codec.unencapsulate(carrier?.thoughtSignature);
  expect(value).toEqual({ reasoningText: 'AB', sidecar: { upstreamProtocol: 'anthropicMessages', thinBlocks: [{ type: 'thinking', __thinking: [[0, 2]], signature: 'sig' }, { type: 'redacted_thinking', data: 'redacted' }], referencedTextHash: referencedTextHash('AB') } });
  const replayParts: GeminiGenerateContentPart[] = [{ thought: true, text: 'edited display' }, { text: 'answer', thoughtSignature: carrier?.thoughtSignature }];
  const replay = await translateGeminiGenerateContentViaAnthropicMessages({ contents: [{ role: 'model', parts: replayParts }] }, { model: 'm', privateContext: context });
  expect(replay.target.messages[0].content).toMatchObject([{ type: 'thinking', thinking: 'AB', signature: 'sig' }, { type: 'redacted_thinking', data: 'redacted' }, { type: 'text', text: 'answer' }]);
});
