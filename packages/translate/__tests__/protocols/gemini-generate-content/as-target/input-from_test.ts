import { expect, test } from 'vitest';

import { createTestSidecarCodec } from '../../../round-trip/sidecar-codec.ts';
import { iterate } from '../../../shared/iterables.ts';
import { expectTrip } from '../../../trip.ts';
import { collectAnthropicMessagesProtocolEventsToResult, type AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, FAST_SERVICE_TIER, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import { collectOpenAIChatCompletionsProtocolEventsToResult, type OpenAIChatCompletionsAssistantMessageEx, type OpenAIChatCompletionsPayload, type OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import { collectOpenAIResponsesProtocolEventsToResult, toOpenAIResponsesInputItems, type OpenAIResponsesRequestPayloadEx } from '@floway-dev/protocols/openai-responses';
import {
  routeAnthropicMessagesViaGeminiGenerateContent,
  routeOpenAIChatCompletionsViaGeminiGenerateContent,
  routeOpenAIResponsesViaGeminiGenerateContent,
} from '@floway-dev/translate';

const options = () => ({ sidecarCodec: createTestSidecarCodec('gemini-target-input') });

test('translates Anthropic Messages system, documents, tool results, thinking budget, and tool choices to Gemini', async () => {
  const payload: AnthropicMessagesPayload = {
    model: 'gemini-2.5-pro',
    max_tokens: 4096,
    stream: true,
    temperature: 0.2,
    top_k: 40,
    stop_sequences: ['STOP_HERE'],
    speed: 'fast',
    thinking: { type: 'enabled', budget_tokens: 2048 },
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    },
    system: [{ type: 'text', text: 'System rule 1.' }, { type: 'text', text: 'System rule 2.' }],
    tools: [
      { name: 'read_doc', description: 'Read a doc', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'list_dir', input_schema: { type: 'object', properties: {} } },
    ],
    tool_choice: { type: 'tool', name: 'read_doc' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect this:' },
          { type: 'document', title: 'Notes', source: { type: 'text', media_type: 'text/plain', data: 'Doc body' } },
          { type: 'image', source: { type: 'url', url: 'https://example.com/diagram.png' } },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Unverified foreign thinking', signature: 'foreign' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_doc', input: { path: '/a.md' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            is_error: true,
            content: [
              { type: 'text', text: 'ENOENT' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1n' } },
            ],
          },
        ],
      },
    ],
  };

  const trip = expectTrip(await routeAnthropicMessagesViaGeminiGenerateContent(payload, options()));
  expect(trip.target).toEqual({
    model: 'gemini-2.5-pro',
    serviceTier: FAST_SERVICE_TIER,
    systemInstruction: { parts: [{ text: 'System rule 1.' }, { text: 'System rule 2.' }] },
    tools: [{
      functionDeclarations: [
        { name: 'read_doc', description: 'Read a doc', parametersJsonSchema: { type: 'object', properties: { path: { type: 'string' } } } },
        { name: 'list_dir', parametersJsonSchema: { type: 'object', properties: {} } },
      ],
    }],
    toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['read_doc'] } },
    generationConfig: {
      maxOutputTokens: 4096,
      temperature: 0.2,
      topK: 40,
      stopSequences: ['STOP_HERE'],
      responseMimeType: 'application/json',
      responseJsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      // Explicit numeric budget wins over `effort` without setting `thinkingLevel` alongside `thinkingBudget`.
      thinkingConfig: { thinkingBudget: 2048, includeThoughts: true },
    },
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'Inspect this:' },
          { text: '<document>\n<title>Notes</title>' },
          { text: 'Doc body' },
          { text: '</document>' },
          { fileData: { fileUri: 'https://example.com/diagram.png' } },
        ],
      },
      {
        role: 'model',
        parts: [{
          functionCall: { id: 'toolu_1', name: 'read_doc', args: { path: '/a.md' } },
          thoughtSignature: 'skip_thought_signature_validator',
        }],
      },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            id: 'toolu_1',
            name: 'read_doc',
            response: { error: 'ENOENT' },
            parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1n' } }],
          },
        }],
      },
    ],
  });
});

