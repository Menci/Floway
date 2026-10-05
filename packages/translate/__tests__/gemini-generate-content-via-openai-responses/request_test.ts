import { test } from 'vitest';

import { buildTargetRequest } from '../../src/gemini-generate-content-via-openai-responses/request.ts';
import type { GeminiGenerateContentPart, GeminiGenerateContentContent, GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import { assertEquals, assertFalse, assertThrows } from '@floway-dev/test-utils';

test('buildTargetRequest forwards an empty thinkingLevel verbatim', () => {
  const request = buildTargetRequest({
    contents: [],
    generationConfig: { thinkingConfig: { thinkingLevel: '', includeThoughts: true } },
  }, 'gpt-test', new Map());

  assertEquals(request.reasoning, { effort: '', summary: 'detailed' });
});

test('buildTargetRequest gives thinkingBudget precedence over an empty thinkingLevel', () => {
  const request = buildTargetRequest({
    contents: [],
    generationConfig: { thinkingConfig: { thinkingBudget: 2048, thinkingLevel: '', includeThoughts: true } },
  }, 'gpt-test', new Map());

  assertEquals(request.reasoning, { effort: 'low', summary: 'detailed' });
});

test('buildTargetRequest maps instructions and multimodal user input without defaults', () => {
  const payload: GeminiGenerateContentPayload = {
    systemInstruction: {
      parts: [{ text: 'Be precise.' }, { text: 'Use markdown.' }],
    },
    contents: [
      {
        parts: [{ text: 'Describe this image.' }, { inlineData: { mimeType: 'application/pdf', data: 'cGRm' } }, { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }],
      },
    ],
  };

  assertEquals(buildTargetRequest(payload, 'gpt-test', new Map()), {
    model: 'gpt-test',
    stream: true,
    instructions: 'Be precise.\n\nUse markdown.',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Describe this image.' },
          {
            type: 'input_image',
            image_url: 'data:image/png;base64,aW1hZ2U=',
          },
        ],
      },
    ],
  });
});

test('buildTargetRequest discards foreign thought text while preserving function calls and call-order outputs', () => {
  const payload: GeminiGenerateContentPayload = {
    contents: [
      {
        role: 'model',
        parts: [
          { text: 'private trace', thought: true, thoughtSignature: 'sig_1' },
          { thoughtSignature: 'sig_only' },
          { text: 'Visible answer.' },
          { functionCall: { name: 'lookup', args: { query: 'first' } } },
          {
            functionCall: {
              id: 'call_explicit',
              name: 'lookup',
              args: { query: 'second' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'lookup', response: { answer: 'first' } } },
          {
            functionResponse: {
              id: 'call_explicit',
              name: 'lookup',
              response: { answer: 'second' },
            },
          },
        ],
      },
    ],
  };

  assertEquals(buildTargetRequest(payload, 'gpt-test', new Map()).input, [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Visible answer.' }],
    },
    {
      type: 'function_call',
      call_id: 'gemini_call_0_3',
      name: 'lookup',
      arguments: '{"query":"first"}',
      status: 'completed',
    },
    {
      type: 'function_call',
      call_id: 'call_explicit',
      name: 'lookup',
      arguments: '{"query":"second"}',
      status: 'completed',
    },
    {
      type: 'function_call_output',
      call_id: 'gemini_call_0_3',
      output: '{"answer":"first"}',
      status: 'completed',
    },
    {
      type: 'function_call_output',
      call_id: 'call_explicit',
      output: '{"answer":"second"}',
      status: 'completed',
    },
  ]);
});

test('buildTargetRequest ignores thought signatures when translating to OpenAI Responses', () => {
  const payload: GeminiGenerateContentPayload = {
    contents: [
      {
        role: 'model',
        parts: [
          { text: 'Signed answer.', thoughtSignature: 'sig_text' },
          {
            thoughtSignature: 'sig_call',
            functionCall: { name: 'lookup', args: {} },
          },
        ],
      },
    ],
  };

  assertEquals(buildTargetRequest(payload, 'gpt-test', new Map()).input, [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Signed answer.' }],
    },
    {
      type: 'function_call',
      call_id: 'gemini_call_0_1',
      name: 'lookup',
      arguments: '{}',
      status: 'completed',
    },
  ]);
});

test('buildTargetRequest maps generation config, JSON schema, and reasoning controls', () => {
  const schema = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  };
  const payload: GeminiGenerateContentPayload = {
    contents: [],
    generationConfig: {
      maxOutputTokens: 512,
      temperature: 0.25,
      topP: 0.8,
      responseMimeType: 'application/json',
      responseSchema: schema,
      thinkingConfig: { thinkingLevel: 'medium', includeThoughts: true },
    },
  };

  assertEquals(buildTargetRequest(payload, 'gpt-test', new Map()), {
    model: 'gpt-test',
    stream: true,
    input: [],
    max_output_tokens: 512,
    temperature: 0.25,
    top_p: 0.8,
    text: {
      format: {
        type: 'json_schema',
        name: 'gemini_response', schema,
      },
    },
    reasoning: { effort: 'medium', summary: 'detailed' },
  });

  assertEquals(buildTargetRequest({ contents: [], generationConfig: { responseMimeType: 'application/json' } }, 'gpt-test', new Map()).text, { format: { type: 'json_object' } });
});

test('buildTargetRequest never invents reasoning.context from Gemini generateContent thinking controls', () => {
  const result = buildTargetRequest({
    contents: [],
    generationConfig: {
      thinkingConfig: { thinkingLevel: 'high', includeThoughts: true },
    },
  }, 'gpt-test', new Map());

  assertEquals(result.reasoning, { effort: 'high', summary: 'detailed' });
  assertEquals(result.reasoning?.context, undefined);
  assertFalse('context' in (result.reasoning ?? {}));
});

