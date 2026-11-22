import { describe, expect, test, vi } from 'vitest';

import { geminiGenerateContentGenerateTarget } from '../../../../../src/data-plane/chat/gemini-generate-content/attempt-pipeline.ts';
import { stripSafetySettings } from '../../../../../src/data-plane/chat/gemini-generate-content/stages/strip-safety-settings.ts';
import { createStripUnsupportedPartFieldsStage } from '../../../../../src/data-plane/chat/gemini-generate-content/stages/strip-unsupported-part-fields.ts';
import { stripUnsupportedTools } from '../../../../../src/data-plane/chat/gemini-generate-content/stages/strip-unsupported-tools.ts';
import { suppressThoughtParts } from '../../../../../src/data-plane/chat/gemini-generate-content/stages/suppress-thought-parts.ts';
import { createManagedProtocolFrames, runChatStage, stubRouteCandidate } from '../../../../test-utils/chat-pipeline.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentPart, GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import { testTelemetryModelIdentity } from '@floway-dev/test-utils';

const payload = (overrides: Partial<GeminiGenerateContentPayload> = {}): GeminiGenerateContentPayload => ({
  contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
  ...overrides,
});

const facts = (targetApi: 'geminiGenerateContent' | 'anthropicMessages' | 'openaiChatCompletions' | 'openaiResponses', payloadValue = payload()) => ({
  'route.candidate': stubRouteCandidate({ endpoints: { [targetApi]: {} } }),
  'request.inboundHeaders': [],
  'request.payload': payloadValue,
  'route.targetApi': targetApi,
});

const collect = async (frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>) => {
  const events: GeminiGenerateContentStreamEvent[] = [];
  for await (const frame of frames) if (frame.type === 'event') events.push(frame.event);
  return events;
};

describe('Gemini generateContent stages', () => {
  test('stamps the target and strips unsupported parts only on translated paths', async () => {
    const source = payload({
      contents: [{ role: 'user', parts: [{ text: 'keep', fileData: { fileUri: 'gs://x', mimeType: 'text/plain' } } as unknown as GeminiGenerateContentPart] }],
    });
    const next = vi.fn(async (provided: { readonly 'request.payload': GeminiGenerateContentPayload; readonly 'route.targetApi': string }) => provided);

    await runChatStage({
      stage: createStripUnsupportedPartFieldsStage(geminiGenerateContentGenerateTarget),
      facts: {
        'route.candidate': stubRouteCandidate({ endpoints: { anthropicMessages: {} } }),
        'request.inboundHeaders': [],
        'request.payload': source,
      },
      next,
    });

    expect(source.contents[0].parts?.[0]).toHaveProperty('fileData');
    expect(next.mock.calls[0][0]['request.payload'].contents[0].parts).toEqual([{ text: 'keep' }]);
    expect(next.mock.calls[0][0]['route.targetApi']).toBe('anthropicMessages');
  });

  test('strips translated tool capabilities and safety settings while preserving native payloads', async () => {
    const source = payload({
      tools: [{ googleSearch: {}, functionDeclarations: [{ name: 'lookup' }] }, { codeExecution: {} }],
      safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }],
    });
    const next = vi.fn(async (provided: { readonly 'request.payload': GeminiGenerateContentPayload }) => provided);
    await runChatStage({ stage: stripUnsupportedTools, facts: facts('anthropicMessages', source), next });
    expect(next.mock.calls[0][0]['request.payload'].tools).toEqual([{ functionDeclarations: [{ name: 'lookup' }] }]);
    await runChatStage({ stage: stripSafetySettings, facts: facts('anthropicMessages', source), next });
    expect(next.mock.calls[1][0]['request.payload'].safetySettings).toBeUndefined();
    expect(source.safetySettings).toBeDefined();
  });

  test('suppresses translated thought parts unless includeThoughts is set', async () => {
    const upstream: GeminiGenerateContentStreamEvent[] = [
      { candidates: [{ index: 0, content: { role: 'model', parts: [{ thought: true, text: 'reasoning' }, { text: 'answer' }] } }] },
      { candidates: [{ index: 0, content: { role: 'model', parts: [{ thought: true, text: 'more' }] } }] },
    ];
    const result = await runChatStage({
      stage: suppressThoughtParts,
      facts: facts('anthropicMessages'),
      next: (_provided, env) => ({
        type: 'events' as const,
        events: createManagedProtocolFrames(env, upstream),
        modelIdentity: testTelemetryModelIdentity,
      }),
    });
    expect(await collect((result.outcome as Extract<typeof result.outcome, { type: 'events' }>).events)).toEqual([
      { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'answer' }] } }] },
    ]);
  });
});