test('translates OpenAI Responses namespaces, custom tools, allowed_tools subsets, effort xhigh, and reasoning_summary to Gemini', async () => {
  const source: OpenAIResponsesRequestPayloadEx = {
    model: 'gemini-2.5-pro',
    stream: true,
    instructions: 'Top-level instructions',
    reasoning: { effort: 'xhigh', summary: 'detailed' },
    service_tier: 'default',
    tools: [
      {
        type: 'namespace',
        name: 'fs',
        description: 'Filesystem',
        tools: [
          { type: 'function', name: 'read', parameters: { type: 'object', properties: { p: { type: 'string' } } } },
          { type: 'custom', name: 'patch', format: { type: 'text' } },
        ],
      },
      { type: 'function', name: 'other', parameters: { type: 'object', properties: {} } },
    ],
    tool_choice: {
      type: 'allowed_tools',
      mode: 'auto',
      tools: [{ type: 'custom', name: 'fs.patch' }],
    },
    input: [
      { type: 'message', role: 'developer', content: 'Leading developer guidance' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Apply patch' }] },
      { type: 'message', role: 'developer', content: 'Mid-turn developer note' },
    ],
  };

  const trip = expectTrip(await routeOpenAIResponsesViaGeminiGenerateContent(source, {
    ...options(),
    fallbackMaxOutputTokens: 8192,
  }));
  expect(trip.target.serviceTier).toBe('standard');
  expect(trip.target.systemInstruction).toEqual({
    parts: [{ text: 'Top-level instructions' }],
  });
  expect(trip.target.tools?.[0]?.functionDeclarations?.map(d => d.name)).toEqual([
    'fs_read',
    'fs_patch',
    'other',
  ]);
  expect(trip.target.toolConfig).toEqual({
    functionCallingConfig: {
      mode: 'VALIDATED',
      allowedFunctionNames: ['fs_patch'],
    },
  });
  expect(trip.target.generationConfig).toEqual({
    maxOutputTokens: 8192,
    thinkingConfig: { thinkingLevel: 'XHIGH', includeThoughts: true },
  });
  expect(trip.target.contents).toEqual([{
    role: 'user',
    parts: [{ text: 'Leading developer guidance' }, { text: 'Apply patch' }, { text: 'Mid-turn developer note' }],
  }]);

  const summaryOnly = expectTrip(await routeOpenAIResponsesViaGeminiGenerateContent({
    model: 'gemini-2.5-pro',
    stream: true,
    reasoning: { summary: 'omitted' },
    input: 'Hi',
  }, options()));
  expect(summaryOnly.target.generationConfig).toEqual({
    thinkingConfig: { includeThoughts: false },
  });
});

test('hoists leading developer messages when no top-level instruction exists and merges consecutive user turns across a dropped reasoning turn', async () => {
  const chat: OpenAIChatCompletionsPayload = {
    model: 'gemini-2.5-pro',
    stream: true,
    reasoning_effort: 'none',
    logprobs: true,
    top_logprobs: 3,
    n: 2,
    messages: [
      { role: 'developer', content: 'Hoisted developer rule' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Multimodal user turn' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,aGVsbG8=' } },
          { type: 'input_audio', input_audio: { data: 'YXVk', format: 'wav' } },
        ],
      },
    ],
  };

  const chatTrip = expectTrip(await routeOpenAIChatCompletionsViaGeminiGenerateContent(chat, options()));
  expect(chatTrip.target.systemInstruction).toEqual({ parts: [{ text: 'Hoisted developer rule' }] });
  expect(chatTrip.target.generationConfig).toEqual({
    candidateCount: 2,
    responseLogprobs: true,
    logprobs: 3,
    thinkingConfig: { thinkingBudget: 0 },
  });
  expect(chatTrip.target.contents).toEqual([
    {
      role: 'user',
      parts: [
        { text: 'Multimodal user turn' },
        { inlineData: { mimeType: 'image/jpeg', data: 'aGVsbG8=' } },
        { inlineData: { mimeType: 'audio/wav', data: 'YXVk' } },
      ],
    },
  ]);

  const mergedUsers = expectTrip(await routeOpenAIResponsesViaGeminiGenerateContent({
    model: 'gemini-2.5-pro',
    stream: true,
    input: [
      { type: 'message', role: 'user', content: 'First user turn' },
      { type: 'reasoning', id: 'rs_foreign', summary: [{ type: 'summary_text', text: 'Dropped unverified reasoning' }] },
      { type: 'message', role: 'user', content: 'Second user turn' },
    ],
  }, options()));
  expect(mergedUsers.target.contents).toEqual([
    { role: 'user', parts: [{ text: 'First user turn' }, { text: 'Second user turn' }] },
  ]);
});

