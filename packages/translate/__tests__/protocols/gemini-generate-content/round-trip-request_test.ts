import { expect, test } from 'vitest';

import { computeGeminiGenerateContentTurnDigest } from '../../../src/protocols/gemini-generate-content/as-source/round-trip.ts';
import { encodeRoundTripSidecar } from '../../../src/round-trip/sidecar.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import { expectTrip } from '../../trip.ts';
import type { GeminiGenerateContentContent } from '@floway-dev/protocols/gemini-generate-content';
import { routeGeminiGenerateContentViaOpenAIChatCompletions } from '@floway-dev/translate';

const targetTurn = (name: string): GeminiGenerateContentContent[] => [{ role: 'model', parts: [{ functionCall: { name, args: { query: 'docs' } } }] }];
const replayedContents = (name: string, carrier: string): GeminiGenerateContentContent[] => [
  { role: 'user', parts: [{ text: 'question' }] },
  { role: 'model', parts: [{ thoughtSignature: carrier, functionCall: { name, args: { query: 'docs' } } }] },
  { role: 'user', parts: [{ functionResponse: { name, response: { answer: 42 } } }] },
  { role: 'model', parts: [{ functionCall: { name: 'other', args: {} } }] },
];

test.each(['lookup', '__proto__'])('Gemini via Chat uses restored call IDs for id-less responses and target-allocated ids for later calls for %s', async name => {
  const codec = createTestSidecarCodec();
  const native = { role: 'assistant' as const, tool_calls: [{ id: 'native-chat-call', type: 'function' as const, function: { name, arguments: '{"query":"docs"}' } }] };
  const carrier = await encodeRoundTripSidecar(codec, { v: 1, source: 'geminiGenerateContent', target: 'openaiChatCompletions', targetTurn: native, sourceTurnDigest: await computeGeminiGenerateContentTurnDigest(targetTurn(name)) });
  const { target: request } = expectTrip(await routeGeminiGenerateContentViaOpenAIChatCompletions({ model: 'model', contents: replayedContents(name, carrier) }, { sidecarCodec: createTestSidecarCodec('test-codec-scope') }));
  expect(request.messages).toEqual([
    { role: 'user', content: 'question' },
    native,
    { role: 'tool', tool_call_id: 'native-chat-call', content: '{"answer":42}' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'other_call_1', type: 'function', function: { name: 'other', arguments: '{}' } }] },
  ]);
});
