import { describe, expect, it } from 'vitest';

import {
  verifyAnthropicMessagesReplayCheck,
  verifyGeminiGenerateContentReplayCheck,
  verifyOpenAIResponsesReplayCheck,
} from '../../../../src/shared/ir/round-trip/index.ts';
import type { OpenAIResponsesAssistantTurn } from '../../../../src/shared/ir/round-trip/openai-responses.ts';
import type { IRRoundTripWriter } from '../../../../src/shared/ir/round-trip/stream.ts';
import type { IRRoundTripReplayCheck } from '../../../../src/shared/ir/round-trip/types.ts';
import type { IRProjectionResult } from '../../../../src/shared/ir/round-trip-projection.ts';
import { createIRProjection } from '../../../../src/shared/ir/shared/projection.ts';
import { anthropicMessagesFromIR } from '../../../../src/shared/ir/sse-to/anthropic-messages/index.ts';
import { geminiGenerateContentFromIR } from '../../../../src/shared/ir/sse-to/gemini-generatecontent/index.ts';
import { openaiResponsesFromIR } from '../../../../src/shared/ir/sse-to/openai-responses/index.ts';
import { restoreNamespaceEvents, flattenNamespaceTools } from '../../../../src/shared/openai-responses-via/namespace-tools.ts';
import { completeIR, collect, events, iterate } from '../helpers.ts';
import { reassembleAnthropicMessagesEvents, type AnthropicMessagesAssistantMessage } from '@floway-dev/protocols/anthropic-messages';
import { reassembleGeminiGenerateContentEvents } from '@floway-dev/protocols/gemini-generate-content';
import { reassembleOpenAIResponsesEvents } from '@floway-dev/protocols/openai-responses';

const captureRoundTripWriter = () => {
  const prepared: { choice: number; replayCheck: IRRoundTripReplayCheck; projection: IRProjectionResult }[] = [];
  const roundTrip: IRRoundTripWriter = {
    prepareSidecar: async (choice, replayCheck, projection) => {
      prepared.push({ choice, replayCheck, projection });
      return `sidecar-${choice}`;
    },
  };
  return { prepared, roundTrip };
};

const markedPaths = (projection: IRProjectionResult): string[] => projection.projections
  .filter(span => span.round_trip)
  .map(span => JSON.stringify(span.target_path));