test('round-trips parallel id-less Gemini functionCalls (answered out of order) and thoughtSignature across Responses, Messages, and Chat clients', async () => {
  const codec = createTestSidecarCodec('idless-gemini-roundtrip');
  const geminiFrames = (calls: readonly { name: string; args: Record<string, unknown>; sig: string }[]): ProtocolFrame<GeminiGenerateContentStreamEvent>[] => [
    eventFrame({
      responseId: 'gem_rt_1',
      modelVersion: 'gemini-2.5-pro',
      candidates: [{
        index: 0,
        content: {
          role: 'model',
          parts: [
            { thought: true, text: 'Planning tool calls.', thoughtSignature: 'sig_plan' },
            ...calls.map(call => ({ functionCall: { name: call.name, args: call.args }, thoughtSignature: call.sig })),
          ],
        },
        finishReason: 'STOP',
      }],
    }),
    doneFrame(),
  ];

  // 1. OpenAI Responses with grouped custom tool + function tool answered out of order
  const respTurn1: OpenAIResponsesRequestPayloadEx = {
    model: 'gemini-2.5-pro',
    stream: true,
    tools: [
      {
        type: 'namespace',
        name: 'code',
        description: 'Coding tools',
        tools: [{ type: 'custom', name: 'patch', format: { type: 'text' } }],
      },
      { type: 'function', name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    ],
    input: 'Edit file',
  };
  const respTrip1 = expectTrip(await routeOpenAIResponsesViaGeminiGenerateContent(respTurn1, { sidecarCodec: codec }));
  const respResult1 = await collectOpenAIResponsesProtocolEventsToResult(
    respTrip1.events(iterate(geminiFrames([
      { name: 'code_patch', args: { input: '*** Patch' }, sig: 'sig_patch' },
      { name: 'read', args: { path: '/a.ts' }, sig: 'sig_read' },
    ]))),
  );
  const respPatch = respResult1.output.find(item => item.type === 'custom_tool_call');
  const respRead = respResult1.output.find(item => item.type === 'function_call');
  if (respPatch === undefined || respRead === undefined) throw new Error('Expected translated tool calls');
  expect(respPatch).toMatchObject({ type: 'custom_tool_call', namespace: 'code', name: 'patch', input: '*** Patch' });

  const respTurn2: OpenAIResponsesRequestPayloadEx = {
    ...respTurn1,
    input: [
      { type: 'message', role: 'user', content: 'Edit file' },
      ...toOpenAIResponsesInputItems(respResult1.output),
      { type: 'function_call_output', call_id: respRead.call_id, output: '{"ok":true}' },
      { type: 'custom_tool_call_output', call_id: respPatch.call_id, output: '{"applied":true}' },
    ],
  };
  const respTrip2 = expectTrip(await routeOpenAIResponsesViaGeminiGenerateContent(respTurn2, { sidecarCodec: codec }));
  expect(respTrip2.target.contents).toEqual([
    { role: 'user', parts: [{ text: 'Edit file' }] },
    {
      role: 'model',
      parts: [
        { thought: true, text: 'Planning tool calls.', thoughtSignature: 'sig_plan' },
        { functionCall: { name: 'code_patch', args: { input: '*** Patch' } }, thoughtSignature: 'sig_patch' },
        { functionCall: { name: 'read', args: { path: '/a.ts' } }, thoughtSignature: 'sig_read' },
      ],
    },
    {
      role: 'user',
      parts: [
        { functionResponse: { name: 'read', response: { ok: true } } },
        { functionResponse: { name: 'code_patch', response: { applied: true } } },
      ],
    },
  ]);

  // 2. Anthropic Messages
  const msgTurn1: AnthropicMessagesPayload = {
    model: 'gemini-2.5-pro',
    max_tokens: 1024,
    stream: true,
    tools: [{ name: 'bash', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } }],
    messages: [{ role: 'user', content: 'Run ls' }],
  };
  const msgTrip1 = expectTrip(await routeAnthropicMessagesViaGeminiGenerateContent(msgTurn1, { sidecarCodec: codec }));
  const msgResult1 = await collectAnthropicMessagesProtocolEventsToResult(
    msgTrip1.events(iterate(geminiFrames([{ name: 'bash', args: { cmd: 'ls' }, sig: 'sig_call' }]))),
  );
  const toolUse = msgResult1.content.find(block => block.type === 'tool_use');
  if (toolUse === undefined) throw new Error('Expected translated tool_use');
  const msgTrip2 = expectTrip(await routeAnthropicMessagesViaGeminiGenerateContent({
    ...msgTurn1,
    messages: [
      ...msgTurn1.messages,
      { role: 'assistant', content: msgResult1.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'README.md' }] },
    ],
  }, { sidecarCodec: codec }));
  expect(msgTrip2.target.contents[1]).toEqual({
    role: 'model',
    parts: [
      { thought: true, text: 'Planning tool calls.', thoughtSignature: 'sig_plan' },
      { functionCall: { name: 'bash', args: { cmd: 'ls' } }, thoughtSignature: 'sig_call' },
    ],
  });
  expect(msgTrip2.target.contents[2]).toEqual({
    role: 'user',
    parts: [{ functionResponse: { name: 'bash', response: { output: 'README.md' } } }],
  });

  // 3. OpenAI Chat Completions
  const chatTurn1: OpenAIChatCompletionsPayload = {
    model: 'gemini-2.5-pro',
    stream: true,
    tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } }],
    messages: [{ role: 'user', content: 'Run pwd' }],
  };
  const chatTrip1 = expectTrip(await routeOpenAIChatCompletionsViaGeminiGenerateContent(chatTurn1, { sidecarCodec: codec }));
  const chatResult1 = await collectOpenAIChatCompletionsProtocolEventsToResult(
    chatTrip1.events(iterate(geminiFrames([{ name: 'bash', args: { cmd: 'pwd' }, sig: 'sig_call' }]))),
  );
  const chatCall = chatResult1.choices[0]?.message.tool_calls?.[0];
  if (chatCall === undefined) throw new Error('Expected translated tool_call');
  const chatTrip2 = expectTrip(await routeOpenAIChatCompletionsViaGeminiGenerateContent({
    ...chatTurn1,
    messages: [
      ...chatTurn1.messages,
      chatResult1.choices[0]!.message,
      { role: 'tool', tool_call_id: chatCall.id, content: '/workspace' },
    ],
  }, { sidecarCodec: codec }));
  expect(chatTrip2.target.contents[1]).toEqual({
    role: 'model',
    parts: [
      { thought: true, text: 'Planning tool calls.', thoughtSignature: 'sig_plan' },
      { functionCall: { name: 'bash', args: { cmd: 'pwd' } }, thoughtSignature: 'sig_call' },
    ],
  });
  expect(chatTrip2.target.contents[2]).toEqual({
    role: 'user',
    parts: [{ functionResponse: { name: 'bash', response: { output: '/workspace' } } }],
  });
});

