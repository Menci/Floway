import { expect, test, vi } from 'vitest';

import type { ToolNameContext } from '../../../../src/composition/request/tool-names.ts';
import { IRAbsent } from '../../../../src/ir/output/absent.ts';
import type { IRRecord } from '../../../../src/ir/output/records.ts';
import { consumeIRRecords } from '../../../../src/ir/output/stream.ts';
import type { IROutput } from '../../../../src/ir/output/types.ts';
import type { GeminiGenerateContentInputAssistantTurn } from '../../../../src/protocols/gemini-generate-content/as-target/assistant-turn.ts';
import { readGeminiGenerateContentEvents } from '../../../../src/protocols/gemini-generate-content/as-target/events.ts';
import { usageToIR } from '../../../../src/protocols/gemini-generate-content/as-target/usage.ts';
import { createReferenceBuilder, type ReadFieldStates } from '../../../../src/round-trip/reference/reference-builder.ts';
import { referenceAssistantTurn } from '../../../../src/round-trip/reference/reference-selection.ts';
import { iterate } from '../../../shared/iterables.ts';
import { doneFrame, eventFrame, FAST_SERVICE_TIER, type ProtocolFrame } from '@floway-dev/protocols/common';
import {
  GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE,
  type GeminiGenerateContentStreamEvent,
} from '@floway-dev/protocols/gemini-generate-content';

const runReader = async (
  frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>,
  options: Partial<ToolNameContext> & { fallbackModel?: string } = {},
): Promise<{
  records: IRRecord[];
  state: IROutput;
  turns: Map<number, GeminiGenerateContentInputAssistantTurn>;
  fieldStates: Map<number, unknown>;
  idlessCallItemIndices: Map<number, readonly number[] | undefined>;
  builder: ReturnType<typeof createReferenceBuilder>;
}> => {
  const builder = createReferenceBuilder();
  const turns = new Map<number, GeminiGenerateContentInputAssistantTurn>();
  const fieldStates = new Map<number, unknown>();
  const idlessCallItemIndices = new Map<number, readonly number[] | undefined>();
  const records: IRRecord[] = [];
  let finalState: IROutput | undefined;

  for await (const { record, collector } of consumeIRRecords(
    readGeminiGenerateContentEvents(frames, {
      ...options,
      roundTrip: {
        builder,
        onAssistantTurn: (choice, turn, fieldState, idlessIndices) => {
          turns.set(choice, turn);
          fieldStates.set(choice, fieldState);
          idlessCallItemIndices.set(choice, idlessIndices);
        },
      },
    }),
  )) {
    records.push(record);
    finalState = collector.state;
  }

  if (finalState === undefined) throw new Error('Expected at least one output IR record');
  return { records, state: finalState, turns, fieldStates, idlessCallItemIndices, builder };
};

