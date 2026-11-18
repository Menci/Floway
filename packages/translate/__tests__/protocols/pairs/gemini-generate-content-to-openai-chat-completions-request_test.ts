import { test } from 'vitest';

import { buildTargetPayloadFor, pairs } from '../../composition/helpers.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import { assertEquals } from '@floway-dev/test-utils';

const buildWithTestSidecar = (
  payload: GeminiGenerateContentPayload,
  model: string,
) => buildTargetPayloadFor(pairs.geminiToChat[0], pairs.geminiToChat[1], { ...payload, model }, { sidecarCodec: createTestSidecarCodec() });

test('buildTargetPayload maps Gemini inline audio to Chat Completions input audio', async () => {
  const request = await buildWithTestSidecar({
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'audio/wav', data: 'd2F2' } },
          { inlineData: { mimeType: 'audio/mp3', data: 'bXAz' } },
          { inlineData: { mimeType: 'audio/mpeg', data: 'bXBlZw==' } },
        ],
      },
    ],
  }, 'gpt-test');

  assertEquals(request.messages, [{
    role: 'user',
    content: [
      { type: 'input_audio', input_audio: { data: 'd2F2', format: 'wav' } },
      { type: 'input_audio', input_audio: { data: 'bXAz', format: 'mp3' } },
      { type: 'input_audio', input_audio: { data: 'bXBlZw==', format: 'mp3' } },
    ],
  }]);
});

test('buildTargetPayload maps generation config and reasoning effort', async () => {
  const payload: GeminiGenerateContentPayload = {
    contents: [],
    generationConfig: {
      maxOutputTokens: 512,
      temperature: 0.25,
      topP: 0.8,
      stopSequences: ['END'],
      candidateCount: 2,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
      seed: 123,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingLevel: 'medium', includeThoughts: true },
    },
  };

  assertEquals(await buildWithTestSidecar(payload, 'gpt-test'), {
    model: 'gpt-test',
    stream: true,
    stream_options: { include_usage: true, continuous_usage_stats: true },
    messages: [],
    max_completion_tokens: 512,
    temperature: 0.25,
    top_p: 0.8,
    stop: ['END'],
    n: 2,
    presence_penalty: 0.1,
    frequency_penalty: 0.2,
    seed: 123,
    response_format: { type: 'json_object' },
    reasoning_effort: 'medium',
  });
});

test('VALIDATED restricts calls without changing declarations while leaving the choice free', async () => {
  // allowed_function_names applies to ANY and VALIDATED; VALIDATED also permits natural language.
  // https://github.com/googleapis/googleapis/blob/bc7e3baa28fbb223fa93782e130260fab8205bfc/google/ai/generativelanguage/v1beta/content.proto
  const result = await buildWithTestSidecar({
    contents: [],
    tools: [{ functionDeclarations: [{ name: 'allowed' }, { name: 'excluded' }] }],
    toolConfig: { functionCallingConfig: { mode: 'VALIDATED', allowedFunctionNames: ['allowed'] } },
  }, 'gpt-test');

  assertEquals(result.tools?.map(tool => tool.type === 'function' ? tool.function.name : undefined), ['allowed', 'excluded']);
  assertEquals(result.tool_choice, { type: 'allowed_tools', allowed_tools: { mode: 'auto', tools: [{ type: 'function', function: { name: 'allowed' } }] } });
});
