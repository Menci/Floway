import { test } from 'vitest';

import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import { buildTargetPayloadFor, pairs } from '../composition-helpers.ts';
import { ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentPart, GeminiGenerateContentContent, GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const noOptions: { fallbackMaxOutputTokens?: number } = { fallbackMaxOutputTokens: undefined };

const withMaxOutputTokens = (maxOutputTokens: number) => ({ fallbackMaxOutputTokens: maxOutputTokens });

const buildWithTestSidecar = (
  payload: GeminiGenerateContentPayload,
  model: string,
  options: { fallbackMaxOutputTokens?: number },
) => buildTargetPayloadFor(pairs.geminiToMessages[0], pairs.geminiToMessages[1], { ...payload, model }, { sidecarCodec: createTestSidecarCodec(), ...options });

test('buildTargetPayload translates a named thinking level to the effort name', async () => {
  const request = await buildWithTestSidecar({
    contents: [],
    generationConfig: { thinkingConfig: { thinkingLevel: 'LOW' } },
  }, 'claude-test', noOptions);

  assertEquals(request.output_config, { effort: 'low' });
});

test('buildTargetPayload forwards an empty thinkingLevel verbatim', async () => {
  const request = await buildWithTestSidecar({
    contents: [],
    generationConfig: { thinkingConfig: { thinkingLevel: '' } },
  }, 'claude-test', noOptions);

  assertEquals(request.output_config, { effort: '' });
});

test('buildTargetPayload preserves native thinkingBudget beside an empty thinkingLevel', async () => {
  const request = await buildWithTestSidecar({
    contents: [],
    generationConfig: { thinkingConfig: { thinkingBudget: 2048, thinkingLevel: '' } },
  }, 'claude-test', noOptions);

  assertEquals(request.thinking, { type: 'enabled', budget_tokens: 2048 });
  // Messages states a level and a budget on different slots, so an empty level
  // travels verbatim beside the budget rather than being replaced by it.
  assertEquals(request.output_config, { effort: '' });
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

test.each(['audio/wav', 'audio/mp3', 'audio/mpeg'])('buildTargetPayload rejects Gemini inline audio MIME type %s for Anthropic Messages', async mimeType => {
  await assertRejects(
    () => buildWithTestSidecar({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: 'ZGF0YQ==' } }] }] }, 'claude-test', noOptions),
    Error,
    `Cannot translate an audio part of MIME type '${mimeType}' to Anthropic Messages.`,
  );
});

test('buildTargetPayload forwards a non-audio inline MIME type from Gemini as a Messages document', async () => {
  // GenerateContent states any MIME type inline; the document's media type
  // travels verbatim so the selected upstream decides whether it accepts it.
  // A `text` source states characters, not the base64 the IR carries.
  const request = await buildWithTestSidecar({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'text/plain', data: 'ZGF0YQ==' } }] }] }, 'claude-test', noOptions);
  assertEquals(request.messages, [{ role: 'user', content: [{ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'data' } }] }]);
});

test('buildTargetPayload prefers limits.max_output_tokens over the gateway default when payload omits maxOutputTokens', async () => {
  const request = await buildWithTestSidecar({ contents: [] }, 'claude-test', withMaxOutputTokens(6144));
  assertEquals(request.max_tokens, 6144);
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
          id: 'gemini_call_1_0',
          name: 'fallback',
          input: {},
          cache_control: { type: 'ephemeral' },
        },
      ],
    },
  ]);
});

test('buildTargetPayload correlates omitted function response ids in call order', async () => {
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
        cache_control: { type: 'ephemeral' },
      },
    ],
    tool_choice: { type: 'tool', name: 'lookup' },
  });

  assertEquals((await buildWithTestSidecar({ contents: [], toolConfig: { functionCallingConfig: { mode: 'NONE' } } }, 'claude-test', noOptions)).tool_choice, { type: 'none' });
  assertEquals((await buildWithTestSidecar({ contents: [], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } }, 'claude-test', noOptions)).tool_choice, { type: 'auto' });
  assertEquals((await buildWithTestSidecar({ contents: [], toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } } }, 'claude-test', noOptions)).tool_choice, { type: 'auto' });
  // ANY demands a call the request offers no declaration for.
  assertEquals((await buildWithTestSidecar({ contents: [], toolConfig: { functionCallingConfig: { mode: 'ANY' } } }, 'claude-test', noOptions)).tool_choice, undefined);
});

test('buildTargetPayload filters tools to multiple allowed names for ANY mode', async () => {
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

test('buildTargetPayload maps dynamic thinking budget to adaptive thinking', async () => {
  assertEquals((await buildWithTestSidecar({ contents: [], generationConfig: { thinkingConfig: { thinkingBudget: -1 } } }, 'claude-test', noOptions)).thinking, { type: 'adaptive' });
});

test('buildTargetPayload wraps generationConfig.responseSchema as output_config.format', async () => {
  const schema = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false };
  const request = await buildWithTestSidecar({ contents: [], generationConfig: { responseSchema: schema } }, 'claude-test', noOptions);

  assertEquals(request.output_config, { format: { type: 'json_schema', schema } });
});

test('buildTargetPayload merges thinking-level effort with responseSchema format on a single output_config', async () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  const request = await buildWithTestSidecar(
    { contents: [], generationConfig: { responseSchema: schema, thinkingConfig: { thinkingLevel: 'high' } } },
    'claude-test',
    noOptions,
  );

  assertEquals(request.output_config, { effort: 'high', format: { type: 'json_schema', schema } });
});

test('buildTargetPayload rejects an unknown content role', async () => {
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

test('buildTargetPayload rejects a part with an unsupported kind in user content', async () => {
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

test('buildTargetPayload rejects a function_call part in user content', async () => {
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

test('buildTargetPayload rejects an inline_data part in model content', async () => {
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

test('buildTargetPayload rejects a part that sets conflicting content fields', async () => {
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

test('buildTargetPayload rejects a part with no recognized content field', async () => {
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

test('states an empty argument object for a call that carries no args', async () => {
  // `input` is required on a Messages tool_use, and the empty object is how
  // every target spells a call that takes no argument object.
  const result = await buildWithTestSidecar({
    contents: [
      { role: 'user', parts: [{ text: 'go' }] },
      { role: 'model', parts: [{ functionCall: { name: 'f' } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'f', response: { r: 1 } } }] },
    ],
  }, 'target-model', noOptions);
  const assistant = (result.messages as Array<{ role?: string; content?: unknown }>).find(item => item.role === 'assistant');
  assertEquals((assistant?.content as Array<{ input?: unknown }>)[0]?.input, {});
});