test('returns input-error when a source file_id media reference cannot be resolved by Gemini', async () => {
  const result = await routeOpenAIResponsesViaGeminiGenerateContent({
    model: 'gemini-2.5-pro',
    stream: true,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', file_id: 'file_123', detail: 'auto' }] }],
  }, options());
  expect(result).toMatchObject({ type: 'input-error' });
});

test('omits empty systemInstruction, toolConfig without tools, serviceTier auto, and empty reasoning_effort thinkingLevel', async () => {
  const emptyEffortOnly = expectTrip(await routeOpenAIResponsesViaGeminiGenerateContent({
    model: 'gemini-2.5-pro',
    stream: true,
    instructions: '',
    service_tier: 'auto',
    reasoning: { effort: '' },
    tool_choice: 'auto',
    input: 'Hello',
  }, options()));
  expect(emptyEffortOnly.target).not.toHaveProperty('systemInstruction');
  expect(emptyEffortOnly.target).not.toHaveProperty('toolConfig');
  expect(emptyEffortOnly.target).not.toHaveProperty('serviceTier');
  expect(emptyEffortOnly.target).not.toHaveProperty('generationConfig');

  const emptySystem = expectTrip(await routeAnthropicMessagesViaGeminiGenerateContent({
    model: 'gemini-2.5-pro',
    max_tokens: 100,
    stream: true,
    system: [{ type: 'text', text: '' }],
    messages: [{ role: 'user', content: 'Hi' }],
  }, options()));
  expect(emptySystem.target).not.toHaveProperty('systemInstruction');
});