test('streams merged plain text deltas (including empty mergeable chunks), Unicode, grounding citations after trailing signature carriers, logprobs, and usage', async () => {
  const { records, state, turns } = await runReader(iterate([
    eventFrame({
      responseId: 'resp_text',
      modelVersion: 'gemini-2.5-pro',
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Hello ' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1, totalTokenCount: 11 },
    }),
    eventFrame({
      responseId: 'resp_text',
      modelVersion: 'gemini-2.5-pro',
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '' }] } }],
    }),
    eventFrame({
      responseId: 'resp_text',
      modelVersion: 'gemini-2.5-pro',
      candidates: [{
        index: 0,
        content: {
          role: 'model',
          parts: [
            { text: '🌍!' },
            { text: '', thoughtSignature: 'sig_after_text' },
          ],
        },
        groundingMetadata: {
          groundingChunks: [{ web: { uri: 'https://example.com/earth', title: 'Earth' } }],
          // "Hello " is 6 UTF-8 bytes; "🌍" is 4 UTF-8 bytes (2 UTF-16 code units).
          groundingSupports: [{ segment: { partIndex: 0, startIndex: 6, endIndex: 10 }, groundingChunkIndices: [0] }],
        },
        logprobsResult: {
          chosenCandidates: [{ token: 'Hello', logProbability: -0.1 }],
          topCandidates: [{ candidates: [{ token: 'Hello', logProbability: -0.1 }, { token: 'Hi', logProbability: -2.3 }] }],
        },
        finishReason: 'STOP',
      }],
      usageMetadata: {
        promptTokenCount: 10,
        cachedContentTokenCount: 4,
        candidatesTokenCount: 3,
        totalTokenCount: 13,
        serviceTier: FAST_SERVICE_TIER,
        promptTokensDetails: [{ modality: 'TEXT', tokenCount: 10 }],
        candidatesTokensDetails: [{ modality: 'TEXT', tokenCount: 3 }],
      },
    }),
  ]));

  expect(state.model).toBe('gemini-2.5-pro');
  expect(state.service_tier).toBe('fast');
  expect(state.choices[0]?.items).toEqual([
    {
      type: 'message',
      content: [{
        type: 'text',
        text: 'Hello 🌍!',
        annotations: [{
          type: 'source_citation',
          source_kind: 'url',
          source: 'https://example.com/earth',
          source_label: 'Earth',
          output_text_range: { start: 6, end_exclusive: 8 },
        }],
      }],
    },
  ]);
  expect(state.choices[0]?.logprobs).toEqual([{
    scope: 'choice',
    tokens: [{
      token: 'Hello',
      logprob: -0.1,
      top_logprobs: [{ token: 'Hello', logprob: -0.1 }, { token: 'Hi', logprob: -2.3 }],
    }],
  }]);
  expect(state.usage).toEqual({
    input_tokens_inclusive: 10,
    cached_input_tokens: 4,
    output_tokens_inclusive: 3,
    total_tokens: 13,
    input_text_tokens: 10,
    output_text_tokens: 3,
  });
  expect(records).toContainEqual({ type: 'choice_end', choice: 0, finish_reason: 'stop' });
  expect(records.at(-1)).toEqual({ type: 'finish', status: 'completed' });
  expect(turns.get(0)).toEqual([
    {
      role: 'model',
      parts: [
        { text: 'Hello 🌍!' },
        { text: '', thoughtSignature: 'sig_after_text' },
      ],
    },
  ]);
});

test('drops late grounding citations safely with a warning when a prior message part was closed by a tool call', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const { state } = await runReader(iterate([
      eventFrame({
        modelVersion: 'gemini-2.5-pro',
        candidates: [{
          index: 0,
          content: {
            role: 'model',
            parts: [
              { text: 'Checking docs.' },
              { functionCall: { id: 'call_1', name: 'lookup', args: { q: 'x' } } },
            ],
          },
          groundingMetadata: {
            groundingChunks: [{ web: { uri: 'https://example.com/doc', title: 'Doc' } }],
            groundingSupports: [{ segment: { partIndex: 0, startIndex: 0, endIndex: 8 }, groundingChunkIndices: [0] }],
          },
          finishReason: 'STOP',
        }],
      }),
    ]));

    expect(state.choices[0]?.items[0]).toEqual({
      type: 'message',
      content: [{ type: 'text', text: 'Checking docs.' }],
    });
  } finally {
    warn.mockRestore();
  }
});

