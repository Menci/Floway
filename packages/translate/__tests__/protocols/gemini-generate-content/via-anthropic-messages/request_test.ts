import { test } from 'vitest';

import { buildTargetRequest as buildTargetRequestWithSidecar } from '../../../../src/protocols/gemini-generate-content/via-anthropic-messages/request.ts';
import { createTestSidecarCodec } from '../../../round-trip/sidecar-codec.ts';
import { ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentPart, GeminiGenerateContentContent, GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const noOptions: Parameters<typeof buildTargetRequestWithSidecar>[3] = { fallbackMaxOutputTokens: undefined };

const withMaxOutputTokens = (maxOutputTokens: number) => ({ fallbackMaxOutputTokens: maxOutputTokens });

const buildWithTestSidecar = (
  payload: Parameters<typeof buildTargetRequestWithSidecar>[0],
  model: Parameters<typeof buildTargetRequestWithSidecar>[1],
  options: Parameters<typeof buildTargetRequestWithSidecar>[3],
) => buildTargetRequestWithSidecar(payload, model, createTestSidecarCodec(), options);

test('buildTargetRequest forwards an empty thinkingLevel verbatim', async () => {
  const request = await buildWithTestSidecar({
    contents: [],
    generationConfig: { thinkingConfig: { thinkingLevel: '' } },
  }, 'claude-test', noOptions);

  assertEquals(request.output_config, { effort: '' });
});

test('buildTargetRequest preserves native thinkingBudget beside an empty thinkingLevel', async () => {
  const request = await buildWithTestSidecar({
    contents: [],
    generationConfig: { thinkingConfig: { thinkingBudget: 2048, thinkingLevel: '' } },
  }, 'claude-test', noOptions);

  assertEquals(request.thinking, { type: 'enabled', budget_tokens: 2048 });
  assertEquals(request.output_config, { effort: '' });
});

test('buildTargetRequest maps system, default max tokens, and multimodal user content', async () => {
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
    system: [{ type: 'text', text: 'Be precise.\n\nUse markdown.', cache_control: { type: 'ephemeral' } }],
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

test.each(['audio/wav', 'audio/mp3', 'audio/mpeg', 'text/plain'])('buildTargetRequest rejects Gemini inline data MIME type %s for Anthropic Messages', async mimeType => {
  await assertRejects(
    () => buildWithTestSidecar({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: 'ZGF0YQ==' } }] }] }, 'claude-test', noOptions),
    Error,
    `Cannot translate Gemini generateContent inlineData MIME type '${mimeType}' to Anthropic Messages.`,
  );
});

test('buildTargetRequest prefers limits.max_output_tokens over the gateway default when payload omits maxOutputTokens', async () => {
  const request = await buildWithTestSidecar({ contents: [] }, 'claude-test', withMaxOutputTokens(6144));
  assertEquals(request.max_tokens, 6144);
});

test('buildTargetRequest maps generation config and thinking controls', async () => {
  const payload: GeminiGenerateContentPayload = {
    contents: [],
    generationConfig: {
      maxOutputTokens: 512,
      temperature: 0.25,
      topP: 0.8,
      topK: 40,
      stopSequences: ['END'],
      thinkingConfig: {
        thinkingBudget: 2048,
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
    thinking: { type: 'enabled', budget_tokens: 2048 },
    output_config: { effort: 'high' },
  });

  assertEquals((await buildWithTestSidecar({ contents: [], generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }, 'claude-test', noOptions)).thinking, { type: 'disabled' });
});

test('buildTargetRequest keeps readable thinking and tool calls while dropping thought signatures', async () => {
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
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'gemini_call_1_0',
          name: 'fallback',
          input: {},
          cache_control: { type: 'ephemeral' },
        },
      ],
    },
  ]);
});

test('buildTargetRequest correlates omitted function response ids in call order', async () => {
  const payload: GeminiGenerateContentPayload = {
    contents: [
      {
        role: 'model',
        parts: [{ functionCall: { name: 'lookup', args: { q: 'first' } } }, { functionCall: { name: 'lookup', args: { q: 'second' } } }],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: { name: 'lookup', response: { answer: 'first' } },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: { name: 'lookup', response: { answer: 'second' } },
          },
        ],
      },
    ],
  };

  assertEquals((await buildWithTestSidecar(payload, 'claude-test', noOptions)).messages, [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'gemini_call_0_0',
          name: 'lookup',
          input: { q: 'first' },
        },
        {
          type: 'tool_use',
          id: 'gemini_call_0_1',
          name: 'lookup',
          input: { q: 'second' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'gemini_call_0_0',
          content: '{"answer":"first"}',
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'gemini_call_0_1',
          content: '{"answer":"second"}',
          cache_control: { type: 'ephemeral' },
        },
      ],
    },
  ]);
});

