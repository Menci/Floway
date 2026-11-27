import { expect, test, vi } from 'vitest';

import type { ToolNameContext } from '../../../../src/composition/request/tool-names.ts';
import { IRAbsent } from '../../../../src/ir/output/absent.ts';
import type { IRRecord } from '../../../../src/ir/output/records.ts';
import { consumeIRRecords } from '../../../../src/ir/output/stream.ts';
import type { IROutput } from '../../../../src/ir/output/types.ts';
import { readGeminiGenerateContentEvents } from '../../../../src/protocols/gemini-generate-content/as-target/events.ts';
import { usageToIR } from '../../../../src/protocols/gemini-generate-content/as-target/usage.ts';
import { referenceAssistantTurn } from '../../../../src/round-trip/reference/reference-selection.ts';
import { createRoundTripReaderCapture } from '../../../round-trip/test-helpers.ts';
import { iterate } from '../../../shared/iterables.ts';
import { doneFrame, eventFrame, FAST_SERVICE_TIER, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

const runReader = async (
  frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>,
  options: Partial<ToolNameContext> & { fallbackModel?: string } = {},
) => {
  const capture = createRoundTripReaderCapture<'geminiGenerateContent'>();
  const records: IRRecord[] = [];
  let state: IROutput | undefined;

  for await (const { record, collector } of consumeIRRecords(
    readGeminiGenerateContentEvents(frames, { ...options, roundTrip: capture.roundTrip }),
  )) {
    records.push(record);
    state = collector.state;
  }

  if (state === undefined) throw new Error('Expected at least one output IR record');
  return { records, state, turns: capture.turns, builder: capture.builder };
};

test('streams merged plain text deltas, Unicode grounding citations, logprobs, and usage', async () => {
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
        finishMessage: 'Normal stop message must not become refusal_details.',
      }],
      usageMetadata: {
        promptTokenCount: 10,
        toolUsePromptTokenCount: 2,
        cachedContentTokenCount: 4,
        candidatesTokenCount: 3,
        thoughtsTokenCount: 1,
        totalTokenCount: 16,
        serviceTier: FAST_SERVICE_TIER,
        promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 4 }, { modality: 'IMAGE', tokenCount: 4 }, { modality: 'TEXT', tokenCount: 2 }],
        toolUsePromptTokensDetails: [{ modality: 'TEXT', tokenCount: 2 }],
        candidatesTokensDetails: [{ modality: 'AUDIO', tokenCount: 1 }, { modality: 'TEXT', tokenCount: 2 }],
      },
    }),
  ]));

  expect(state.model).toBe('gemini-2.5-pro');
  expect(state.service_tier).toBe('fast');
  expect(state.choices[0]?.refusal_details).toBeUndefined();
  expect(state.choices[0]?.items).toEqual([{
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
  }]);
  expect(state.choices[0]?.logprobs).toEqual([{
    scope: 'choice',
    tokens: [{
      token: 'Hello',
      logprob: -0.1,
      top_logprobs: [{ token: 'Hello', logprob: -0.1 }, { token: 'Hi', logprob: -2.3 }],
    }],
  }]);
  expect(state.usage).toEqual({
    input_tokens_inclusive: 12,
    cached_input_tokens: 4,
    output_tokens_inclusive: 4,
    reasoning_tokens: 1,
    total_tokens: 16,
    input_audio_tokens: 4,
    input_image_tokens: 4,
    input_text_tokens: 4,
    output_audio_tokens: 1,
    output_text_tokens: 2,
  });
  expect(records).toContainEqual({ type: 'choice_end', choice: 0, finish_reason: 'stop' });
  expect(records.at(-1)).toEqual({ type: 'finish', status: 'completed' });
  expect(turns.get(0)?.turn).toEqual([{
    role: 'model',
    parts: [
      { text: 'Hello 🌍!' },
      { text: '', thoughtSignature: 'sig_after_text' },
    ],
  }]);
});