test('serializes non-sidecar parallel tool calls with default empty args and thoughtSignature only on the first call, and merges consecutive model turns preserving sidecar signatures', async () => {
  const codec = createTestSidecarCodec('gemini-parallel-and-merge');
  const parallel = expectTrip(await routeOpenAIResponsesViaGeminiGenerateContent({
    model: 'gemini-2.5-pro',
    stream: true,
    tools: [
      { type: 'function', name: 'ping', parameters: { type: 'object', properties: {} } },
      { type: 'custom', name: 'patch', format: { type: 'text' } },
    ],
    input: [
      { type: 'message', role: 'user', content: 'Run tools' },
      { type: 'function_call', call_id: 'call_1', name: 'ping', arguments: '' },
      { type: 'custom_tool_call', call_id: 'call_2', name: 'patch', input: 'diff' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
      { type: 'custom_tool_call_output', call_id: 'call_2', output: 'done' },
    ],
  }, { sidecarCodec: codec }));
  expect(parallel.target.contents[1]).toEqual({
    role: 'model',
    parts: [
      {
        functionCall: { id: 'call_1', name: 'ping', args: {} },
        thoughtSignature: 'skip_thought_signature_validator',
      },
      {
        functionCall: { id: 'call_2', name: 'patch', args: { input: 'diff' } },
      },
    ],
  });

  // Produce a sidecar-restored model turn and replay it right after a non-sidecar model turn separated by dropped reasoning.
  const turn1 = expectTrip(await routeOpenAIResponsesViaGeminiGenerateContent({
    model: 'gemini-2.5-pro',
    stream: true,
    tools: [{ type: 'function', name: 'ping', parameters: { type: 'object', properties: {} } }],
    input: 'First question',
  }, { sidecarCodec: codec }));
  const result1 = await collectOpenAIResponsesProtocolEventsToResult(turn1.events(iterate([
    eventFrame({
      modelVersion: 'gemini-2.5-pro',
      candidates: [{
        index: 0,
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'ping', args: {} }, thoughtSignature: 'real_gemini_sig' }],
        },
        finishReason: 'STOP',
      }],
    }),
    doneFrame(),
  ])));
  const restoredItems = toOpenAIResponsesInputItems(result1.output);
  const restoredCall = result1.output.find(item => item.type === 'function_call');
  if (restoredCall === undefined) throw new Error('Expected function_call');

  const mergedModels = expectTrip(await routeOpenAIResponsesViaGeminiGenerateContent({
    model: 'gemini-2.5-pro',
    stream: true,
    tools: [{ type: 'function', name: 'ping', parameters: { type: 'object', properties: {} } }],
    input: [
      { type: 'message', role: 'user', content: 'First question' },
      { type: 'message', role: 'assistant', content: 'Let me check.' },
      // Empty mid-turn developer guidance yields 0 parts, forcing consecutive IR and restored model turns adjacent.
      { type: 'message', role: 'developer', content: '' },
      ...restoredItems,
      { type: 'message', role: 'developer', content: '' },
      { type: 'function_call', call_id: 'call_extra', name: 'ping', arguments: '' },
      { type: 'function_call_output', call_id: restoredCall.call_id, output: 'pong' },
      { type: 'function_call_output', call_id: 'call_extra', output: 'pong2' },
    ],
  }, { sidecarCodec: codec }));
  expect(mergedModels.target.contents).toEqual([
    { role: 'user', parts: [{ text: 'First question' }] },
    {
      role: 'model',
      parts: [
        { text: 'Let me check.' },
        { functionCall: { name: 'ping', args: {} }, thoughtSignature: 'real_gemini_sig' },
        { functionCall: { id: 'call_extra', name: 'ping', args: {} } },
      ],
    },
    {
      role: 'user',
      parts: [
        { functionResponse: { name: 'ping', response: { output: 'pong' } } },
        { functionResponse: { id: 'call_extra', name: 'ping', response: { output: 'pong2' } } },
      ],
    },
  ]);

  const consecutiveAssistantCalls = expectTrip(await routeOpenAIChatCompletionsViaGeminiGenerateContent({
    model: 'gemini-2.5-pro',
    stream: true,
    tools: [{ type: 'function', function: { name: 'ping', parameters: { type: 'object', properties: {} } } }],
    messages: [
      { role: 'user', content: 'Twice' },
      { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ping', arguments: '{}' } }] },
      { role: 'assistant', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'ping', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'one' },
      { role: 'tool', tool_call_id: 'c2', content: 'two' },
    ],
  }, { sidecarCodec: codec }));
  expect(consecutiveAssistantCalls.target.contents[1]).toEqual({
    role: 'model',
    parts: [
      { functionCall: { id: 'c1', name: 'ping', args: {} }, thoughtSignature: 'skip_thought_signature_validator' },
      { functionCall: { id: 'c2', name: 'ping', args: {} } },
    ],
  });
});

