import { test } from 'vitest';

import { buildTargetRequest } from '../../../../src/protocols/gemini-generate-content/via-openai-responses/request.ts';
import { createTestSidecarCodec } from '../../../round-trip/sidecar-codec.ts';
import type { GeminiGenerateContentPart, GeminiGenerateContentContent, GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import { assertEquals, assertFalse, assertRejects } from '@floway-dev/test-utils';

test('buildTargetRequest forwards an empty thinkingLevel verbatim', async () => {
  const request = await buildTargetRequest({
    contents: [],
    generationConfig: { thinkingConfig: { thinkingLevel: '', includeThoughts: true } },
  }, 'gpt-test', createTestSidecarCodec());
  assertEquals(request.reasoning, { effort: '', summary: 'detailed' });
});
test('buildTargetRequest gives thinkingBudget precedence over an empty thinkingLevel', async () => {
  const request = await buildTargetRequest({
    contents: [],
    generationConfig: { thinkingConfig: { thinkingBudget: 2048, thinkingLevel: '', includeThoughts: true } },
  }, 'gpt-test', createTestSidecarCodec());
  assertEquals(request.reasoning, { effort: 'low', summary: 'detailed' });
});
test('buildTargetRequest maps instructions and multimodal user input without defaults', async () => {
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
  assertEquals(await buildTargetRequest(payload, 'gpt-test', createTestSidecarCodec()), {
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
            type: 'input_file',
            file_data: 'data:application/pdf;base64,cGRm',
          },
          {
            type: 'input_image',
            image_url: 'data:image/png;base64,aW1hZ2U=',
          },
        ],
      },
    ],
  });
});
test.each(['audio/wav', 'audio/mp3', 'audio/mpeg', 'text/plain'])('buildTargetRequest rejects Gemini inline data MIME type %s for Responses', async mimeType => {
  await assertRejects(async () => await buildTargetRequest({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: 'ZGF0YQ==' } }] }] }, 'gpt-test', createTestSidecarCodec()), Error, `Cannot translate Gemini generateContent inlineData MIME type '${mimeType}' to OpenAI Responses.`);
});
test('buildTargetRequest maps assistant reasoning, function calls, and call-order outputs', async () => {
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
  assertEquals((await buildTargetRequest(payload, 'gpt-test', createTestSidecarCodec())).input, [
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
test('buildTargetRequest ignores thought signatures when translating to OpenAI Responses', async () => {
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
  assertEquals((await buildTargetRequest(payload, 'gpt-test', createTestSidecarCodec())).input, [
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
test('buildTargetRequest maps generation config, JSON schema, and reasoning controls', async () => {
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
  assertEquals(await buildTargetRequest(payload, 'gpt-test', createTestSidecarCodec()), {
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
  assertEquals((await buildTargetRequest({ contents: [], generationConfig: { responseMimeType: 'application/json' } }, 'gpt-test', createTestSidecarCodec())).text, { format: { type: 'json_object' } });
});
test('buildTargetRequest never invents reasoning.context from Gemini generateContent thinking controls', async () => {
  const result = await buildTargetRequest({
    contents: [],
    generationConfig: {
      thinkingConfig: { thinkingLevel: 'high', includeThoughts: true },
    },
  }, 'gpt-test', createTestSidecarCodec());
  assertEquals(result.reasoning, { effort: 'high', summary: 'detailed' });
  assertEquals(result.reasoning?.context, undefined);
  assertFalse('context' in (result.reasoning ?? {}));
});
test('buildTargetRequest filters tools to allowed function names for ANY mode', async () => {
  const result = await buildTargetRequest({
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
  }, 'gpt-test', createTestSidecarCodec());
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
test('buildTargetRequest maps thinking budget thresholds and zero-budget disable', async () => {
  assertEquals((await buildTargetRequest({ contents: [], generationConfig: { thinkingConfig: { thinkingBudget: 2048 } } }, 'gpt-test', createTestSidecarCodec())).reasoning, { effort: 'low' });
  assertEquals((await buildTargetRequest({ contents: [], generationConfig: { thinkingConfig: { thinkingBudget: 8192 } } }, 'gpt-test', createTestSidecarCodec())).reasoning, { effort: 'medium' });
  assertEquals((await buildTargetRequest({ contents: [], generationConfig: { thinkingConfig: { thinkingBudget: 8193 } } }, 'gpt-test', createTestSidecarCodec())).reasoning, { effort: 'high' });
  assertEquals((await buildTargetRequest({
    contents: [],
    generationConfig: {
      thinkingConfig: { thinkingBudget: 0, includeThoughts: true },
    },
  }, 'gpt-test', createTestSidecarCodec())).reasoning, { effort: 'none' });
  assertEquals((await buildTargetRequest({ contents: [], generationConfig: { thinkingConfig: { thinkingBudget: -1 } } }, 'gpt-test', createTestSidecarCodec())).reasoning, undefined);
});
test('buildTargetRequest maps tool declarations and tool choice modes only when tools exist', async () => {
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
  assertEquals(await buildTargetRequest(payload, 'gpt-test', createTestSidecarCodec()), {
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
  assertEquals((await buildTargetRequest({
    contents: [],
    tools: [{ functionDeclarations: [{ name: 'lookup' }] }],
    toolConfig: { functionCallingConfig: { mode: 'NONE' } },
  }, 'gpt-test', createTestSidecarCodec())).tool_choice, 'none');
  assertEquals((await buildTargetRequest({
    contents: [],
    tools: [{ functionDeclarations: [{ name: 'lookup' }] }],
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
  }, 'gpt-test', createTestSidecarCodec())).tool_choice, 'auto');
  assertEquals((await buildTargetRequest({
    contents: [],
    tools: [{ functionDeclarations: [{ name: 'lookup' }] }],
    toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } },
  }, 'gpt-test', createTestSidecarCodec())).tool_choice, 'auto');
  assertEquals((await buildTargetRequest({
    contents: [],
    tools: [{ functionDeclarations: [{ name: 'lookup' }] }],
    toolConfig: { functionCallingConfig: { mode: 'ANY' } },
  }, 'gpt-test', createTestSidecarCodec())).tool_choice, 'required');
  assertEquals((await buildTargetRequest({ contents: [], toolConfig: { functionCallingConfig: { mode: 'ANY' } } }, 'gpt-test', createTestSidecarCodec())).tool_choice, undefined);
});
test('buildTargetRequest rejects an unknown content role', async () => {
  await assertRejects(async () => await buildTargetRequest({
    contents: [{ role: 'tool', parts: [{ text: 'Hi' }] } as unknown as GeminiGenerateContentContent],
  }, 'gpt-test', createTestSidecarCodec()), Error, '"tool" is not a supported content role.');
});
test('buildTargetRequest rejects a part with an unsupported kind in user content', async () => {
  await assertRejects(async () => await buildTargetRequest({
    contents: [{ role: 'user', parts: [{ codeExecutionResult: { outcome: 'OK' } }] }],
  }, 'gpt-test', createTestSidecarCodec()), Error, '"code_execution_result" parts are not supported in user content.');
});
test('buildTargetRequest rejects a function_call part in user content', async () => {
  await assertRejects(async () => await buildTargetRequest({
    contents: [{ role: 'user', parts: [{ functionCall: { name: 'x', args: {} } }] }],
  }, 'gpt-test', createTestSidecarCodec()), Error, '"function_call" parts are not supported in user content.');
});
test('buildTargetRequest rejects an inline_data part in model content', async () => {
  await assertRejects(async () => await buildTargetRequest({
    contents: [{ role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1n' } }] }],
  }, 'gpt-test', createTestSidecarCodec()), Error, '"inline_data" parts are not supported in model content.');
});
test('buildTargetRequest rejects a part that sets conflicting content fields', async () => {
  await assertRejects(async () => await buildTargetRequest({
    contents: [{ role: 'model', parts: [{ text: 'foo', functionCall: { name: 'x', args: {} } } as unknown as GeminiGenerateContentPart] }],
  }, 'gpt-test', createTestSidecarCodec()), Error, 'sets conflicting content fields');
});
test('buildTargetRequest rejects a part with no recognized content field', async () => {
  await assertRejects(async () => await buildTargetRequest({
    contents: [{ role: 'user', parts: [{}] }],
  }, 'gpt-test', createTestSidecarCodec()), Error, 'has no recognized content');
});
test.each([undefined, []])('preserves an empty model turn with parts %j', async parts => {
  const payload = { contents: [{ role: 'user', parts: [{ text: 'before' }] }, { role: 'model', ...(parts === undefined ? {} : { parts }) }, { role: 'user', parts: [{ text: 'after' }] }] };
  const result = await buildTargetRequest(payload, 'target-model', createTestSidecarCodec());
  assertEquals((result.input as Array<{
    role?: string;
    content?: unknown;
  }>).filter(item => item.role === 'assistant'), [{ type: 'message', role: 'assistant', content: '' }]);
});