test('buildTargetRequest maps tool declarations and tool choice modes', async () => {
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
        cache_control: { type: 'ephemeral' },
      },
    ],
    tool_choice: { type: 'tool', name: 'lookup' },
  });

  assertEquals((await buildWithTestSidecar({ contents: [], toolConfig: { functionCallingConfig: { mode: 'NONE' } } }, 'claude-test', noOptions)).tool_choice, { type: 'none' });
  assertEquals((await buildWithTestSidecar({ contents: [], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } }, 'claude-test', noOptions)).tool_choice, { type: 'auto' });
  assertEquals((await buildWithTestSidecar({ contents: [], toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } } }, 'claude-test', noOptions)).tool_choice, { type: 'auto' });
  assertEquals((await buildWithTestSidecar({ contents: [], toolConfig: { functionCallingConfig: { mode: 'ANY' } } }, 'claude-test', noOptions)).tool_choice, { type: 'any' });
});

test('buildTargetRequest filters tools to multiple allowed names for ANY mode', async () => {
  const payload: GeminiGenerateContentPayload = {
    contents: [],
    tools: [
      {
        functionDeclarations: [{ name: 'lookup' }, { name: 'ping' }, { name: 'blocked' }],
      },
    ],
    toolConfig: {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: ['lookup', 'ping'],
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
        input_schema: { type: 'object', properties: {} },
      },
      {
        type: 'custom',
        name: 'ping',
        input_schema: { type: 'object', properties: {} },
        cache_control: { type: 'ephemeral' },
      },
    ],
    tool_choice: { type: 'any' },
  });
});

test('buildTargetRequest maps dynamic thinking budget to adaptive thinking', async () => {
  assertEquals((await buildWithTestSidecar({ contents: [], generationConfig: { thinkingConfig: { thinkingBudget: -1 } } }, 'claude-test', noOptions)).thinking, { type: 'adaptive' });
});

test('buildTargetRequest wraps generationConfig.responseSchema as output_config.format', async () => {
  const schema = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false };
  const request = await buildWithTestSidecar({ contents: [], generationConfig: { responseSchema: schema } }, 'claude-test', noOptions);

  assertEquals(request.output_config, { format: { type: 'json_schema', schema } });
});

test('buildTargetRequest merges thinking-level effort with responseSchema format on a single output_config', async () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  const request = await buildWithTestSidecar(
    { contents: [], generationConfig: { responseSchema: schema, thinkingConfig: { thinkingLevel: 'high' } } },
    'claude-test',
    noOptions,
  );

  assertEquals(request.output_config, { effort: 'high', format: { type: 'json_schema', schema } });
});

test('buildTargetRequest rejects an unknown content role', async () => {
  await assertRejects(
    () =>
      buildWithTestSidecar(
        {
          contents: [{ role: 'system', parts: [{ text: 'Hi' }] } as unknown as GeminiGenerateContentContent],
        },
        'claude-test',
        noOptions,
      ),
    Error,
    '"system" is not a supported content role.',
  );
});

test('buildTargetRequest rejects a part with an unsupported kind in user content', async () => {
  await assertRejects(
    () =>
      buildWithTestSidecar(
        {
          contents: [{ role: 'user', parts: [{ fileData: { mimeType: 'text/plain', fileUri: 'files/abc' } }] }],
        },
        'claude-test',
        noOptions,
      ),
    Error,
    '"file_data" parts are not supported in user content.',
  );
});

test('buildTargetRequest rejects a function_call part in user content', async () => {
  await assertRejects(
    () =>
      buildWithTestSidecar(
        {
          contents: [{ role: 'user', parts: [{ functionCall: { name: 'x', args: {} } }] }],
        },
        'claude-test',
        noOptions,
      ),
    Error,
    '"function_call" parts are not supported in user content.',
  );
});

test('buildTargetRequest rejects an inline_data part in model content', async () => {
  await assertRejects(
    () =>
      buildWithTestSidecar(
        {
          contents: [{ role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1n' } }] }],
        },
        'claude-test',
        noOptions,
      ),
    Error,
    '"inline_data" parts are not supported in model content.',
  );
});

test('buildTargetRequest rejects a part that sets conflicting content fields', async () => {
  await assertRejects(
    () =>
      buildWithTestSidecar(
        {
          contents: [{ role: 'model', parts: [{ text: 'foo', functionCall: { name: 'x', args: {} } } as unknown as GeminiGenerateContentPart] }],
        },
        'claude-test',
        noOptions,
      ),
    Error,
    'sets conflicting content fields',
  );
});

test('buildTargetRequest rejects a part with no recognized content field', async () => {
  await assertRejects(
    () =>
      buildWithTestSidecar(
        {
          contents: [{ role: 'user', parts: [{}] }],
        },
        'claude-test',
        noOptions,
      ),
    Error,
    'has no recognized content',
  );
});

test.each([undefined, []])('preserves an empty model turn with parts %j', async parts => {
  const payload = { contents: [{ role: 'user', parts: [{ text: 'before' }] }, { role: 'model', ...(parts === undefined ? {} : { parts }) }, { role: 'user', parts: [{ text: 'after' }] }] };
  const result = await buildWithTestSidecar(payload, 'target-model', noOptions);
  assertEquals((result.messages as Array<{ role?: string; content?: unknown }>).filter(item => item.role === 'assistant'), [{ role: 'assistant', content: '' }]);
});
