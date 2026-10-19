import { test } from 'vitest';

import { buildTargetRequest as buildTargetRequestWithSidecar } from '../../../../src/protocols/gemini-generate-content/via-openai-chat-completions/request.ts';
import { createTestSidecarCodec } from '../../../round-trip/sidecar-codec.ts';
import type { GeminiGenerateContentPart, GeminiGenerateContentContent, GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsAssistantMessageEx } from '@floway-dev/protocols/openai-chat-completions';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const buildWithTestSidecar = (
  payload: Parameters<typeof buildTargetRequestWithSidecar>[0],
  model: Parameters<typeof buildTargetRequestWithSidecar>[1],
) => buildTargetRequestWithSidecar(payload, model, createTestSidecarCodec());

test('buildTargetRequest forwards an empty thinkingLevel verbatim', async () => {
  const request = await buildWithTestSidecar({
    contents: [],
    generationConfig: { thinkingConfig: { thinkingLevel: '' } },
  }, 'gpt-test');

  assertEquals(request.reasoning_effort, '');
});

test('buildTargetRequest gives thinkingBudget precedence over an empty thinkingLevel', async () => {
  const request = await buildWithTestSidecar({
    contents: [],
    generationConfig: { thinkingConfig: { thinkingBudget: 2048, thinkingLevel: '' } },
  }, 'gpt-test');

  assertEquals(request.reasoning_effort, 'low');
});

test('buildTargetRequest maps system instruction and multimodal user content', async () => {
  const payload: GeminiGenerateContentPayload = {
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

  assertEquals(await buildWithTestSidecar(payload, 'gpt-test'), {
    model: 'gpt-test',
    stream: true,
    messages: [
      { role: 'system', content: 'Be precise.\n\nUse markdown.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image.' },
          {
            type: 'file',
            file: { file_data: 'data:application/pdf;base64,cGRm' },
          },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,aW1hZ2U=' },
          },
        ],
      },
    ],
  });
});

test('buildTargetRequest maps Gemini inline audio to Chat Completions input audio', async () => {
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

test('buildTargetRequest rejects unsupported Gemini inline data MIME types for Chat Completions', async () => {
  await assertRejects(
    () => buildWithTestSidecar({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'text/plain', data: 'dGV4dA==' } }] }] }, 'gpt-test'),
    Error,
    "Cannot translate Gemini generateContent inlineData MIME type 'text/plain' to OpenAI Chat Completions.",
  );
});