test('preserves thought parts, thoughtSignature, IRAbsent id-less calls, and thin-reference safety when functionCall.args is omitted', async () => {
  const { records, state, turns, fieldStates, idlessCallItemIndices, builder } = await runReader(iterate([
    eventFrame({
      modelVersion: 'gemini-2.5-pro',
      candidates: [{
        index: 0,
        content: {
          role: 'model',
          parts: [
            { thought: true, text: 'First step. ' },
            { thought: true, text: 'Second step.', thoughtSignature: 'sig_on_thought' },
          ],
        },
      }],
    }),
    eventFrame({
      modelVersion: 'gemini-2.5-pro',
      candidates: [{
        index: 0,
        content: {
          role: 'model',
          parts: [
            { functionCall: { name: 'get_weather', args: { city: 'Tokyo' } }, thoughtSignature: 'sig_on_call' },
            { functionCall: { name: 'ping' } },
            { text: 'Checking...' },
            { text: '', thoughtSignature: 'sig_on_empty_text' },
            { thoughtSignature: 'sig_standalone' },
          ],
        },
        finishReason: 'STOP',
      }],
      usageMetadata: {
        promptTokenCount: 20,
        toolUsePromptTokenCount: 5,
        candidatesTokenCount: 8,
        thoughtsTokenCount: 15,
        totalTokenCount: 48,
      },
    }),
  ]));

  const weatherCall = state.choices[0]?.items[1];
  const pingCall = state.choices[0]?.items[2];
  if (weatherCall?.type !== 'function_call' || pingCall?.type !== 'function_call') {
    throw new Error('Expected function_call items');
  }
  expect(weatherCall.call_id).toBe(IRAbsent);
  expect(pingCall.call_id).toBe(IRAbsent);
  expect(pingCall.arguments).toBe('{}');
  expect(idlessCallItemIndices.get(0)).toEqual([1, 2]);
  expect(state.choices[0]?.items).toEqual([
    { type: 'reasoning', summary: ['First step. Second step.'] },
    weatherCall,
    pingCall,
    { type: 'message', content: [{ type: 'text', text: 'Checking...' }] },
  ]);
  expect(state.usage).toEqual({
    input_tokens_inclusive: 25,
    output_tokens_inclusive: 23,
    reasoning_tokens: 15,
    total_tokens: 48,
  });
  expect(records).toContainEqual({ type: 'choice_end', choice: 0, finish_reason: 'tool_calls' });

  const nativeTurn = turns.get(0);
  if (nativeTurn === undefined) throw new Error('Expected native turn');
  expect('id' in (nativeTurn[0].parts![2].functionCall!)).toBe(false);
  expect('args' in (nativeTurn[0].parts![3].functionCall!)).toBe(false);
  expect('syntheticCallIds' in nativeTurn[0]).toBe(false);

  const fieldState = fieldStates.get(0) as [{ parts: ReadFieldStates[] }];
  await expect(referenceAssistantTurn<'geminiGenerateContent'>(
    nativeTurn,
    fieldState as never,
    builder,
    new Map(),
  )).resolves.toEqual({ targetTurn: nativeTurn });
});

test('restores grouped tool namespaces and unwraps customToolNames calls', async () => {
  const { state, idlessCallItemIndices } = await runReader(
    iterate([
      eventFrame({
        modelVersion: 'gemini-2.5-flash',
        candidates: [{
          index: 0,
          content: {
            role: 'model',
            parts: [
              { functionCall: { id: 'call_explicit_1', name: 'web__search', args: { query: 'floway' } } },
              { functionCall: { id: 'call_custom_1', name: 'apply_patch', args: { input: '*** Begin Patch' } } },
            ],
          },
          finishReason: 'STOP',
        }],
      }),
    ]),
    {
      customToolNames: new Set(['apply_patch']),
      originalToolNames: new Map([['web__search', { namespace: 'web', name: 'search' }]]),
    },
  );

  expect(state.choices[0]?.items).toEqual([
    { type: 'function_call', call_id: 'call_explicit_1', namespace: 'web', name: 'search', arguments: '{"query":"floway"}' },
    { type: 'custom_tool_call', call_id: 'call_custom_1', name: 'apply_patch', input: '*** Begin Patch' },
  ]);
  expect(idlessCallItemIndices.get(0)).toBeUndefined();
});

