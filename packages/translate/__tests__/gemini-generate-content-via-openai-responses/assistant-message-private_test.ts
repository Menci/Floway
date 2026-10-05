import { expect, test } from 'vitest';

import { translateGeminiGenerateContentViaOpenAIResponses } from '../../src/gemini-generate-content-via-openai-responses/translate.ts';
import { privateContext, referencedTextHash } from '../test-utils/assistant-message-private.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import { collectGeminiGenerateContentProtocolEventsToResult } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

const item = { type: 'reasoning' as const, id: 'rs_native', summary: [{ type: 'summary_text' as const, text: 'AB' }], encrypted_content: 'native-cipher' };
const response: OpenAIResponsesResultEx = { id: 'resp', object: 'response', model: 'm', output: [item], status: 'completed', error: null, incomplete_details: null };

test('native reasoning IDs and ciphertext survive replay only through the final authenticated signature', async () => {
  const context = privateContext();
  const trip = await translateGeminiGenerateContentViaOpenAIResponses({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }, { model: 'm', privateContext: context });
  const events: OpenAIResponsesStreamEventEx[] = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, summary: [], encrypted_content: undefined } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: item.id, summary_index: 0, delta: 'A' },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: item.id, summary_index: 0, delta: 'B' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.output_text.delta', output_index: 1, item_id: 'msg', content_index: 0, delta: 'answer' },
    { type: 'response.completed', response },
  ];
  const result = await collectGeminiGenerateContentProtocolEventsToResult(trip.events((async function* () { for (const event of events) yield eventFrame(event); })()));
  const carrier = result.candidates?.[0].content?.parts?.at(-1);
  expect(Object.keys(carrier!)).toEqual(['thoughtSignature']);
  expect(await context.codec.unencapsulate(carrier?.thoughtSignature)).toEqual({ reasoningText: 'AB', sidecar: { upstreamProtocol: 'openaiResponses', thinItems: [{ type: 'reasoning', id: item.id, __summary: [[[0, 2]]], encrypted_content: item.encrypted_content }], referencedTextHash: referencedTextHash('AB') } });
  const replay = await translateGeminiGenerateContentViaOpenAIResponses({ contents: [{ role: 'model', parts: [{ thought: true, text: 'edited' }, { text: 'answer' }, { thoughtSignature: carrier?.thoughtSignature }] }] }, { model: 'm', privateContext: context });
  expect(replay.target.input).toEqual([item, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }]);
});
