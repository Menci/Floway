import { test } from 'vitest';

import { buildTargetRequest } from './request.ts';
import { assertEquals } from '../test-assert.ts';
import type { GeminiGenerateContentRequest } from '@floway-dev/protocols/gemini';

test('buildTargetRequest maps system instruction and multimodal user content', () => {
  const payload: GeminiGenerateContentRequest = {
    systemInstruction: {
      parts: [{ text: 'Be precise.' }, { text: 'Use markdown.' }],
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: 'Describe this image.' }, { inlineData: { mimeType: 'application/pdf', data: 'cGRm' } }, { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }],
      },
    ],
  };

  assertEquals(buildTargetRequest(payload, 'gpt-test'), {
    model: 'gpt-test',
    stream: true,
    messages: [
      { role: 'system', content: 'Be precise.\n\nUse markdown.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image.' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,aW1hZ2U=' },
          },
        ],
      },
    ],
  });
});

test('buildTargetRequest maps function calls, tool responses, and reasoning history', () => {
  const payload: GeminiGenerateContentRequest = {
    contents: [
      {
        role: 'model',
        parts: [{ text: 'private trace', thought: true, thoughtSignature: 'sig_1' }, { text: 'I will call a tool.' }, { functionCall: { name: 'lookup', args: { query: 'docs' } } }],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'lookup',
              response: { answer: 42 },
            },
          },
        ],
      },
    ],
  };

  assertEquals(buildTargetRequest(payload, 'gpt-test').messages, [
    {
      role: 'assistant',
      content: 'I will call a tool.',
      reasoning_text: 'private trace',
      reasoning_opaque: 'sig_1',
      tool_calls: [
        {
          id: 'gemini_call_0_2',
          type: 'function',
          function: { name: 'lookup', arguments: '{"query":"docs"}' },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'gemini_call_0_2',
      content: '{"answer":42}',
    },
  ]);
});

test('buildTargetRequest matches omitted functionResponse ids to same-name calls in call order', () => {
  const payload: GeminiGenerateContentRequest = {
    contents: [
      {
        role: 'model',
        parts: [{ functionCall: { name: 'lookup', args: { query: 'first' } } }, { functionCall: { name: 'lookup', args: { query: 'second' } } }],
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

  assertEquals(buildTargetRequest(payload, 'gpt-test').messages, [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'gemini_call_0_0',
          type: 'function',
          function: { name: 'lookup', arguments: '{"query":"first"}' },
        },
        {
          id: 'gemini_call_0_1',
          type: 'function',
          function: { name: 'lookup', arguments: '{"query":"second"}' },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'gemini_call_0_0',
      content: '{"answer":"first"}',
    },
    {
      role: 'tool',
      tool_call_id: 'gemini_call_0_1',
      content: '{"answer":"second"}',
    },
  ]);
});

test('buildTargetRequest does not rematch a prior call already answered by explicit id', () => {
  const payload: GeminiGenerateContentRequest = {
    contents: [
      {
        role: 'model',
        parts: [{ functionCall: { name: 'lookup', args: { query: 'first' } } }, { functionCall: { name: 'lookup', args: { query: 'second' } } }],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'gemini_call_0_1',
              name: 'lookup',
              response: { answer: 'second' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: { name: 'lookup', response: { answer: 'first' } },
          },
        ],
      },
    ],
  };

  assertEquals(buildTargetRequest(payload, 'gpt-test').messages, [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'gemini_call_0_0',
          type: 'function',
          function: { name: 'lookup', arguments: '{"query":"first"}' },
        },
        {
          id: 'gemini_call_0_1',
          type: 'function',
          function: { name: 'lookup', arguments: '{"query":"second"}' },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'gemini_call_0_1',
      content: '{"answer":"second"}',
    },
    {
      role: 'tool',
      tool_call_id: 'gemini_call_0_0',
      content: '{"answer":"first"}',
    },
  ]);
});

test('buildTargetRequest maps generation config and reasoning effort', () => {
  const payload: GeminiGenerateContentRequest = {
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

  assertEquals(buildTargetRequest(payload, 'gpt-test'), {
    model: 'gpt-test',
    stream: true,
    messages: [],
    max_tokens: 512,
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

test('buildTargetRequest maps structured output schema and zero thinking budget', () => {
  const schema = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  };

  assertEquals(
    buildTargetRequest(
      {
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: schema,
          thinkingConfig: { thinkingBudget: 0 },
        },
      },
      'gpt-test',
    ),
    {
      model: 'gpt-test',
      stream: true,
      messages: [],
      reasoning_effort: 'none',
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'gemini_response', schema },
      },
    },
  );
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
        ],
      },
      {
        functionDeclarations: [{ name: 'ping' }],
      },
    ],
    toolConfig: {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: ['lookup'],
      },
    },
  };

  assertEquals(buildTargetRequest(payload, 'gpt-test'), {
    model: 'gpt-test',
    stream: true,
    messages: [],
    tools: [
      {
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Look up facts',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
          },
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: 'lookup' } },
  });

  assertEquals(
    buildTargetRequest(
      {
        tools: [{ functionDeclarations: [{ name: 'lookup' }] }],
        toolConfig: { functionCallingConfig: { mode: 'NONE' } },
      },
      'gpt-test',
    ).tool_choice,
    'none',
  );
  assertEquals(
    buildTargetRequest(
      {
        tools: [{ functionDeclarations: [{ name: 'lookup' }] }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      },
      'gpt-test',
    ).tool_choice,
    'auto',
  );
  assertEquals(
    buildTargetRequest(
      {
        tools: [{ functionDeclarations: [{ name: 'lookup' }] }],
        toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } },
      },
      'gpt-test',
    ).tool_choice,
    'auto',
  );
  assertEquals(
    buildTargetRequest(
      {
        tools: [{ functionDeclarations: [{ name: 'lookup' }] }],
        toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      },
      'gpt-test',
    ).tool_choice,
    'required',
  );
  assertEquals(buildTargetRequest({ toolConfig: { functionCallingConfig: { mode: 'ANY' } } }, 'gpt-test').tool_choice, undefined);
});

test('buildTargetRequest filters tools to allowed function names for ANY mode', () => {
  const result = buildTargetRequest(
    {
      tools: [
        {
          functionDeclarations: [
            { name: 'lookup' },
            { name: 'ping' },
            {
              name: 'forbidden',
            },
          ],
        },
      ],
      toolConfig: {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: ['lookup', 'ping'],
        },
      },
    },
    'gpt-test',
  );

  assertEquals(result.tools, [
    {
      type: 'function',
      function: { name: 'lookup' },
    },
    {
      type: 'function',
      function: { name: 'ping' },
    },
  ]);
  assertEquals(result.tool_choice, 'required');
});

test('buildTargetRequest maps thinking budget thresholds', () => {
  assertEquals(buildTargetRequest({ generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }, 'gpt-test').reasoning_effort, 'none');
  assertEquals(buildTargetRequest({ generationConfig: { thinkingConfig: { thinkingBudget: -1 } } }, 'gpt-test').reasoning_effort, undefined);
  assertEquals(buildTargetRequest({ generationConfig: { thinkingConfig: { thinkingBudget: 2048 } } }, 'gpt-test').reasoning_effort, 'low');
  assertEquals(buildTargetRequest({ generationConfig: { thinkingConfig: { thinkingBudget: 8192 } } }, 'gpt-test').reasoning_effort, 'medium');
  assertEquals(buildTargetRequest({ generationConfig: { thinkingConfig: { thinkingBudget: 8193 } } }, 'gpt-test').reasoning_effort, 'high');
});