describe('Protocol A round-trip writers', () => {
  it('keeps the ordinary projection unchanged and marks only chosen target paths in the round-trip view', () => {
    const projection = createIRProjection();
    projection.append(['source'], 'answer', ['target', 'text']);
    projection.append(['source', 'opaque'], 'signature', ['target', 'signature']);
    projection.markRoundTrip(['target', 'text']);

    expect(projection.result().contents).toEqual([
      { path: ['target', 'text'], text: 'answer' },
      { path: ['target', 'signature'], text: 'signature' },
    ]);
    expect(projection.roundTripResult().projections.map(span => [span.target_path, span.round_trip])).toEqual([
      [['target', 'text'], true],
      [['target', 'signature'], false],
    ]);
  });

  it('writes a Messages carrier after the projected turn and suppresses source signatures', async () => {
    const source = completeIR([
      { type: 'reasoning', summary: ['thinking'], encrypted_content: 'B-native-signature' },
      {
        type: 'message', content: [{
          type: 'text', text: 'answer', annotations: [{
            type: 'source_citation', source_kind: 'search_result', source: null,
            source_text: { text: 'quoted passage', granularity: 'exact_quote' },
          }],
        }],
      },
      { type: 'function_call', name: 'lookup', call_id: 'call', arguments: '{"q":"a","n":1e+09}' },
    ]);
    const { prepared, roundTrip } = captureRoundTripWriter();
    const output = await collect(events(anthropicMessagesFromIR(iterate(source), {
      id: 'target', roundTrip,
      resolveCitation: citation => citation.source_text === undefined ? undefined : {
        type: 'search_result_location', source: 'search-0', title: 'Search result', search_result_index: 0,
        start_block_index: 0, end_block_index: 1, cited_text: citation.source_text.text,
      },
    })));
    const result = await reassembleAnthropicMessagesEvents(iterate(output));
    const turn = [{ role: 'assistant' as const, content: result.content }] as AnthropicMessagesAssistantMessage[];

    expect(result.content).toMatchObject([
      { type: 'thinking', thinking: 'thinking', signature: '' },
      { type: 'text', text: 'answer' },
      { type: 'tool_use', name: 'lookup', input: { q: 'a', n: 1_000_000_000 } },
      { type: 'redacted_thinking', data: 'sidecar-0' },
    ]);
    expect(JSON.stringify(result.content)).not.toContain('B-native-signature');
    expect(await verifyAnthropicMessagesReplayCheck(turn, prepared[0].replayCheck)).toBe(true);
    expect(markedPaths(prepared[0].projection)).toEqual([
      '["content",0,"thinking"]',
      '["content",1,"text"]',
      '["content",1,"citations",0,"cited_text"]',
      '["content",2,"input"]',
    ]);
    expect(prepared[0].projection.contents.find(content => JSON.stringify(content.path) === '["content",2,"input"]')?.text).toBe('{"q":"a","n":1000000000}');
    expect(output.findIndex(event => event.type === 'message_delta')).toBeGreaterThan(output.findIndex(event => event.type === 'content_block_start' && event.content_block.type === 'redacted_thinking'));
  });

  it('checks the namespace-restored Responses body and leaves response-level audio unmarked', async () => {
    const source = completeIR([
      { type: 'reasoning', summary: ['thinking'], encrypted_content: 'B-native-encrypted-content' },
      { type: 'message', content: [{ type: 'text', text: 'answer' }] },
      { type: 'function_call', name: 'files_read', call_id: 'call', arguments: '{"path":"a"}' },
      { type: 'message', content: [{ type: 'audio', audio: { data: 'YQ==', transcript: 'audio transcript' } }] },
    ]);
    const namespaceToolNames = flattenNamespaceTools({
      model: 'model',
      input: [],
      tools: [{ type: 'namespace', name: 'files', description: '', tools: [{ type: 'function', name: 'read' }] }],
    }).names;
    const { prepared, roundTrip } = captureRoundTripWriter();
    const raw = openaiResponsesFromIR(iterate(source), { id: 'target', roundTrip, namespaceToolNames });
    const restored = restoreNamespaceEvents(raw, namespaceToolNames);
    const frames = await collect(restored);
    const result = await reassembleOpenAIResponsesEvents(events(iterate(frames)));

    expect(result.output.at(-1)).toMatchObject({ type: 'reasoning', encrypted_content: 'sidecar-0', summary: [] });
    expect(result.output).toContainEqual(expect.objectContaining({ type: 'function_call', name: 'read', namespace: 'files', arguments: '{"path":"a"}' }));
    expect(JSON.stringify(result.output)).not.toContain('B-native-encrypted-content');
    expect(await verifyOpenAIResponsesReplayCheck(result.output as OpenAIResponsesAssistantTurn, prepared[0].replayCheck)).toBe(true);
    expect(markedPaths(prepared[0].projection)).toContain('["output",0,"summary",0,"text"]');
    expect(prepared[0].projection.contents.find(content => JSON.stringify(content.path) === '["audio","data"]')?.round_trip).toBe(false);
    expect(prepared[0].projection.contents.find(content => JSON.stringify(content.path) === '["audio","transcript"]')?.round_trip).toBe(false);
  });

  it('writes Gemini thought signatures as standalone tail parts and parses tool JSON before replay checking', async () => {
    const source = completeIR([
      { type: 'reasoning', summary: ['thinking'], encrypted_content: 'B-native-thought-signature' },
      { type: 'message', content: [{ type: 'text', text: 'answer' }] },
      { type: 'function_call', name: 'lookup', call_id: 'call', arguments: '{"q":"a","n":1e+09}' },
    ]);
    const { prepared, roundTrip } = captureRoundTripWriter();
    const frames = await collect(geminiGenerateContentFromIR(iterate(source), { id: 'target', roundTrip }));
    const result = await reassembleGeminiGenerateContentEvents(events(iterate(frames)));
    const content = result.candidates?.[0].content;
    if (content === undefined) throw new Error('GenerateContent output is missing its model turn');

    expect(content.parts?.at(-1)).toEqual({ thoughtSignature: 'sidecar-0' });
    expect(content.parts?.find(part => part.functionCall !== undefined)?.functionCall?.args).toEqual({ q: 'a', n: 1_000_000_000 });
    expect(JSON.stringify(content.parts)).not.toContain('B-native-thought-signature');
    expect(await verifyGeminiGenerateContentReplayCheck([content], prepared[0].replayCheck)).toBe(true);
    expect(markedPaths(prepared[0].projection)).toContain('["candidates",0,"content","parts",0,"text"]');
    expect(markedPaths(prepared[0].projection)).toContain('["candidates",0,"content","parts",2,"functionCall","args"]');
    expect(frames.at(-1)?.type).toBe('event');
    expect(frames.slice(0, -1).some(frame => frame.type === 'event' && !('error' in frame.event) && frame.event.candidates?.some(candidate => candidate.content?.parts?.some(part => part.thoughtSignature === 'sidecar-0')))).toBe(true);
  });
});