test('maps grounding citations across thought chunks, thoughtSignature chunks, retrievedContext, closed parts, and out-of-range UTF-8 offsets', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    // 1. Multiple thought chunks + visible text split across thoughtSignature + retrievedContext + cumulative snapshots.
    const { state, turns } = await runReader(iterate([
      eventFrame({
        modelVersion: 'gemini-2.5-pro',
        candidates: [{
          index: 0,
          content: {
            role: 'model',
            parts: [
              { thought: true, text: 'Step 1. ' },
              // Empty visible text with thoughtSignature must not split the open reasoning block.
              { text: '', thoughtSignature: 'sig_mid_thought' },
              { thought: true, text: 'Step 2.' },
            ],
          },
          finishReason: 'FINISH_REASON_UNSPECIFIED',
        }],
      }),
      eventFrame({
        modelVersion: 'gemini-2.5-pro',
        candidates: [{
          index: 0,
          content: { role: 'model', parts: [{ text: 'Paris is ' }] },
          finishReason: '' as never,
          groundingMetadata: {
            groundingChunks: [{ web: { uri: 'https://example.com/paris', title: 'Paris' } }],
            // Omitted Proto3 partIndex resolves to the first visible text segment even after thought chunks.
            groundingSupports: [{ segment: { endIndex: 5 }, groundingChunkIndices: [0] }],
          },
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
              { retrievedContext: { uri: 'gs://docs/guide.pdf', title: 'Guide', text: 'France facts', pageNumber: 3 } },
              { retrievedContext: { text: 'Inline snippet', pageNumber: 0 } },
              { retrievedContext: {} },
            ],
            groundingSupports: [
              // Repeated snapshot entry is deduplicated without reordering.
              { segment: { endIndex: 5 }, groundingChunkIndices: [0] },
              // Native part index 4 ("in France.") with range 3..9 ("France") maps to UTF-16 12..18.
              { segment: { partIndex: 4, startIndex: 3, endIndex: 9 }, groundingChunkIndices: [1] },
              // Out-of-bounds endIndex clamps with warning; mid-char or empty retrievedContext ignored safely.
              { segment: { partIndex: 4, startIndex: 3, endIndex: 99 }, groundingChunkIndices: [2, 3] },
            ],
          },
          finishReason: 'STOP',
        }],
      }),
    ]));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(state.choices[0]?.items).toEqual([
      { type: 'reasoning', summary: ['Step 1. Step 2.'] },
      {
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
              source_kind: 'document',
              source: 'gs://docs/guide.pdf',
              source_label: 'Guide',
              source_text: 'France facts',
              source_page_range: { start_one_based: 3, end_one_based_exclusive: 4 },
              output_text_range: { start: 12, end_exclusive: 18 },
            },
            {
              type: 'source_citation',
              source_kind: 'document',
              source_text: 'Inline snippet',
              output_text_range: { start: 12, end_exclusive: 19 },
            },
          ],
        }],
      },
    ]);
    expect(turns.get(0)?.turn[0]?.parts?.slice(-2)).toEqual([
      { text: 'Paris is ' },
      { text: 'in France.', thoughtSignature: 'sig_tail' },
    ]);

    // 2. Late grounding on a closed text part warns and drops safely; mid-character UTF-8 split warns and omits range.
    warn.mockClear();
    const closedPart = await runReader(iterate([
      eventFrame({
        modelVersion: 'gemini-2.5-pro',
        candidates: [{
          index: 0,
          content: {
            role: 'model',
            parts: [
              { text: 'Checking docs.' },
              { functionCall: { id: 'call_1', name: 'lookup', args: { q: 'x' } } },
              { text: '🌍' },
            ],
          },
          groundingMetadata: {
            groundingChunks: [{ web: { uri: 'https://example.com/doc', title: 'Doc' } }],
            groundingSupports: [
              { segment: { partIndex: 0, startIndex: 0, endIndex: 8 }, groundingChunkIndices: [0] },
              { segment: { partIndex: 2, startIndex: 1, endIndex: 4 }, groundingChunkIndices: [0] },
            ],
          },
          finishReason: 'STOP',
        }],
      }),
    ]));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(closedPart.state.choices[0]?.items[0]).toEqual({
      type: 'message',
      content: [{ type: 'text', text: 'Checking docs.' }],
    });
    expect(closedPart.state.choices[0]?.items[2]).toEqual({
      type: 'message',
      content: [{
        type: 'text',
        text: '🌍',
        annotations: [{ type: 'source_citation', source_kind: 'url', source: 'https://example.com/doc', source_label: 'Doc' }],
      }],
    });
  } finally {
    warn.mockRestore();
  }
});