test('maps MAX_TOKENS, safety refusal_details, promptFeedback.blockReason, inlineData media, and failed output reasons', async () => {
  const maxTokens = await runReader(iterate([
    eventFrame({
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'truncated' }] }, finishReason: 'MAX_TOKENS' }],
    }),
    eventFrame({
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 9, totalTokenCount: 14, serviceTier: 'standard' },
    }),
    doneFrame(),
  ]), { fallbackModel: 'gemini-2.5-flash' });

  expect(maxTokens.state.model).toBe('gemini-2.5-flash');
  expect(maxTokens.state.service_tier).toBe('default');
  expect(maxTokens.records).toContainEqual({ type: 'choice_end', choice: 0, finish_reason: 'length' });
  expect(maxTokens.records.at(-1)).toEqual({ type: 'finish', status: 'incomplete' });

  const safety = await runReader(iterate([
    eventFrame({
      modelVersion: 'gemini-2.5-pro',
      candidates: [{ index: 0, finishReason: 'SAFETY', finishMessage: 'Blocked by safety policy.' }],
    }),
  ]));
  expect(safety.state.choices[0]?.refusal_details).toEqual({
    category: 'SAFETY',
    explanation: 'Blocked by safety policy.',
  });

  const blocked = await runReader(iterate([
    eventFrame({
      modelVersion: 'gemini-2.5-pro',
      promptFeedback: { blockReason: 'PROHIBITED_CONTENT' },
    }),
  ]));
  expect(blocked.state.choices[0]?.refusal_details).toEqual({
    category: 'PROHIBITED_CONTENT',
    explanation: null,
  });
  expect(blocked.records).toContainEqual({ type: 'choice_end', choice: 0, finish_reason: 'content_filter' });

  const media = await runReader(iterate([
    eventFrame({
      modelVersion: 'gemini-2.5-flash',
      candidates: [{
        index: 0,
        content: {
          role: 'model',
          parts: [
            { inlineData: { mimeType: 'image/png', data: 'aW1n' } },
            { inlineData: { mimeType: 'audio/wav', data: 'YXVk' }, audioTranscription: { text: 'spoken' } },
          ],
        },
        finishReason: 'STOP',
      }],
    }),
  ]));
  expect(media.state.choices[0]?.items).toEqual([{
    type: 'message',
    content: [
      { type: 'image', image: { media_type: 'image/png', data: 'aW1n' } },
      { type: 'audio', audio: { media_type: 'audio/wav', data: 'YXVk', transcript: 'spoken' } },
    ],
  }]);

  expect(usageToIR({
    promptTokenCount: 12,
    toolUsePromptTokenCount: 3,
    cachedContentTokenCount: 5,
    candidatesTokenCount: 7,
    thoughtsTokenCount: 3,
    totalTokenCount: 25,
    promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 4 }, { modality: 'IMAGE', tokenCount: 6 }, { modality: 'TEXT', tokenCount: 2 }],
    toolUsePromptTokensDetails: [{ modality: 'TEXT', tokenCount: 3 }],
    candidatesTokensDetails: [{ modality: 'AUDIO', tokenCount: 2 }, { modality: 'TEXT', tokenCount: 5 }],
  })).toEqual({
    input_tokens_inclusive: 15,
    cached_input_tokens: 5,
    output_tokens_inclusive: 10,
    reasoning_tokens: 3,
    total_tokens: 25,
    input_audio_tokens: 4,
    input_image_tokens: 6,
    input_text_tokens: 5,
    output_audio_tokens: 2,
    output_text_tokens: 5,
  });

  const malformed: IRRecord[] = [];
  for await (const record of readGeminiGenerateContentEvents(iterate([
    eventFrame({
      modelVersion: 'gemini-2.5-pro',
      candidates: [{ index: 0, content: { role: 'model', parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL', finishMessage: 'bad args' }],
    }),
  ]), { roundTrip: { builder: createReferenceBuilder(), onAssistantTurn: () => {} } })) {
    malformed.push(record);
  }
  expect(malformed.at(-1)).toEqual({
    type: 'error',
    error: { type: 'server_error', code: 'MALFORMED_FUNCTION_CALL', message: 'Gemini ended the response with MALFORMED_FUNCTION_CALL: bad args' },
  });

  await expect(runReader(iterate([
    eventFrame({ modelVersion: 'gemini-2.5-pro', candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'unfinished' }] } }] }),
  ]))).rejects.toThrow(GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE);
});