test('buildTargetRequest filters tools to allowed function names for ANY mode', () => {
  const result = buildTargetRequest(
    {
      contents: [],
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
    new Map(),
  );

  assertEquals(result.tools, [
    {
      type: 'function',
      name: 'lookup',
      parameters: { type: 'object', properties: {} },
      strict: false,
    },
    {
      type: 'function',
      name: 'ping',
      parameters: { type: 'object', properties: {} },
      strict: false,
    },
  ]);
  assertEquals(result.tool_choice, 'required');
});

test('buildTargetRequest maps thinking budget thresholds and zero-budget disable', () => {
  assertEquals(buildTargetRequest({ contents: [], generationConfig: { thinkingConfig: { thinkingBudget: 2048 } } }, 'gpt-test', new Map()).reasoning, { effort: 'low' });
  assertEquals(buildTargetRequest({ contents: [], generationConfig: { thinkingConfig: { thinkingBudget: 8192 } } }, 'gpt-test', new Map()).reasoning, { effort: 'medium' });
  assertEquals(buildTargetRequest({ contents: [], generationConfig: { thinkingConfig: { thinkingBudget: 8193 } } }, 'gpt-test', new Map()).reasoning, { effort: 'high' });
  assertEquals(
    buildTargetRequest(
      {
        contents: [],
        generationConfig: {
          thinkingConfig: { thinkingBudget: 0, includeThoughts: true },
        },
      },
      'gpt-test',
      new Map(),
    ).reasoning,
    { effort: 'none' },
  );
  assertEquals(buildTargetRequest({ contents: [], generationConfig: { thinkingConfig: { thinkingBudget: -1 } } }, 'gpt-test', new Map()).reasoning, undefined);
});

test('buildTargetRequest maps tool declarations and tool choice modes only when tools exist', () => {
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

  assertEquals(buildTargetRequest(payload, 'gpt-test', new Map()), {
    model: 'gpt-test',
    stream: true,
    input: [],
    tools: [
      {
        type: 'function',
        name: 'lookup',
        description: 'Look up facts',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
        strict: false,
      },
    ],
    tool_choice: { type: 'function', name: 'lookup' },
  });

  assertEquals(
    buildTargetRequest(
      {
        contents: [],
        tools: [{ functionDeclarations: [{ name: 'lookup' }] }],
        toolConfig: { functionCallingConfig: { mode: 'NONE' } },
      },
      'gpt-test',
      new Map(),
    ).tool_choice,
    'none',
  );
  assertEquals(
    buildTargetRequest(
      {
        contents: [],
        tools: [{ functionDeclarations: [{ name: 'lookup' }] }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      },
      'gpt-test',
      new Map(),
    ).tool_choice,
    'auto',
  );
  assertEquals(
    buildTargetRequest(
      {
        contents: [],
        tools: [{ functionDeclarations: [{ name: 'lookup' }] }],
        toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } },
      },
      'gpt-test',
      new Map(),
    ).tool_choice,
    'auto',
  );
  assertEquals(
    buildTargetRequest(
      {
        contents: [],
        tools: [{ functionDeclarations: [{ name: 'lookup' }] }],
        toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      },
      'gpt-test',
      new Map(),
    ).tool_choice,
    'required',
  );
  assertEquals(buildTargetRequest({ contents: [], toolConfig: { functionCallingConfig: { mode: 'ANY' } } }, 'gpt-test', new Map()).tool_choice, undefined);
});

test('buildTargetRequest rejects an unknown content role', () => {
  assertThrows(
    () =>
      buildTargetRequest(
        {
          contents: [{ role: 'tool', parts: [{ text: 'Hi' }] } as unknown as GeminiGenerateContentContent],
        },
        'gpt-test',
        new Map(),
      ),
    Error,
    '"tool" is not a supported content role.',
  );
});

test('buildTargetRequest rejects a part with an unsupported kind in user content', () => {
  assertThrows(
    () =>
      buildTargetRequest(
        {
          contents: [{ role: 'user', parts: [{ codeExecutionResult: { outcome: 'OK' } }] }],
        },
        'gpt-test',
        new Map(),
      ),
    Error,
    '"code_execution_result" parts are not supported in user content.',
  );
});

test('buildTargetRequest rejects a function_call part in user content', () => {
  assertThrows(
    () =>
      buildTargetRequest(
        {
          contents: [{ role: 'user', parts: [{ functionCall: { name: 'x', args: {} } }] }],
        },
        'gpt-test',
        new Map(),
      ),
    Error,
    '"function_call" parts are not supported in user content.',
  );
});

test('buildTargetRequest rejects an inline_data part in model content', () => {
  assertThrows(
    () =>
      buildTargetRequest(
        {
          contents: [{ role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1n' } }] }],
        },
        'gpt-test',
        new Map(),
      ),
    Error,
    '"inline_data" parts are not supported in model content.',
  );
});

test('buildTargetRequest rejects a part that sets conflicting content fields', () => {
  assertThrows(
    () =>
      buildTargetRequest(
        {
          contents: [{ role: 'model', parts: [{ text: 'foo', functionCall: { name: 'x', args: {} } } as unknown as GeminiGenerateContentPart] }],
        },
        'gpt-test',
        new Map(),
      ),
    Error,
    'sets conflicting content fields',
  );
});

test('buildTargetRequest rejects a part with no recognized content field', () => {
  assertThrows(
    () =>
      buildTargetRequest(
        {
          contents: [{ role: 'user', parts: [{}] }],
        },
        'gpt-test',
        new Map(),
      ),
    Error,
    'has no recognized content',
  );
});