test('preserves thought parts, IRAbsent id-less calls, grouped namespaces, custom tools, and thin-reference safety when args are omitted', async () => {
  const { records, state, turns, builder } = await runReader(
    iterate([
      eventFrame({
        modelVersion: 'gemini-2.5-pro',
        candidates: [{
          index: 0,
          content: {
            role: 'model',
            parts: [
              { thought: true, text: 'Plan.' },
              { functionCall: { name: 'get_weather', args: { city: 'Tokyo' } }, thoughtSignature: 'sig_on_call' },
              { functionCall: { name: 'ping' } },
              { functionCall: { id: 'call_explicit_1', name: 'web__search', args: { query: 'Floway' } } },
              { functionCall: { id: 'call_custom_1', name: 'apply_patch', args: { input: '*** Begin Patch' } } },
              { text: 'Checking...' },
              { thoughtSignature: 'sig_standalone' },
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
    { type: 'reasoning', summary: ['Plan.'] },
    { type: 'function_call', call_id: IRAbsent, name: 'get_weather', arguments: '{"city":"Tokyo"}' },
    { type: 'function_call', call_id: IRAbsent, name: 'ping', arguments: '{}' },
    { type: 'function_call', call_id: 'call_explicit_1', namespace: 'web', name: 'search', arguments: '{"query":"Floway"}' },
    { type: 'custom_tool_call', call_id: 'call_custom_1', name: 'apply_patch', input: '*** Begin Patch' },
    { type: 'message', content: [{ type: 'text', text: 'Checking...' }] },
  ]);
  expect(records).toContainEqual({ type: 'choice_end', choice: 0, finish_reason: 'tool_calls' });

  const captured = turns.get(0);
  if (captured === undefined) throw new Error('Expected captured native turn');
  expect('id' in (captured.turn[0].parts![1].functionCall!)).toBe(false);
  expect('args' in (captured.turn[0].parts![2].functionCall!)).toBe(false);
  await expect(referenceAssistantTurn<'geminiGenerateContent'>(
    captured.turn,
    captured.fieldState,
    builder,
    new Map(),
  )).resolves.toEqual({ targetTurn: captured.turn });
});

test('handles multi-candidate streaming, ended-candidate filtering, prototype finishReason, fallbackModel updates, and media inlineData', async () => {
  const { records, state, turns } = await runReader(iterate([
    eventFrame({
      promptFeedback: { blockReason: 'BLOCK_REASON_UNSPECIFIED' },
      candidates: [
        {
          index: 2,
          content: {
            role: 'model',
            parts: [
              { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0=' } },
              { inlineData: { mimeType: 'IMAGE/PNG', data: 'aW1n' } },
              { inlineData: { mimeType: 'audio/wav', data: 'YXVk' }, audioTranscription: { text: 'spoken' } },
            ],
          },
          logprobsResult: { chosenCandidates: [{ token: 'A', logProbability: -0.2 }] },
        },
        {
          index: 0,
          content: { role: 'model', parts: [{ text: 'short' }] },
          finishReason: 'MAX_TOKENS',
        },
        // Duplicate index 0 in same frame after it already ended must be ignored cleanly.
        {
          index: 0,
          content: { role: 'model', parts: [{ text: 'late' }] },
        },
      ],
    }),
    eventFrame({
      modelVersion: 'gemini-2.5-flash-002',
      candidates: [{
        index: 2,
        logprobsResult: { chosenCandidates: [{ token: 'B', logProbability: -0.4 }] },
        finishReason: 'toString' as never,
      }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 9, totalTokenCount: 14, serviceTier: 'standard' },
    }),
    doneFrame(),
  ]), { fallbackModel: 'gemini-2.5-flash' });

  expect(state.model).toBe('gemini-2.5-flash-002');
  expect(state.service_tier).toBe('default');
  expect(state.choices).toHaveLength(2);
  expect(state.choices[0]?.items).toEqual([{
    type: 'message',
    content: [
      { type: 'image', image: { media_type: 'IMAGE/PNG', data: 'aW1n' } },
      { type: 'audio', audio: { media_type: 'audio/wav', data: 'YXVk', transcript: 'spoken' } },
    ],
  }]);
  expect(state.choices[0]?.logprobs).toEqual([{
    scope: 'choice',
    tokens: [
      { token: 'A', logprob: -0.2 },
      { token: 'B', logprob: -0.4 },
    ],
  }]);
  expect(state.choices[1]?.items).toEqual([{ type: 'message', content: [{ type: 'text', text: 'short' }] }]);
  expect(turns.get(0)?.turn[0]?.parts).toHaveLength(3);
  expect(turns.get(0)?.fieldState[0]?.parts?.[0]).toBeUndefined();
  expect(turns.get(0)?.fieldState[0]?.parts?.[1]).toBeUndefined();
  expect(records).toContainEqual({ type: 'choice_end', choice: 0, finish_reason: 'stop' });
  expect(records).toContainEqual({ type: 'choice_end', choice: 1, finish_reason: 'length' });
  expect(records.at(-1)).toEqual({ type: 'finish', status: 'incomplete' });
});

test('maps safety refusal_details, promptFeedback blocking with open choices, failed output reasons, and error frames', async () => {
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

  // Prompt block arriving while a candidate is already open closes it cleanly before finish.
  const blockedWhileOpen = await runReader(iterate([
    eventFrame({
      modelVersion: 'gemini-2.5-pro',
      candidates: [{ index: 1, content: { role: 'model', parts: [{ text: 'partial' }] } }],
    }),
    eventFrame({
      modelVersion: 'gemini-2.5-pro',
      promptFeedback: { blockReason: 'PROHIBITED_CONTENT', blockReasonMessage: 'Policy block.' },
    }),
  ]));
  expect(blockedWhileOpen.state.choices[0]?.refusal_details).toEqual({
    category: 'PROHIBITED_CONTENT',
    explanation: 'Policy block.',
  });
  expect(blockedWhileOpen.records).toContainEqual({ type: 'choice_end', choice: 0, finish_reason: 'content_filter' });
  expect(blockedWhileOpen.records.at(-1)).toEqual({ type: 'finish', status: 'completed' });

  // Eager failed finish on an empty first candidate emits an error without opening a choice or trailing ': '.
  const malformed = await runReader(iterate([
    eventFrame({
      modelVersion: 'gemini-2.5-pro',
      candidates: [{ index: 0, content: { role: 'model', parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL', finishMessage: '' }],
    }),
  ]));
  expect(malformed.state.choices).toEqual([]);
  expect(malformed.records.at(-1)).toEqual({
    type: 'error',
    error: { type: 'server_error', code: 'MALFORMED_FUNCTION_CALL', message: 'Gemini ended the response with MALFORMED_FUNCTION_CALL' },
  });

  const beforeCandidateError = await runReader(iterate([
    eventFrame({ modelVersion: 'gemini-2.5-flash', usageMetadata: { promptTokenCount: 4 } }),
    eventFrame({ error: { code: 503, message: 'Unavailable', status: 'UNAVAILABLE' } }),
  ]));
  expect(beforeCandidateError.state.choices).toEqual([]);
  expect(beforeCandidateError.records.at(-1)).toEqual({
    type: 'error',
    error: {
      type: 'overloaded_error',
      message: 'Unavailable',
      provider_specific_fields: { code: 503, status: 'UNAVAILABLE' },
    },
  });

  await expect(runReader(iterate([
    eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'no model' }] }, finishReason: 'STOP' }] }),
  ]))).rejects.toThrow(TypeError);

  expect(() => usageToIR({ promptTokenCount: 4, cachedContentTokenCount: 5 })).toThrow(RangeError);
});