test('handles omitted Proto3 startIndex, non-terminal finishReason chunks, empty thought signature carriers before grounding, cumulative grounding, and blockReasonMessage', async () => {
  const { records, state } = await runReader(iterate([
    eventFrame({
      modelVersion: 'gemini-2.5-pro',
      candidates: [{
        index: 0,
        content: { role: 'model', parts: [{ text: 'Hello ' }] },
        finishReason: 'FINISH_REASON_UNSPECIFIED',
        groundingMetadata: {
          groundingChunks: [{ web: { uri: 'https://example.com/1', title: 'One' } }],
          groundingSupports: [{ segment: { partIndex: 0, endIndex: 5 }, groundingChunkIndices: [0] }],
        },
      }],
    }),
    eventFrame({
      modelVersion: 'gemini-2.5-pro',
      candidates: [{
        index: 0,
        content: {
          role: 'model',
          parts: [
            { text: 'world' },
            { text: '', thought: true, thoughtSignature: 'sig_empty_thought' },
          ],
        },
        finishReason: '' as never,
        groundingMetadata: {
          groundingChunks: [
            { web: { uri: 'https://example.com/1', title: 'One' } },
            { web: { uri: 'https://example.com/2', title: 'Two' } },
          ],
          groundingSupports: [
            { segment: { partIndex: 0, endIndex: 5 }, groundingChunkIndices: [0] },
            { segment: { partIndex: 0, startIndex: 6, endIndex: 11 }, groundingChunkIndices: [1] },
          ],
        },
      }],
    }),
    eventFrame({
      modelVersion: 'gemini-2.5-pro',
      candidates: [{
        index: 0,
        content: {
          role: 'model',
          parts: [{ text: '!' }],
        },
        groundingMetadata: {
          groundingChunks: [{ web: { uri: 'https://example.com/3', title: 'Three' } }],
          groundingSupports: [{ segment: { partIndex: 2, endIndex: 1 }, groundingChunkIndices: [0] }],
        },
        finishReason: 'STOP',
      }],
    }),
  ]));

  expect(records).toContainEqual({ type: 'choice_end', choice: 0, finish_reason: 'stop' });
  expect(state.choices[0]?.items).toEqual([{
    type: 'message',
    content: [
      {
        type: 'text',
        text: 'Hello world!',
        annotations: [
          {
            type: 'source_citation',
            source_kind: 'url',
            source: 'https://example.com/1',
            source_label: 'One',
            output_text_range: { start: 0, end_exclusive: 5 },
          },
          {
            type: 'source_citation',
            source_kind: 'url',
            source: 'https://example.com/2',
            source_label: 'Two',
            output_text_range: { start: 6, end_exclusive: 11 },
          },
          {
            type: 'source_citation',
            source_kind: 'url',
            source: 'https://example.com/3',
            source_label: 'Three',
            output_text_range: { start: 11, end_exclusive: 12 },
          },
        ],
      },
    ],
  }]);

  const blockedWithMessage = await runReader(iterate([
    eventFrame({
      modelVersion: 'gemini-2.5-pro',
      promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: 'Blocked due to policy details.' },
    }),
  ]));
  expect(blockedWithMessage.state.choices[0]?.refusal_details).toEqual({
    category: 'SAFETY',
    explanation: 'Blocked due to policy details.',
  });
});