test('maps Anthropic adaptive thinking with and without explicit effort, and restores Chat tool sidecar when client omits refusal null', async () => {
  const adaptiveOnly = expectTrip(await routeAnthropicMessagesViaGeminiGenerateContent({
    model: 'gemini-2.5-pro',
    max_tokens: 1024,
    stream: true,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: 'Hi' }],
  }, options()));
  expect(adaptiveOnly.target.generationConfig?.thinkingConfig).toEqual({
    thinkingBudget: -1,
    includeThoughts: true,
  });

  const adaptiveWithEffort = expectTrip(await routeAnthropicMessagesViaGeminiGenerateContent({
    model: 'gemini-2.5-pro',
    max_tokens: 1024,
    stream: true,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: 'Hi' }],
  }, options()));
  expect(adaptiveWithEffort.target.generationConfig?.thinkingConfig).toEqual({
    thinkingLevel: 'LOW',
    includeThoughts: true,
  });

  // OpenAI Chat client omitting `refusal: null` and `content: null` when replaying a tool call turn.
  const codec = createTestSidecarCodec('chat-omit-refusal-null');
  const chatTurn1: OpenAIChatCompletionsPayload = {
    model: 'gemini-2.5-pro',
    stream: true,
    tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } }],
    messages: [{ role: 'user', content: 'Run pwd' }],
  };
  const chatTrip1 = expectTrip(await routeOpenAIChatCompletionsViaGeminiGenerateContent(chatTurn1, { sidecarCodec: codec }));
  const chatResult1 = await collectOpenAIChatCompletionsProtocolEventsToResult(
    chatTrip1.events(iterate([
      eventFrame({
        responseId: 'gem_rt_omit_null',
        modelVersion: 'gemini-2.5-pro',
        candidates: [{
          index: 0,
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'bash', args: { cmd: 'pwd' } }, thoughtSignature: 'sig_no_refusal_null' }],
          },
          finishReason: 'STOP',
        }],
      }),
      doneFrame(),
    ])),
  );
  const msg1 = chatResult1.choices[0]!.message;
  const toolCalls = msg1.tool_calls;
  if (toolCalls === undefined || toolCalls.length === 0) throw new Error('Expected tool_calls');
  const replayedAssistant: OpenAIChatCompletionsAssistantMessageEx = {
    role: 'assistant',
    tool_calls: toolCalls,
    reasoning_details: msg1.reasoning_details,
  };
  const chatTurn2: OpenAIChatCompletionsPayloadEx = {
    ...chatTurn1,
    messages: [
      ...chatTurn1.messages,
      replayedAssistant,
      { role: 'tool', tool_call_id: toolCalls[0]!.id, content: '/workspace' },
    ],
  };
  const chatTrip2 = expectTrip(await routeOpenAIChatCompletionsViaGeminiGenerateContent(chatTurn2, { sidecarCodec: codec }));
  expect(chatTrip2.target.contents[1]).toEqual({
    role: 'model',
    parts: [{ functionCall: { name: 'bash', args: { cmd: 'pwd' } }, thoughtSignature: 'sig_no_refusal_null' }],
  });
});