test('buildTargetRequest maps function calls, tool responses, and readable reasoning history', async () => {
  const payload: GeminiGenerateContentPayload = {
    contents: [
      {
        role: 'model',
        parts: [{ text: 'private trace', thought: true, thoughtSignature: 'sig_old' }, { text: 'I will call a tool.', thoughtSignature: 'sig_1' }, { functionCall: { name: 'lookup', args: { query: 'docs' } } }],
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

  assertEquals((await buildWithTestSidecar(payload, 'gpt-test')).messages, [
    {
      role: 'assistant',
      content: 'I will call a tool.',
      reasoning_text: 'private trace',
      tool_calls: [
        {
          id: 'gemini_call_0_2',
          type: 'function',
          function: { name: 'lookup', arguments: '{"query":"docs"}' },
        },
      ],
    } as OpenAIChatCompletionsAssistantMessageEx,
    {
      role: 'tool',
      tool_call_id: 'gemini_call_0_2',
      content: '{"answer":42}',
    },
  ]);
});

test('buildTargetRequest matches omitted functionResponse ids to same-name calls in call order', async () => {
  const payload: GeminiGenerateContentPayload = {
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

  assertEquals((await buildWithTestSidecar(payload, 'gpt-test')).messages, [
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

test('buildTargetRequest does not rematch a prior call already answered by explicit id', async () => {
  const payload: GeminiGenerateContentPayload = {
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

  assertEquals((await buildWithTestSidecar(payload, 'gpt-test')).messages, [
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

test('buildTargetRequest maps generation config and reasoning effort', async () => {
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

test('buildTargetRequest maps structured output schema and zero thinking budget', async () => {
  const schema = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  };

  assertEquals(
    await buildWithTestSidecar(
      {
        contents: [],
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

  assertEquals(await buildWithTestSidecar(payload, 'gpt-test'), {
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
    (await buildWithTestSidecar(
      {
        contents: [],
        tools: [{ functionDeclarations: [{ name: 'lookup' }] }],
        toolConfig: { functionCallingConfig: { mode: 'NONE' } },
      },
      'gpt-test',
    )).tool_choice,
    'none',
  );
  assertEquals(
    (await buildWithTestSidecar(
      {
        contents: [],
        tools: [{ functionDeclarations: [{ name: 'lookup' }] }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      },
      'gpt-test',
    )).tool_choice,
    'auto',
  );
  assertEquals(
    (await buildWithTestSidecar(
      {
        contents: [],
        tools: [{ functionDeclarations: [{ name: 'lookup' }] }],
        toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } },
      },
      'gpt-test',
    )).tool_choice,
    'auto',
  );
  assertEquals(
    (await buildWithTestSidecar(
      {
        contents: [],
        tools: [{ functionDeclarations: [{ name: 'lookup' }] }],
        toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      },
      'gpt-test',
    )).tool_choice,
    'required',
  );
  assertEquals((await buildWithTestSidecar({ contents: [], toolConfig: { functionCallingConfig: { mode: 'ANY' } } }, 'gpt-test')).tool_choice, undefined);
});

test('buildTargetRequest filters tools to allowed function names for ANY mode', async () => {
  const result = await buildWithTestSidecar(
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

test('buildTargetRequest maps thinking budget thresholds', async () => {
  assertEquals((await buildWithTestSidecar({ contents: [], generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }, 'gpt-test')).reasoning_effort, 'none');
  assertEquals((await buildWithTestSidecar({ contents: [], generationConfig: { thinkingConfig: { thinkingBudget: -1 } } }, 'gpt-test')).reasoning_effort, undefined);
  assertEquals((await buildWithTestSidecar({ contents: [], generationConfig: { thinkingConfig: { thinkingBudget: 2048 } } }, 'gpt-test')).reasoning_effort, 'low');
  assertEquals((await buildWithTestSidecar({ contents: [], generationConfig: { thinkingConfig: { thinkingBudget: 8192 } } }, 'gpt-test')).reasoning_effort, 'medium');
  assertEquals((await buildWithTestSidecar({ contents: [], generationConfig: { thinkingConfig: { thinkingBudget: 8193 } } }, 'gpt-test')).reasoning_effort, 'high');
});

test('buildTargetRequest rejects an unknown content role', async () => {
  await assertRejects(
    () =>
      buildWithTestSidecar(
        {
          contents: [{ role: 'system', parts: [{ text: 'Hi' }] } as unknown as GeminiGenerateContentContent],
        },
        'gpt-test',
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
          contents: [{ role: 'user', parts: [{ executableCode: { language: 'PYTHON', code: 'print(1)' } }] }],
        },
        'gpt-test',
      ),
    Error,
    '"executable_code" parts are not supported in user content.',
  );
});

test('buildTargetRequest rejects a function_call part in user content', async () => {
  await assertRejects(
    () =>
      buildWithTestSidecar(
        {
          contents: [{ role: 'user', parts: [{ functionCall: { name: 'x', args: {} } }] }],
        },
        'gpt-test',
      ),
    Error,
    '"function_call" parts are not supported in user content.',
  );
});

test('buildTargetRequest rejects a function_response part in model content', async () => {
  await assertRejects(
    () =>
      buildWithTestSidecar(
        {
          contents: [{ role: 'model', parts: [{ functionResponse: { name: 'x', response: {} } }] }],
        },
        'gpt-test',
      ),
    Error,
    '"function_response" parts are not supported in model content.',
  );
});

test('buildTargetRequest rejects a part that sets conflicting content fields', async () => {
  await assertRejects(
    () =>
      buildWithTestSidecar(
        {
          contents: [{ role: 'model', parts: [{ text: 'foo', functionCall: { name: 'x', args: {} } } as unknown as GeminiGenerateContentPart] }],
        },
        'gpt-test',
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
        'gpt-test',
      ),
    Error,
    'has no recognized content',
  );
});

test('buildTargetRequest extends reasoning_effort enum to recognize xhigh and max', async () => {
  const xhigh = await buildWithTestSidecar(
    { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], generationConfig: { thinkingConfig: { thinkingLevel: 'xhigh' } } },
    'gpt-test',
  );
  const max = await buildWithTestSidecar(
    { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], generationConfig: { thinkingConfig: { thinkingLevel: 'max' } } },
    'gpt-test',
  );
  const minimal = await buildWithTestSidecar(
    { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], generationConfig: { thinkingConfig: { thinkingLevel: 'minimal' } } },
    'gpt-test',
  );

  assertEquals(xhigh.reasoning_effort, 'xhigh');
  assertEquals(max.reasoning_effort, 'max');
  assertEquals(minimal.reasoning_effort, 'minimal');
});

test('buildTargetRequest forwards a vendor-specific thinkingLevel verbatim (no enum gate)', async () => {
  const turbo = await buildWithTestSidecar(
    { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], generationConfig: { thinkingConfig: { thinkingLevel: 'turbo' } } },
    'gpt-test',
  );
  assertEquals(turbo.reasoning_effort, 'turbo');
});

test('buildTargetRequest preserves an explicitly empty model text turn', async () => {
  assertEquals((await buildWithTestSidecar({
    contents: [
      { role: 'user', parts: [{ text: 'first' }] },
      { role: 'model', parts: [{ text: '' }] },
      { role: 'user', parts: [{ text: 'second' }] },
    ],
  }, 'm')).messages, [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: '' },
    { role: 'user', content: 'second' },
  ]);
});

test.each([undefined, []])('preserves an empty model turn with parts %j', async parts => {
  const payload = { contents: [{ role: 'user', parts: [{ text: 'before' }] }, { role: 'model', ...(parts === undefined ? {} : { parts }) }, { role: 'user', parts: [{ text: 'after' }] }] };
  const result = await buildWithTestSidecar(payload, 'target-model');
  assertEquals((result.messages as Array<{ role?: string; content?: unknown }>).filter(item => item.role === 'assistant'), [{ role: 'assistant', content: '' }]);
});