test('keeps consecutive visible text across thoughtSignature chunks in one IR text part with accurate grounding ranges', async () => {
  const { state, turns } = await runReader(iterate([
    eventFrame({
      modelVersion: 'gemini-2.5-pro',
      candidates: [{
        index: 0,
        content: { role: 'model', parts: [{ text: 'Paris is ' }] },
      }],
    }),
    eventFrame({
      modelVersion: 'gemini-2.5-pro',
      candidates: [{
        index: 0,
        content: { role: 'model', parts: [{ text: 'in France.', thoughtSignature: 'sig_tail' }] },
        groundingMetadata: {
          groundingChunks: [
            { web: { uri: 'https://example.com/paris', title: 'Paris' } },
            { web: { uri: 'https://example.com/france', title: 'France' } },
          ],
          groundingSupports: [
            { segment: { partIndex: 0, startIndex: 0, endIndex: 5 }, groundingChunkIndices: [0] },
            { segment: { partIndex: 1, startIndex: 3, endIndex: 9 }, groundingChunkIndices: [1] },
          ],
        },
        finishReason: 'STOP',
      }],
    }),
  ]));

  expect(state.choices[0]?.items).toEqual([{
    type: 'message',
    content: [{
      type: 'text',
      text: 'Paris is in France.',
      annotations: [
        {
          type: 'source_citation',
          source_kind: 'url',
          source: 'https://example.com/paris',
          source_label: 'Paris',
          output_text_range: { start: 0, end_exclusive: 5 },
        },
        {
          type: 'source_citation',
          source_kind: 'url',
          source: 'https://example.com/france',
          source_label: 'France',
          output_text_range: { start: 12, end_exclusive: 18 },
        },
      ],
    }],
  }]);
  expect(turns.get(0)).toEqual([{
    role: 'model',
    parts: [
      { text: 'Paris is ' },
      { text: 'in France.', thoughtSignature: 'sig_tail' },
    ],
  }]);
});

test('treats non-image/non-audio inlineData as Output IR no-op, opens choices lazily, and accumulates streaming logprobs into one choice group', async () => {
  const beforeCandidateError = await runReader(iterate([
    eventFrame({
      modelVersion: 'gemini-2.5-flash',
      usageMetadata: { promptTokenCount: 4 },
    }),
    eventFrame({
      error: { code: 503, message: 'Unavailable', status: 'UNAVAILABLE' },
    }),
  ]));
  expect(beforeCandidateError.state.choices).toEqual([]);

  const { state, turns, fieldStates } = await runReader(iterate([
    eventFrame({
      modelVersion: 'gemini-2.5-flash',
      candidates: [{
        index: 2,
        content: {
          role: 'model',
          parts: [
            { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0=' } },
            { inlineData: { mimeType: 'image/png', data: 'aW1n' } },
          ],
        },
        logprobsResult: {
          chosenCandidates: [{ token: 'A', logProbability: -0.2 }],
        },
      }],
    }),
    eventFrame({
      modelVersion: 'gemini-2.5-flash',
      candidates: [{
        index: 2,
        logprobsResult: {
          chosenCandidates: [{ token: 'B', logProbability: -0.4 }],
        },
        finishReason: 'STOP',
      }],
    }),
  ]));

  expect(state.choices).toHaveLength(1);
  expect(state.choices[0]?.items).toEqual([{
    type: 'message',
    content: [{ type: 'image', image: { media_type: 'image/png', data: 'aW1n' } }],
  }]);
  expect(state.choices[0]?.logprobs).toEqual([{
    scope: 'choice',
    tokens: [
      { token: 'A', logprob: -0.2 },
      { token: 'B', logprob: -0.4 },
    ],
  }]);
  expect(turns.get(0)?.[0]?.parts).toEqual([
    { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0=' } },
    { inlineData: { mimeType: 'image/png', data: 'aW1n' } },
  ]);
  const states = fieldStates.get(0) as [{ parts: unknown[] }];
  expect(states[0].parts[0]).toBeUndefined();
  expect(states[0].parts[1]).toBeUndefined();
});
