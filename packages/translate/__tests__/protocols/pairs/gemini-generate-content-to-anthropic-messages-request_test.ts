import { test } from 'vitest';

import { TranslateInputException } from '../../../src/shared/input-error.ts';
import { buildTargetPayloadFor, pairs } from '../../composition/helpers.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import { ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const noOptions: { fallbackMaxOutputTokens?: number } = { fallbackMaxOutputTokens: undefined };

const buildWithTestSidecar = (
  payload: GeminiGenerateContentPayload,
  model: string,
  options: { fallbackMaxOutputTokens?: number },
) => buildTargetPayloadFor(pairs.geminiToMessages[0], pairs.geminiToMessages[1], { ...payload, model }, { sidecarCodec: createTestSidecarCodec(), ...options });

test('function response media enters Messages tool results and tool results precede user text', async () => {
  const result = await buildWithTestSidecar({
    contents: [
      { role: 'model', parts: [{ functionCall: { name: 'fetch', args: {} } }] },
      {
        role: 'user',
        parts: [
          { text: 'Here is the result' },
          { functionResponse: { name: 'fetch', response: { status: 'ok' }, parts: [{ inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] } },
        ],
      },
    ],
  }, 'claude-test', noOptions);
  const user = result.messages[1];
  assertEquals(user, {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'fetch_call_1',
        content: [
          { type: 'text', text: '{"status":"ok"}' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
        ],
      },
      { type: 'text', text: 'Here is the result', cache_control: { type: 'ephemeral' } },
    ],
  });
});

test('buildTargetPayload maps system, default max tokens, and multimodal user content', async () => {
  const payload: GeminiGenerateContentPayload = {
    systemInstruction: {
      parts: [{ text: 'Be precise.' }, { text: 'Use markdown.' }],
    },
    contents: [
      {
        parts: [{ text: 'Describe this image.' }, { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }, { inlineData: { mimeType: 'application/pdf', data: 'cGRm' } }],
      },
    ],
  };

  assertEquals(await buildWithTestSidecar(payload, 'claude-test', noOptions), {
    model: 'claude-test',
    stream: true,
    max_tokens: ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS,
    system: [{ type: 'text', text: 'Be precise.Use markdown.', cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image.' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'aW1hZ2U=',
            },
            cache_control: { type: 'ephemeral' },
          },
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: 'cGRm',
            },
          },
        ],
      },
    ],
  });
});

test.each(['audio/wav'])('buildTargetPayload rejects Gemini inline audio MIME type %s for Anthropic Messages', async mimeType => {
  await assertRejects(
    () => buildWithTestSidecar({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: 'ZGF0YQ==' } }] }] }, 'claude-test', noOptions),
    Error,
    `Cannot translate an audio part of MIME type '${mimeType}' to Anthropic Messages.`,
  );
});

test('buildTargetPayload maps generation config and thinking controls', async () => {
  const payload: GeminiGenerateContentPayload = {
    contents: [],
    generationConfig: {
      maxOutputTokens: 512,
      temperature: 0.25,
      topP: 0.8,
      topK: 40,
      stopSequences: ['END'],
      thinkingConfig: {
        thinkingLevel: 'high',
      },
    },
  };

  assertEquals(await buildWithTestSidecar(payload, 'claude-test', noOptions), {
    model: 'claude-test',
    stream: true,
    messages: [],
    max_tokens: 512,
    temperature: 0.25,
    top_p: 0.8,
    top_k: 40,
    stop_sequences: ['END'],
    output_config: { effort: 'high' },
  });

  assertEquals((await buildWithTestSidecar({ contents: [], generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }, 'claude-test', noOptions)).thinking, { type: 'disabled' });
});

test('buildTargetPayload refuses a stated budget beside a stated level', async () => {
  await assertRejects(
    () => buildWithTestSidecar({
      contents: [],
      generationConfig: { thinkingConfig: { thinkingBudget: 2048, thinkingLevel: 'HIGH' } },
    }, 'claude-test', noOptions),
    TranslateInputException,
    'thinking_budget and thinking_level are not supported together',
  );
});

test('buildTargetPayload keeps readable thinking and tool calls while dropping thought signatures', async () => {
  const payload: GeminiGenerateContentPayload = {
    contents: [
      {
        role: 'model',
        parts: [
          { text: 'private trace', thought: true },
          {
            thoughtSignature: 'sig_1',
            functionCall: { id: 'call_1', name: 'lookup', args: { q: 'docs' } },
          },
        ],
      },
      {
        role: 'model',
        parts: [
          {
            thoughtSignature: 'sig_only',
            functionCall: { name: 'fallback', args: {} },
          },
        ],
      },
    ],
  };

  assertEquals((await buildWithTestSidecar(payload, 'claude-test', noOptions)).messages, [
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'private trace', signature: '' },
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'lookup',
          input: { q: 'docs' },
        },
        {
          type: 'tool_use',
          id: 'fallback_call_1',
          name: 'fallback',
          input: {},
          cache_control: { type: 'ephemeral' },
        },
      ],
    },
  ]);
});

test('buildTargetPayload maps tool declarations and tool choice modes', async () => {
  const payload: GeminiGenerateContentPayload = {
    contents: [],
    tools: [
      {
        functionDeclarations: [
          {
            name: 'lookup',
            description: 'Look up facts',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
            },
          },
          {
            name: 'ping',
          },
        ],
      },
    ],
    toolConfig: {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: ['lookup'],
      },
    },
  };

  assertEquals(await buildWithTestSidecar(payload, 'claude-test', noOptions), {
    model: 'claude-test',
    stream: true,
    messages: [],
    max_tokens: ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS,
    tools: [
      {
        type: 'custom',
        name: 'lookup',
        description: 'Look up facts',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      },
      { type: 'custom', name: 'ping', input_schema: { type: 'object', properties: {} }, cache_control: { type: 'ephemeral' } },
    ],
    tool_choice: { type: 'tool', name: 'lookup' },
  });

  assertEquals((await buildWithTestSidecar({ contents: [], toolConfig: { functionCallingConfig: { mode: 'NONE' } } }, 'claude-test', noOptions)).tool_choice, { type: 'none' });
  assertEquals((await buildWithTestSidecar({ contents: [], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } }, 'claude-test', noOptions)).tool_choice, { type: 'auto' });
  assertEquals((await buildWithTestSidecar({ contents: [], toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } } }, 'claude-test', noOptions)).tool_choice, { type: 'auto' });
  // Without declarations there is no callable to require, so the target choice is omitted.
  assertEquals((await buildWithTestSidecar({ contents: [], toolConfig: { functionCallingConfig: { mode: 'ANY' } } }, 'claude-test', noOptions)).tool_choice, undefined);
});
