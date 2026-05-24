import { test } from 'vitest';

import { buildTargetRequest } from './request.ts';
import { assertEquals } from '../test-assert.ts';
import type { GeminiGenerateContentRequest } from '@floway-dev/protocols/gemini';
import { MESSAGES_FALLBACK_MAX_TOKENS } from '@floway-dev/protocols/messages';

const noOptions = {};

const withMaxOutputTokens = (maxOutputTokens: number) => ({ fallbackMaxOutputTokens: maxOutputTokens });

test('buildTargetRequest maps system, default max tokens, and multimodal user content', () => {
  const payload: GeminiGenerateContentRequest = {
    systemInstruction: {
      parts: [{ text: 'Be precise.' }, { text: 'Use markdown.' }],
    },
    contents: [
      {
        parts: [{ text: 'Describe this image.' }, { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }, { inlineData: { mimeType: 'application/pdf', data: 'cGRm' } }],
      },
    ],
  };

  assertEquals(buildTargetRequest(payload, 'claude-test', noOptions), {
    model: 'claude-test',
    stream: true,
    max_tokens: MESSAGES_FALLBACK_MAX_TOKENS,
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
        ],
      },
    ],
  });
});

test('buildTargetRequest prefers capabilities.maxOutputTokens over the gateway default when payload omits maxOutputTokens', () => {
  const request = buildTargetRequest({}, 'claude-test', withMaxOutputTokens(6144));
  assertEquals(request.max_tokens, 6144);
});

test('buildTargetRequest maps generation config and thinking controls', () => {
  const payload: GeminiGenerateContentRequest = {
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

  assertEquals(buildTargetRequest(payload, 'claude-test', noOptions), {
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

  assertEquals(buildTargetRequest({ generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }, 'claude-test', noOptions).thinking, { type: 'disabled' });
});

test('buildTargetRequest maps assistant thinking signatures and tool calls', () => {
  const payload: GeminiGenerateContentRequest = {
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

  assertEquals(buildTargetRequest(payload, 'claude-test', noOptions).messages, [
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'private trace', signature: 'sig_1' },
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
        { type: 'redacted_thinking', data: 'sig_only' },
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

test('buildTargetRequest correlates omitted function response ids in call order', () => {
  const payload: GeminiGenerateContentRequest = {
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

  assertEquals(buildTargetRequest(payload, 'claude-test', noOptions).messages, [
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

test('buildTargetRequest maps tool declarations and tool choice modes', () => {
  const payload: GeminiGenerateContentRequest = {
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

  assertEquals(buildTargetRequest(payload, 'claude-test', noOptions), {
    model: 'claude-test',
    stream: true,
    messages: [],
    max_tokens: MESSAGES_FALLBACK_MAX_TOKENS,
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

  assertEquals(buildTargetRequest({ toolConfig: { functionCallingConfig: { mode: 'NONE' } } }, 'claude-test', noOptions).tool_choice, { type: 'none' });
  assertEquals(buildTargetRequest({ toolConfig: { functionCallingConfig: { mode: 'AUTO' } } }, 'claude-test', noOptions).tool_choice, { type: 'auto' });
  assertEquals(buildTargetRequest({ toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } } }, 'claude-test', noOptions).tool_choice, { type: 'auto' });
  assertEquals(buildTargetRequest({ toolConfig: { functionCallingConfig: { mode: 'ANY' } } }, 'claude-test', noOptions).tool_choice, { type: 'any' });
});

test('buildTargetRequest filters tools to multiple allowed names for ANY mode', () => {
  const payload: GeminiGenerateContentRequest = {
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

  assertEquals(buildTargetRequest(payload, 'claude-test', noOptions), {
    model: 'claude-test',
    stream: true,
    messages: [],
    max_tokens: MESSAGES_FALLBACK_MAX_TOKENS,
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

test('buildTargetRequest maps dynamic thinking budget to adaptive thinking', () => {
  assertEquals(buildTargetRequest({ generationConfig: { thinkingConfig: { thinkingBudget: -1 } } }, 'claude-test', noOptions).thinking, { type: 'adaptive' });
});

test('buildTargetRequest wraps generationConfig.responseSchema as output_config.format', () => {
  const schema = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false };
  const request = buildTargetRequest({ generationConfig: { responseSchema: schema } }, 'claude-test', noOptions);

  assertEquals(request.output_config, { format: { type: 'json_schema', schema } });
});

test('buildTargetRequest merges thinking-level effort with responseSchema format on a single output_config', () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  const request = buildTargetRequest(
    { generationConfig: { responseSchema: schema, thinkingConfig: { thinkingLevel: 'high' } } },
    'claude-test',
    noOptions,
  );

  assertEquals(request.output_config, { effort: 'high', format: { type: 'json_schema', schema } });
});
