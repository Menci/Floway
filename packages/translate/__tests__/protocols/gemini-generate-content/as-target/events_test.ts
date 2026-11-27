import { expect, test, vi } from 'vitest';

import type { ToolNameContext } from '../../../../src/composition/request/tool-names.ts';
import { IRAbsent } from '../../../../src/ir/output/absent.ts';
import type { IRRecord } from '../../../../src/ir/output/records.ts';
import { consumeIRRecords } from '../../../../src/ir/output/stream.ts';
import type { IROutput } from '../../../../src/ir/output/types.ts';
import { readGeminiGenerateContentEvents } from '../../../../src/protocols/gemini-generate-content/as-target/events.ts';
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
  expect(state.service_tier).toBe('priority');
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
              { retrievedContext: { text: 'Inline snippet', pageNumber: 1.5 } },
              { retrievedContext: {} },
            ],
            groundingSupports: [
              // Repeated snapshot entry is deduplicated without reordering (explicit partIndex: 0 matches omitted).
              { segment: { partIndex: 0, endIndex: 5 }, groundingChunkIndices: [0] },
              // Native part index 4 ("in France.") with range 3..9 ("France") maps to UTF-16 12..18.
              { segment: { partIndex: 4, startIndex: 3, endIndex: 9 }, groundingChunkIndices: [1] },
              // Merged logical part index 1 ("Paris is in France.") spans across the thoughtSignature split (0..19).
              { segment: { partIndex: 1, startIndex: 0, endIndex: 19, text: 'Paris is in France.' }, groundingChunkIndices: [0] },
              // Out-of-bounds endIndex clamps with warning; invalid/outside bounds warn and omit range; undefined endIndex omits range.
              { segment: { partIndex: 4, startIndex: 3, endIndex: 99 }, groundingChunkIndices: [2, 3] },
              { segment: { partIndex: 4 }, groundingChunkIndices: [2] },
              { segment: { partIndex: 4, startIndex: 5, endIndex: 5 }, groundingChunkIndices: [2] },
              { segment: { partIndex: 4, startIndex: 99, endIndex: 120 }, groundingChunkIndices: [2] },
            ],
          },
          finishReason: 'STOP',
        }],
      }),
    ]));

    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenNthCalledWith(1, 'Clamping Gemini GenerateContent grounding range to streamed text', expect.objectContaining({ endByte: 99 }));
    expect(warn).toHaveBeenNthCalledWith(2, 'Dropping Gemini GenerateContent grounding range with invalid byte bounds', expect.objectContaining({ startByte: 5, endByte: 5 }));
    expect(warn).toHaveBeenNthCalledWith(3, 'Dropping Gemini GenerateContent grounding range outside streamed text', expect.objectContaining({ startByte: 99, endByte: 120 }));
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
              source_kind: 'url',
              source: 'https://example.com/paris',
              source_label: 'Paris',
              output_text_range: { start: 0, end_exclusive: 19 },
            },
            {
              type: 'source_citation',
              source_kind: 'document',
              source_text: 'Inline snippet',
              output_text_range: { start: 12, end_exclusive: 19 },
            },
            {
              type: 'source_citation',
              source_kind: 'document',
              source_text: 'Inline snippet',
            },
          ],
        }],
      },
    ]);
    expect(turns.get(0)?.turn[0]?.parts?.slice(-2)).toEqual([
      { text: 'Paris is ' },
      { text: 'in France.', thoughtSignature: 'sig_tail' },
    ]);

    // 2. Native-vs-logical partIndex collision on a thoughtSignature split disambiguated by both `segment.text` and byte bounds.
    warn.mockClear();
    const disambiguated = await runReader(iterate([
      eventFrame({
        modelVersion: 'gemini-2.5-pro',
        candidates: [{
          index: 0,
          content: {
            role: 'model',
            parts: [
              { text: 'Alpha ' },
              { text: 'Beta', thoughtSignature: 'sig_b' },
            ],
          },
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: 'https://example.com/ab-text', title: 'AB Text' } },
              { web: { uri: 'https://example.com/ab-bounds', title: 'AB Bounds' } },
              { web: { uri: 'https://example.com/ab-clamped', title: 'AB Clamped' } },
            ],
            groundingSupports: [
              // Native 0 ("Alpha ") vs logical 0 ("Alpha Beta"): `segment.text` picks logical 0 for 6..10 ("Beta").
              { segment: { partIndex: 0, startIndex: 6, endIndex: 10, text: 'Beta' }, groundingChunkIndices: [0] },
              // Without `segment.text`, byte bounds (`endIndex: 10 > 6`) still select logical 0 for 6..10.
              { segment: { partIndex: 0, startIndex: 6, endIndex: 10 }, groundingChunkIndices: [1] },
              // Out-of-bounds `endIndex: 12` without `segment.text` falls back to logical 0 ("Alpha Beta") and clamps to 6..10.
              { segment: { partIndex: 0, startIndex: 6, endIndex: 12 }, groundingChunkIndices: [2] },
            ],
          },
          finishReason: 'STOP',
        }],
      }),
    ]));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Clamping Gemini GenerateContent grounding range to streamed text', expect.objectContaining({ startByte: 6, endByte: 12, availableBytes: 10 }));
    expect(disambiguated.state.choices[0]?.items[0]).toEqual({
      type: 'message',
      content: [{
        type: 'text',
        text: 'Alpha Beta',
        annotations: [
          {
            type: 'source_citation',
            source_kind: 'url',
            source: 'https://example.com/ab-text',
            source_label: 'AB Text',
            output_text_range: { start: 6, end_exclusive: 10 },
          },
          {
            type: 'source_citation',
            source_kind: 'url',
            source: 'https://example.com/ab-bounds',
            source_label: 'AB Bounds',
            output_text_range: { start: 6, end_exclusive: 10 },
          },
          {
            type: 'source_citation',
            source_kind: 'url',
            source: 'https://example.com/ab-clamped',
            source_label: 'AB Clamped',
            output_text_range: { start: 6, end_exclusive: 10 },
          },
        ],
      }],
    });

    // 3. Untranslated server-side parts (`executableCode`) and empty `thought` parts advance logical grounding indices without losing later text citations.
    warn.mockClear();
    const afterUntranslated = await runReader(iterate([
      eventFrame({
        modelVersion: 'gemini-2.5-pro',
        candidates: [{
          index: 0,
          content: {
            role: 'model',
            parts: [
              { thought: true, text: 't1' },
              { thought: true, text: 't2', thoughtSignature: 's_t' },
              { text: 'Hello ' },
              { text: 'world!', thoughtSignature: 's_w' },
              { executableCode: { language: 'PYTHON', code: '1+1' } },
              { text: 'Done.' },
              { thought: true, thoughtSignature: 's_empty' },
              { text: 'End' },
            ],
          },
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: 'https://example.com/done', title: 'Done' } },
              { web: { uri: 'https://example.com/end', title: 'End' } },
            ],
            groundingSupports: [
              // Logical 3 ("Done.") collides with native 3 ("world!") and resolves to UTF-16 12..17.
              { segment: { partIndex: 3, startIndex: 0, endIndex: 5, text: 'Done.' }, groundingChunkIndices: [0] },
              // Logical 5 ("End") after empty thought resolves to UTF-16 17..20.
              { segment: { partIndex: 5, startIndex: 0, endIndex: 3, text: 'End' }, groundingChunkIndices: [1] },
            ],
          },
          finishReason: 'STOP',
        }],
      }),
    ]));
    expect(warn).not.toHaveBeenCalled();
    expect(afterUntranslated.state.choices[0]?.items[1]).toEqual({
      type: 'message',
      content: [{
        type: 'text',
        text: 'Hello world!Done.End',
        annotations: [
          {
            type: 'source_citation',
            source_kind: 'url',
            source: 'https://example.com/done',
            source_label: 'Done',
            output_text_range: { start: 12, end_exclusive: 17 },
          },
          {
            type: 'source_citation',
            source_kind: 'url',
            source: 'https://example.com/end',
            source_label: 'End',
            output_text_range: { start: 17, end_exclusive: 20 },
          },
        ],
      }],
    });

    // 4. Late grounding on a closed text part warns and drops safely; mid-character UTF-8 split warns and omits range.
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
    expect(warn).toHaveBeenNthCalledWith(1, 'Dropping Gemini GenerateContent grounding citation for closed text part', { choice: 0, partIndex: 0 });
    expect(warn).toHaveBeenNthCalledWith(2, 'Dropping Gemini GenerateContent grounding range that splits a UTF-8 character', { choice: 0, startByte: 1, endByte: 4 });
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
  const { records, state, turns, builder } = await runReader(iterate([
    eventFrame({
      promptFeedback: { blockReason: 'BLOCK_REASON_UNSPECIFIED' },
      candidates: [
        {
          index: 2,
          content: {
            role: 'model',
            parts: [
              { text: 'Before' },
              { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0=' } },
              { text: 'Mid' },
              { inlineData: { mimeType: 'IMAGE/PNG', data: 'aW1n' } },
              { inlineData: { mimeType: 'audio/wav', data: 'YXVk' }, audioTranscription: { text: 'spoken' } },
              { inlineData: { mimeType: 'audio/mp3', data: 'bXAz' }, audioTranscription: {} as never },
              { text: 'After' },
            ],
          },
          groundingMetadata: {
            groundingChunks: [{ web: { uri: 'https://example.com/after', title: 'After' } }],
            groundingSupports: [{ segment: { partIndex: 6, startIndex: 0, endIndex: 5 }, groundingChunkIndices: [0] }],
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
      { type: 'text', text: 'BeforeMid' },
      { type: 'image', image: { media_type: 'IMAGE/PNG', data: 'aW1n' } },
      { type: 'audio', audio: { media_type: 'audio/wav', data: 'YXVk', transcript: 'spoken' } },
      { type: 'audio', audio: { media_type: 'audio/mp3', data: 'bXAz' } },
      {
        type: 'text',
        text: 'After',
        annotations: [{
          type: 'source_citation',
          source_kind: 'url',
          source: 'https://example.com/after',
          source_label: 'After',
          output_text_range: { start: 0, end_exclusive: 5 },
        }],
      },
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
  const capturedAudio = turns.get(0);
  if (capturedAudio === undefined) throw new Error('Expected captured native turn');
  expect(capturedAudio.turn[0]?.parts).toHaveLength(7);
  expect(capturedAudio.fieldState[0]?.parts?.[1]).toBeUndefined();
  expect(capturedAudio.fieldState[0]?.parts?.[3]).toBeUndefined();
  await expect(referenceAssistantTurn<'geminiGenerateContent'>(
    capturedAudio.turn,
    capturedAudio.fieldState,
    builder,
    new Map(),
  )).resolves.toEqual({ targetTurn: capturedAudio.turn });
  expect(records).toContainEqual({ type: 'choice_end', choice: 0, finish_reason: 'stop' });
  expect(records).toContainEqual({ type: 'choice_end', choice: 1, finish_reason: 'length' });
  expect(records.at(-1)).toEqual({ type: 'finish', status: 'incomplete' });
});

test('maps safety refusal_details, promptFeedback blocking, failed output reasons, and error frames', async () => {
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

  // Immediate prompt block before any candidate opens choice 0 with refusal_details (null explanation when omitted).
  const blockedImmediately = await runReader(iterate([
    eventFrame({
      modelVersion: 'gemini-2.5-pro',
      promptFeedback: { blockReason: 'SAFETY' },
    }),
  ]));
  expect(blockedImmediately.state.choices[0]?.refusal_details).toEqual({ category: 'SAFETY', explanation: null });
  expect(blockedImmediately.records).toContainEqual({ type: 'choice_end', choice: 0, finish_reason: 'content_filter' });
  expect(blockedImmediately.records.at(-1)).toEqual({ type: 'finish', status: 'completed' });

  // Prompt block arriving while one candidate is open and another already hit MAX_TOKENS preserves incomplete finish status.
  const blockedWhileOpen = await runReader(iterate([
    eventFrame({
      modelVersion: 'gemini-2.5-pro',
      candidates: [
        { index: 0, content: { role: 'model', parts: [{ text: 'cut' }] }, finishReason: 'MAX_TOKENS' },
        { index: 1, content: { role: 'model', parts: [{ text: 'partial' }] } },
      ],
    }),
    eventFrame({
      modelVersion: 'gemini-2.5-pro',
      promptFeedback: { blockReason: 'PROHIBITED_CONTENT', blockReasonMessage: 'Policy block.' },
    }),
  ]));
  expect(blockedWhileOpen.state.choices[1]?.refusal_details).toEqual({
    category: 'PROHIBITED_CONTENT',
    explanation: 'Policy block.',
  });
  expect(blockedWhileOpen.records).toContainEqual({ type: 'choice_end', choice: 1, finish_reason: 'content_filter' });
  expect(blockedWhileOpen.records.at(-1)).toEqual({ type: 'finish', status: 'incomplete' });

  // Eager failed finish on an empty first candidate emits an api_error without opening a choice or trailing ': '.
  const malformed = await runReader(iterate([
    eventFrame({
      modelVersion: 'gemini-2.5-pro',
      candidates: [{ index: 0, content: { role: 'model', parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL', finishMessage: '' }],
    }),
  ]));
  expect(malformed.state.choices).toEqual([]);
  expect(malformed.records.at(-1)).toEqual({
    type: 'error',
    error: { type: 'api_error', code: 'MALFORMED_FUNCTION_CALL', message: 'Gemini ended the response with MALFORMED_FUNCTION_CALL' },
  });

  // Mid-stream failed finish with non-empty finishMessage terminates the stream with an api_error carrying the message.
  const midStreamFailed = await runReader(iterate([
    eventFrame({
      modelVersion: 'gemini-2.5-pro',
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'start' }] } }],
    }),
    eventFrame({
      modelVersion: 'gemini-2.5-pro',
      candidates: [{ index: 0, finishReason: 'MALFORMED_RESPONSE', finishMessage: 'Broken wire payload' }],
    }),
  ]));
  expect(midStreamFailed.records.at(-1)).toEqual({
    type: 'error',
    error: { type: 'api_error', code: 'MALFORMED_RESPONSE', message: 'Gemini ended the response with MALFORMED_RESPONSE: Broken wire payload' },
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
  ]))).rejects.toThrow(new TypeError('Gemini GenerateContent stream arrived before a non-empty model'));

  await expect(runReader(iterate([
    eventFrame({
      modelVersion: 'gemini-2.5-pro',
      candidates: [{ index: 0, content: { role: 'model', parts: [{ functionCall: { name: '' } }] }, finishReason: 'STOP' }],
    }),
  ]))).rejects.toThrow(new TypeError('Gemini GenerateContent functionCall requires a non-empty name'));
});
