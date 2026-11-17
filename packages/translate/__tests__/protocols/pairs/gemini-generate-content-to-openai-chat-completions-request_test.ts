import { test } from 'vitest';

import { buildTargetPayloadFor, pairs } from '../../composition/helpers.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsAssistantMessageEx } from '@floway-dev/protocols/openai-chat-completions';
import { assertEquals } from '@floway-dev/test-utils';

const buildWithTestSidecar = (
  payload: GeminiGenerateContentPayload,
  model: string,
) => buildTargetPayloadFor(pairs.geminiToChat[0], pairs.geminiToChat[1], { ...payload, model }, { sidecarCodec: createTestSidecarCodec() });

test('buildTargetPayload preserves an explicit empty thinkingLevel beside a budget', async () => {
  const request = await buildWithTestSidecar({
    contents: [],
    generationConfig: { thinkingConfig: { thinkingBudget: 2048, thinkingLevel: '' } },
  }, 'gpt-test');

  assertEquals(request.reasoning_effort, '');
});

test('buildTargetPayload maps system instruction and multimodal user content', async () => {
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
    stream_options: { include_usage: true, continuous_usage_stats: true },
    messages: [
      { role: 'system', content: 'Be precise.Use markdown.' },
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

test('buildTargetPayload maps function calls, tool responses, and readable reasoning history', async () => {
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
          id: 'lookup_call_1',
          type: 'function',
          function: { name: 'lookup', arguments: '{"query":"docs"}' },
        },
      ],
    } as OpenAIChatCompletionsAssistantMessageEx,
    {
      role: 'tool',
      tool_call_id: 'lookup_call_1',
      content: '{"answer":42}',
    },
  ]);
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

test('buildTargetPayload maps structured output schema and zero thinking budget', async () => {
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
      stream_options: { include_usage: true, continuous_usage_stats: true },
      messages: [],
      reasoning_effort: 'none',
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'gemini_response', schema },
      },
    },
  );
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
    stream_options: { include_usage: true, continuous_usage_stats: true },
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
      { type: 'function', function: { name: 'ping' } },
    ],
    tool_choice: { type: 'allowed_tools', allowed_tools: { mode: 'required', tools: [{ type: 'function', function: { name: 'lookup' } }] } },
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

test('buildTargetPayload preserves declarations and restricts callable names for ANY mode', async () => {
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
    { type: 'function', function: { name: 'forbidden' } },
  ]);
  assertEquals(result.tool_choice, { type: 'allowed_tools', allowed_tools: { mode: 'required', tools: [{ type: 'function', function: { name: 'lookup' } }, { type: 'function', function: { name: 'ping' } }] } });
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

test('a call with no argument object is written with an empty one', async () => {
  const request = await buildWithTestSidecar({ contents: [{ role: 'model', parts: [{ functionCall: { name: 'f' } }] }] }, 'gpt-test');

  const call = request.messages.flatMap(message => message.role === 'assistant' && message.tool_calls !== undefined ? message.tool_calls : [])[0];
  assertEquals(call?.type === 'function' ? call.function.arguments : undefined, '{}');
});
