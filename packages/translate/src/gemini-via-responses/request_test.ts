import { test } from 'vitest';

import { buildTargetRequest } from './request.ts';
import { assertEquals } from '../test-assert.ts';
import type { GeminiGenerateContentRequest } from '@floway-dev/protocols/gemini';

test('buildTargetRequest maps instructions and multimodal user input without defaults', () => {
  const payload: GeminiGenerateContentRequest = {
    systemInstruction: {
      parts: [{ text: 'Be precise.' }, { text: 'Use markdown.' }],
    },
    contents: [
      {
        parts: [{ text: 'Describe this image.' }, { inlineData: { mimeType: 'application/pdf', data: 'cGRm' } }, { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }],
      },
    ],
  };

  assertEquals(buildTargetRequest(payload, 'gpt-test'), {
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
            detail: 'auto',
          },
        ],
      },
    ],
  });
});

test('buildTargetRequest maps assistant reasoning, function calls, and call-order outputs', () => {
  const payload: GeminiGenerateContentRequest = {
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

  assertEquals(buildTargetRequest(payload, 'gpt-test').input, [
    {
      type: 'reasoning',
      id: 'gemini_reasoning_0_0',
      summary: [{ type: 'summary_text', text: 'private trace' }],
    },
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

test('buildTargetRequest ignores thought signatures when translating to Responses', () => {
  const payload: GeminiGenerateContentRequest = {
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

  assertEquals(buildTargetRequest(payload, 'gpt-test').input, [
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
  const payload: GeminiGenerateContentRequest = {
    generationConfig: {
      maxOutputTokens: 512,
      temperature: 0.25,
      topP: 0.8,
      responseMimeType: 'application/json',
      responseSchema: schema,
      thinkingConfig: { thinkingLevel: 'medium', includeThoughts: true },
    },
  };

  assertEquals(buildTargetRequest(payload, 'gpt-test'), {
    model: 'gpt-test',
    stream: true,
    input: [],
    max_output_tokens: 512,
    temperature: 0.25,
    top_p: 0.8,
    text: {
      format: {
        type: 'json_schema',
        json_schema: { name: 'gemini_response', schema },
      },
    },
    reasoning: { effort: 'medium', summary: 'detailed' },
  });

  assertEquals(buildTargetRequest({ generationConfig: { responseMimeType: 'application/json' } }, 'gpt-test').text, { format: { type: 'json_object' } });
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
  assertEquals(buildTargetRequest({ generationConfig: { thinkingConfig: { thinkingBudget: 2048 } } }, 'gpt-test').reasoning, { effort: 'low' });
  assertEquals(buildTargetRequest({ generationConfig: { thinkingConfig: { thinkingBudget: 8192 } } }, 'gpt-test').reasoning, { effort: 'medium' });
  assertEquals(buildTargetRequest({ generationConfig: { thinkingConfig: { thinkingBudget: 8193 } } }, 'gpt-test').reasoning, { effort: 'high' });
  assertEquals(
    buildTargetRequest(
      {
        generationConfig: {
          thinkingConfig: { thinkingBudget: 0, includeThoughts: true },
        },
      },
      'gpt-test',
    ).reasoning,
    { effort: 'none' },
  );
  assertEquals(buildTargetRequest({ generationConfig: { thinkingConfig: { thinkingBudget: -1 } } }, 'gpt-test').reasoning, undefined);
});

test('buildTargetRequest maps tool declarations and tool choice modes only when tools exist', () => {
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

  assertEquals(buildTargetRequest(payload, 'gpt-test'), {
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
