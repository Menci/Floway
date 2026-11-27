import { expect, test } from 'vitest';

import { geminiGenerateContentTargetProtocol } from '../../../../src/protocols/gemini-generate-content/as-target.ts';
import { TranslateInputException } from '../../../../src/shared/input-error.ts';
import { createTestSidecarCodec } from '../../../round-trip/sidecar-codec.ts';
import { iterate } from '../../../shared/iterables.ts';
import { expectTrip } from '../../../trip.ts';
import { collectAnthropicMessagesProtocolEventsToResult, type AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, FAST_SERVICE_TIER, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import { collectOpenAIResponsesProtocolEventsToResult, toOpenAIResponsesInputItems, type OpenAIResponsesRequestPayloadEx } from '@floway-dev/protocols/openai-responses';
import {
  routeAnthropicMessagesViaGeminiGenerateContent,
  routeOpenAIChatCompletionsViaGeminiGenerateContent,
  routeOpenAIResponsesViaGeminiGenerateContent,
} from '@floway-dev/translate';

const options = () => ({ sidecarCodec: createTestSidecarCodec('gemini-target-input') });

test('translates Anthropic Messages system, documents, tool results, thinking budget, and tool choices to GenerateContent', async () => {
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

test('translates OpenAI Responses namespaces, custom tools, allowed_tools subsets, effort xhigh, and reasoning_summary to GenerateContent', async () => {
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
      tools: [{ type: 'custom', name: 'fs.patch' }, { type: 'custom', name: 'fs.patch' }],
    },
    input: [
      { type: 'message', role: 'developer', content: 'Leading developer guidance' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Apply patch' }] },
      { type: 'function_call', call_id: 'call_ns_read', namespace: 'fs', name: 'read', arguments: '{"p":"a.ts"}' },
      { type: 'custom_tool_call', call_id: 'call_ns_patch', namespace: 'fs', name: 'patch', input: 'diff' },
      { type: 'function_call_output', call_id: 'call_ns_read', output: '{"content":"ok"}' },
      { type: 'custom_tool_call_output', call_id: 'call_ns_patch', output: '{"applied":true}' },
      { type: 'message', role: 'developer', content: 'Mid-turn developer note' },
    ],
  };

  const trip = expectTrip(await routeOpenAIResponsesViaGeminiGenerateContent(source, options()));
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
    thinkingConfig: { thinkingLevel: 'XHIGH', includeThoughts: true },
  });
  expect(trip.target.contents).toEqual([
    { role: 'user', parts: [{ text: 'Leading developer guidance' }, { text: 'Apply patch' }] },
    {
      role: 'model',
      parts: [
        { functionCall: { id: 'call_ns_read', name: 'fs_read', args: { p: 'a.ts' } }, thoughtSignature: 'skip_thought_signature_validator' },
        { functionCall: { id: 'call_ns_patch', name: 'fs_patch', args: { input: 'diff' } } },
      ],
    },
    {
      role: 'user',
      parts: [
        { functionResponse: { id: 'call_ns_read', name: 'fs_read', response: { content: 'ok' } } },
        { functionResponse: { id: 'call_ns_patch', name: 'fs_patch', response: { applied: true } } },
        { text: 'Mid-turn developer note' },
      ],
    },
  ]);

  const summaryOmittedWithEffort = expectTrip(await routeOpenAIResponsesViaGeminiGenerateContent({
    model: 'gemini-2.5-pro',
    stream: true,
    reasoning: { effort: 'high', summary: 'omitted' },
    input: 'Hi',
  }, options()));
  expect(summaryOmittedWithEffort.target.generationConfig).toEqual({
    thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: false },
  });

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

test('hoists leading developer messages, handles logprobs/json_object/adaptive thinking, and preserves model boundaries across dropped or empty assistant turns', async () => {
  const chat: OpenAIChatCompletionsPayload = {
    model: 'gemini-2.5-pro',
    stream: true,
    reasoning_effort: 'none',
    logprobs: true,
    top_logprobs: 3,
    n: 2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'developer', content: 'Hoisted developer rule' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Multimodal user turn' },
          { type: 'image_url', image_url: { url: 'DATA:image/jpeg;base64,aGVsbG8=' } },
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
    responseMimeType: 'application/json',
    thinkingConfig: { thinkingBudget: 0 },
  });
  expect(chatTrip.target.contents).toEqual([{
    role: 'user',
    parts: [
      { text: 'Multimodal user turn' },
      { inlineData: { mimeType: 'image/jpeg', data: 'aGVsbG8=' } },
      { inlineData: { mimeType: 'audio/wav', data: 'YXVk' } },
    ],
  }]);

  // Responses `include` omitting logprobs sets `logprobs: false` in IR; GenerateContent must omit both fields.
  const withoutLogprobs = expectTrip(await routeOpenAIResponsesViaGeminiGenerateContent({
    model: 'gemini-2.5-pro',
    stream: true,
    include: ['reasoning.encrypted_content'],
    top_logprobs: 3,
    input: [
      { type: 'message', role: 'user', content: 'First user turn' },
      // Encrypted-only foreign reasoning produces an empty IR assistant turn (`items: []`), which must keep its boundary.
      { type: 'reasoning', id: 'rs_encrypted_only', summary: [], encrypted_content: 'foreign_blob' },
      { type: 'message', role: 'user', content: 'Second user turn' },
    ],
  }, options()));
  expect(withoutLogprobs.target.generationConfig).toBeUndefined();
  expect(withoutLogprobs.target.contents).toEqual([
    { role: 'user', parts: [{ text: 'First user turn' }] },
    { role: 'model', parts: [{ text: '' }] },
    { role: 'user', parts: [{ text: 'Second user turn' }] },
  ]);

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
});

test('round-trips parallel id-less GenerateContent functionCalls answered out of order (even with interleaved user text) and thoughtSignature', async () => {
  const codec = createTestSidecarCodec('idless-generate-content-roundtrip');
  const generateContentFrames: ProtocolFrame<GeminiGenerateContentStreamEvent>[] = [
    eventFrame({
      responseId: 'gem_rt_1',
      modelVersion: 'gemini-2.5-pro',
      candidates: [{
        index: 0,
        content: {
          role: 'model',
          parts: [
            { thought: true, text: 'Planning tool calls.', thoughtSignature: 'sig_plan' },
            { functionCall: { name: 'code_patch', args: { input: '*** Patch' } }, thoughtSignature: 'sig_patch' },
            { functionCall: { name: 'read', args: { path: '/a.ts' } }, thoughtSignature: 'sig_read' },
          ],
        },
        finishReason: 'STOP',
      }],
    }),
    doneFrame(),
  ];

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
  const respResult1 = await collectOpenAIResponsesProtocolEventsToResult(respTrip1.events(iterate(generateContentFrames)));
  const respPatch = respResult1.output.find(item => item.type === 'custom_tool_call');
  const respRead = respResult1.output.find(item => item.type === 'function_call');
  if (respPatch === undefined || respRead === undefined) throw new Error('Expected translated tool calls');
  expect(respPatch).toMatchObject({ type: 'custom_tool_call', namespace: 'code', name: 'patch', input: '*** Patch' });

  const respTurn2: OpenAIResponsesRequestPayloadEx = {
    ...respTurn1,
    input: [
      { type: 'message', role: 'user', content: 'Edit file' },
      ...toOpenAIResponsesInputItems(respResult1.output),
      // Interleaved user note between out-of-order tool results must not split or misorder functionResponse parts.
      { type: 'function_call_output', call_id: respRead.call_id, output: '{"ok":true}' },
      { type: 'message', role: 'user', content: 'Also verify lint' },
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
        { functionResponse: { name: 'code_patch', response: { applied: true } } },
        { functionResponse: { name: 'read', response: { ok: true } } },
        { text: 'Also verify lint' },
      ],
    },
  ]);
});

test('returns input-error when a source file_id media reference cannot be resolved by GenerateContent', async () => {
  const result = await routeOpenAIResponsesViaGeminiGenerateContent({
    model: 'gemini-2.5-pro',
    stream: true,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', file_id: 'file_123', detail: 'auto' }] }],
  }, options());
  expect(result).toMatchObject({
    type: 'input-error',
    message: 'Cannot translate a file id reference to Gemini GenerateContent; send the content inline or by URL.',
  });
});

test('omits empty systemInstruction, non-forcing toolConfig without tools, empty/auto serviceTier, and empty effort or summary', async () => {
  const emptyEffortOnly = expectTrip(await routeOpenAIResponsesViaGeminiGenerateContent({
    model: 'gemini-2.5-pro',
    stream: true,
    service_tier: '',
    reasoning: { effort: '', summary: '' as never },
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
    service_tier: 'auto' as never,
    system: [{ type: 'text', text: '' }],
    messages: [{ role: 'user', content: 'Hi' }],
  }, options()));
  expect(emptySystem.target).not.toHaveProperty('systemInstruction');
  expect(emptySystem.target).not.toHaveProperty('serviceTier');
});

test('maps toolConfig variants (none, required, allowed_tools empty/all/undeclared/required) and keeps forcing choices without tools', async () => {
  const twoTools: OpenAIResponsesRequestPayloadEx['tools'] = [
    { type: 'function', name: 'a', parameters: { type: 'object', properties: {} } },
    { type: 'function', name: 'b', parameters: { type: 'object', properties: {} } },
  ];
  const runChoice = async (tool_choice: NonNullable<OpenAIResponsesRequestPayloadEx['tool_choice']>, tools = twoTools) =>
    await routeOpenAIResponsesViaGeminiGenerateContent({
      model: 'gemini-2.5-pro',
      stream: true,
      ...(tools === undefined ? {} : { tools }),
      tool_choice,
      input: 'Go',
    }, options());

  expect(expectTrip(await runChoice('none')).target.toolConfig).toEqual({ functionCallingConfig: { mode: 'NONE' } });
  expect(expectTrip(await runChoice('required')).target.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY' } });
  expect(expectTrip(await runChoice('required', undefined)).target.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY' } });
  expect(expectTrip(await runChoice({ type: 'allowed_tools', mode: 'auto', tools: [] })).target.toolConfig).toEqual({ functionCallingConfig: { mode: 'NONE' } });
  expect(await routeOpenAIChatCompletionsViaGeminiGenerateContent({
    model: 'gemini-2.5-pro',
    stream: true,
    tools: [{ type: 'function', function: { name: 'a', parameters: { type: 'object', properties: {} } } }],
    tool_choice: { type: 'allowed_tools', allowed_tools: { mode: 'required', tools: [] } },
    messages: [{ role: 'user', content: 'Go' }],
  }, options())).toMatchObject({
    type: 'input-error',
    message: 'Gemini GenerateContent cannot require a tool call from an empty allowed_tools list.',
  });
  expect(expectTrip(await runChoice({
    type: 'allowed_tools',
    mode: 'auto',
    tools: [{ type: 'function', name: 'a' }, { type: 'function', name: 'b' }],
  })).target.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
  expect(expectTrip(await runChoice({
    type: 'allowed_tools',
    mode: 'required',
    tools: [{ type: 'function', name: 'a' }],
  })).target.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['a'] } });
  expect(geminiGenerateContentTargetProtocol.write({
    settings: { model: 'gemini-2.5-pro', stream: true },
    tools: [{ type: 'function', name: 'a' }, { type: 'function', name: 'b' }],
    tool_choice: {
      type: 'allowed_tools',
      mode: 'auto',
      tools: [{ type: 'function', name: 'a' }, { type: 'function', name: 'b' }, { type: 'function', name: 'undeclared' }],
    },
  }, [], options()).payload.toolConfig).toEqual({
    functionCallingConfig: { mode: 'VALIDATED', allowedFunctionNames: ['a', 'b', 'undeclared'] },
  });
});

test('wraps rawJSON scalar numbers and malformed JSON as object args/responses, and handles error-object pass-through', async () => {
  const trip = expectTrip(await routeOpenAIResponsesViaGeminiGenerateContent({
    model: 'gemini-2.5-pro',
    stream: true,
    tools: [
      { type: 'function', name: 'f1', parameters: { type: 'object', properties: {} } },
      { type: 'function', name: 'f2', parameters: { type: 'object', properties: {} } },
      { type: 'function', name: 'f3', parameters: { type: 'object', properties: {} } },
      { type: 'function', name: 'f4', parameters: { type: 'object', properties: {} } },
    ],
    input: [
      { type: 'message', role: 'user', content: 'Test scalars' },
      { type: 'function_call', call_id: 'c1', name: 'f1', arguments: '1.0' },
      { type: 'function_call', call_id: 'c2', name: 'f2', arguments: 'null' },
      { type: 'function_call', call_id: 'c3', name: 'f3', arguments: '{malformed' },
      { type: 'function_call', call_id: 'c4', name: 'f4', arguments: '[1,2]' },
      { type: 'function_call_output', call_id: 'c1', output: '1.0' },
      { type: 'function_call_output', call_id: 'c2', output: '[1,2]' },
      { type: 'function_call_output', call_id: 'c3', output: '{"ok":1.0}' },
      { type: 'function_call_output', call_id: 'c4', output: 'plain' },
    ],
  }, options()));

  expect(JSON.parse(JSON.stringify(trip.target.contents[1]))).toEqual({
    role: 'model',
    parts: [
      { functionCall: { id: 'c1', name: 'f1', args: { raw_arguments: '1.0' } }, thoughtSignature: 'skip_thought_signature_validator' },
      { functionCall: { id: 'c2', name: 'f2', args: {} } },
      { functionCall: { id: 'c3', name: 'f3', args: { raw_arguments: '{malformed' } } },
      { functionCall: { id: 'c4', name: 'f4', args: { raw_arguments: '[1,2]' } } },
    ],
  });
  expect(JSON.stringify(trip.target.contents[2])).toContain('"response":{"ok":1.0}');
  expect(JSON.parse(JSON.stringify(trip.target.contents[2]))).toEqual({
    role: 'user',
    parts: [
      { functionResponse: { id: 'c1', name: 'f1', response: { output: '1.0' } } },
      { functionResponse: { id: 'c2', name: 'f2', response: { output: '[1,2]' } } },
      { functionResponse: { id: 'c3', name: 'f3', response: { ok: 1 } } },
      { functionResponse: { id: 'c4', name: 'f4', response: { output: 'plain' } } },
    ],
  });

  // Error tool_result wrapping: rawJSON scalar -> string error, object without `error` -> nested, object with `error` -> pass-through.
  const errTrip = expectTrip(await routeAnthropicMessagesViaGeminiGenerateContent({
    model: 'gemini-2.5-pro',
    max_tokens: 128,
    stream: true,
    tools: [{ name: 't', input_schema: { type: 'object', properties: {} } }],
    messages: [
      { role: 'user', content: 'Errs' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'e1', name: 't', input: {} },
          { type: 'tool_use', id: 'e2', name: 't', input: {} },
          { type: 'tool_use', id: 'e3', name: 't', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'e1', is_error: true, content: '1.0' },
          { type: 'tool_result', tool_use_id: 'e2', is_error: true, content: '{"detail":"bad"}' },
          { type: 'tool_result', tool_use_id: 'e3', is_error: true, content: '{"error":"already"}' },
        ],
      },
    ],
  }, options()));
  expect(errTrip.target.contents[2]).toEqual({
    role: 'user',
    parts: [
      { functionResponse: { id: 'e1', name: 't', response: { error: '1.0' } } },
      { functionResponse: { id: 'e2', name: 't', response: { error: { detail: 'bad' } } } },
      { functionResponse: { id: 'e3', name: 't', response: { error: 'already' } } },
    ],
  });
});

test('tags synthetic functionCalls after signed non-call restored parts, merges consecutive model turns, and guards empty restored turns and mismatched sourceCallIds', () => {
  const codec = createTestSidecarCodec('gemini-target-direct');
  const header = { settings: { model: 'gemini-2.5-pro', stream: true } };
  const write = (turns: Parameters<typeof geminiGenerateContentTargetProtocol.write>[1]) =>
    geminiGenerateContentTargetProtocol.write(header, turns, { sidecarCodec: codec }).payload.contents;

  // 1. Restored turn with signed thought + adjacent synthetic functionCall MUST still tag the synthetic functionCall;
  //    a dropped reasoning-only turn right after a restored model turn must not append a bogus `{ text: '' }`.
  const signedThoughtPlusSynthetic = write([
    { kind: 'client', items: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Go' }] }] },
    { kind: 'restored', turn: [{ role: 'model', parts: [{ thought: true, text: 't', thoughtSignature: 'sig_thought' }] }], sourceCallIds: [] },
    { kind: 'assistant', items: [{ type: 'reasoning', id: 'r1', summary: ['dropped'] }] },
    { kind: 'assistant', items: [{ type: 'function_call', call_id: 'c1', name: 'ping', arguments: '' }] },
    { kind: 'client', items: [{ type: 'tool_result', call_id: 'c1', output: 'ok' }] },
  ]);
  expect(signedThoughtPlusSynthetic).toEqual([
    { role: 'user', parts: [{ text: 'Go' }] },
    {
      role: 'model',
      parts: [
        { thought: true, text: 't', thoughtSignature: 'sig_thought' },
        { functionCall: { id: 'c1', name: 'ping', args: {} }, thoughtSignature: 'skip_thought_signature_validator' },
      ],
    },
    { role: 'user', parts: [{ functionResponse: { id: 'c1', name: 'ping', response: { output: 'ok' } } }] },
  ]);

  // 2. Restored call with explicit wire ID preserves wire ID on functionResponse; empty restored `parts: []` keeps a valid boundary.
  const explicitWireAndEmptyRestored = write([
    { kind: 'client', items: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'A' }] }] },
    { kind: 'restored', turn: [{ role: 'model', parts: [] }], sourceCallIds: [] },
    { kind: 'client', items: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'B' }] }] },
    { kind: 'restored', turn: [{ role: 'model', parts: [{ functionCall: { id: 'wire_1', name: 'ping', args: {} }, thoughtSignature: 'sig_real' }] }], sourceCallIds: ['wire_1'] },
    { kind: 'assistant', items: [{ type: 'function_call', call_id: 'c_extra', name: 'ping', arguments: '' }] },
    { kind: 'client', items: [{ type: 'tool_result', call_id: 'wire_1', output: 'p1' }, { type: 'tool_result', call_id: 'c_extra', output: 'p2' }] },
  ]);
  expect(explicitWireAndEmptyRestored).toEqual([
    { role: 'user', parts: [{ text: 'A' }] },
    { role: 'model', parts: [{ text: '' }] },
    { role: 'user', parts: [{ text: 'B' }] },
    {
      role: 'model',
      parts: [
        { functionCall: { id: 'wire_1', name: 'ping', args: {} }, thoughtSignature: 'sig_real' },
        { functionCall: { id: 'c_extra', name: 'ping', args: {} } },
      ],
    },
    {
      role: 'user',
      parts: [
        { functionResponse: { id: 'wire_1', name: 'ping', response: { output: 'p1' } } },
        { functionResponse: { id: 'c_extra', name: 'ping', response: { output: 'p2' } } },
      ],
    },
  ]);

  // 3. Corrupted sourceCallIds count or wire ID mismatch fails fast; unknown call_id throws TranslateInputException.
  expect(() => write([
    { kind: 'restored', turn: [{ role: 'model', parts: [{ functionCall: { name: 'ping', args: {} } }] }], sourceCallIds: [] },
  ])).toThrow('Authenticated round-trip call IDs do not match restored Gemini GenerateContent function calls');
  expect(() => write([
    { kind: 'restored', turn: [{ role: 'model', parts: [{ functionCall: { id: 'wire_1', name: 'ping', args: {} } }] }], sourceCallIds: ['wire_2'] },
  ])).toThrow('Authenticated round-trip call ID does not match restored Gemini GenerateContent wire call ID');
  expect(() => write([
    { kind: 'client', items: [{ type: 'tool_result', call_id: 'missing', output: 'x' }] },
  ])).toThrow(TranslateInputException);
});

test('reorders parallel same-name id-less tool results to match call order and avoids cross-turn call_id overwrites', async () => {
  const codec = createTestSidecarCodec('gemini-order-and-dup-call-id');
  const turn1Req: AnthropicMessagesPayload = {
    model: 'gemini-2.5-pro',
    max_tokens: 1024,
    stream: true,
    tools: [
      { name: 'read_file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'other_tool', input_schema: { type: 'object', properties: {} } },
    ],
    messages: [{ role: 'user', content: 'Read a and b' }],
  };
  const trip1 = expectTrip(await routeAnthropicMessagesViaGeminiGenerateContent(turn1Req, { sidecarCodec: codec }));
  const result1 = await collectAnthropicMessagesProtocolEventsToResult(trip1.events(iterate([
    eventFrame({
      responseId: 'gem_same_name',
      modelVersion: 'gemini-2.5-pro',
      candidates: [{
        index: 0,
        content: {
          role: 'model',
          parts: [
            { functionCall: { name: 'read_file', args: { path: 'a.ts' } }, thoughtSignature: 'sig_a' },
            { functionCall: { name: 'read_file', args: { path: 'b.ts' } }, thoughtSignature: 'sig_b' },
          ],
        },
        finishReason: 'STOP',
      }],
    }),
    doneFrame(),
  ])));
  const uses = result1.content.filter(block => block.type === 'tool_use');
  expect(uses).toHaveLength(2);

  // Answer b.ts before a.ts, then reuse uses[0].id in a later non-sidecar turn for a different tool.
  const turn2 = expectTrip(await routeAnthropicMessagesViaGeminiGenerateContent({
    ...turn1Req,
    messages: [
      ...turn1Req.messages,
      { role: 'assistant', content: result1.content },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: uses[1]!.id, content: 'contents of b' },
          { type: 'tool_result', tool_use_id: uses[0]!.id, content: 'contents of a' },
        ],
      },
      { role: 'assistant', content: [{ type: 'tool_use', id: uses[0]!.id, name: 'other_tool', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: uses[0]!.id, content: 'other output' }] },
    ],
  }, { sidecarCodec: codec }));

  expect(turn2.target.contents[2]).toEqual({
    role: 'user',
    parts: [
      { functionResponse: { name: 'read_file', response: { output: 'contents of a' } } },
      { functionResponse: { name: 'read_file', response: { output: 'contents of b' } } },
    ],
  });
  expect(turn2.target.contents[4]).toEqual({
    role: 'user',
    parts: [
      { functionResponse: { id: uses[0]!.id, name: 'other_tool', response: { output: 'other output' } } },
    ],
  });
});

test('keeps tool_result documents and URL attachments intact after contiguous functionResponses and defaults untyped binary media', async () => {
  const trip = expectTrip(await routeAnthropicMessagesViaGeminiGenerateContent({
    model: 'gemini-2.5-pro',
    max_tokens: 1024,
    stream: true,
    tools: [
      { name: 'fetch_pdf', input_schema: { type: 'object', properties: {} } },
      { name: 'status', input_schema: { type: 'object', properties: {} } },
    ],
    messages: [
      { role: 'user', content: 'Fetch' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_pdf', name: 'fetch_pdf', input: {} },
          { type: 'tool_use', id: 'toolu_status', name: 'status', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_pdf',
            content: [
              // Empty text alongside lifted attachments must still use the lifted placeholder.
              { type: 'text', text: '' },
              {
                type: 'document',
                title: 'Spec',
                source: {
                  type: 'content',
                  content: [
                    { type: 'text', text: 'Page 1' },
                    { type: 'image', source: { type: 'url', url: 'https://example.com/page1.png' } },
                  ],
                },
              },
              { type: 'image', source: { type: 'url', url: 'https://example.com/extra.png' } },
            ],
          },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_status',
            content: 'ok',
          },
        ],
      },
    ],
  }, options()));

  expect(trip.target.contents[2]).toEqual({
    role: 'user',
    parts: [
      {
        functionResponse: {
          id: 'toolu_pdf',
          name: 'fetch_pdf',
          response: { output: 'Attachments are attached in the following user content.' },
        },
      },
      {
        functionResponse: {
          id: 'toolu_status',
          name: 'status',
          response: { output: 'ok' },
        },
      },
      { text: 'Attachments from tool call toolu_pdf:' },
      { text: '<document>\n<title>Spec</title>' },
      { text: 'Page 1' },
      { fileData: { fileUri: 'https://example.com/page1.png' } },
      { text: '</document>' },
      { fileData: { fileUri: 'https://example.com/extra.png' } },
    ],
  });

  const untypedMedia = expectTrip(await routeOpenAIResponsesViaGeminiGenerateContent({
    model: 'gemini-2.5-pro',
    stream: true,
    input: [{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_file', file_data: 'SGVsbG8=' },
        { type: 'input_file', file_data: 'data:application/pdf;base64,JVBERi0=' },
      ],
    }],
  }, options()));
  expect(untypedMedia.target.contents).toEqual([{
    role: 'user',
    parts: [
      { inlineData: { mimeType: 'application/octet-stream', data: 'SGVsbG8=' } },
      { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0=' } },
    ],
  }]);
});

test('covers assistant custom_tool_call/refusal, empty boundaries, single-kind lifted tool results, media documents, and generation settings', () => {
  const codec = createTestSidecarCodec('gemini-target-coverage');
  const write = (
    header: Parameters<typeof geminiGenerateContentTargetProtocol.write>[0],
    turns: Parameters<typeof geminiGenerateContentTargetProtocol.write>[1],
  ) => geminiGenerateContentTargetProtocol.write(header, turns, { sidecarCodec: codec }).payload;

  // 1. Reasoning-only assistant turn followed by real assistant turn, multi-entry restored turn with leading empty entry,
  //    custom_tool_call, assistant refusal, non-leading instruction, media document, and empty user/assistant messages.
  const conversation = write({
    settings: {
      model: 'gemini-2.5-pro',
      stream: true,
      max_visible_output_tokens: 512,
      top_p: 0.9,
      seed: 42,
      presence_penalty: 0.25,
      frequency_penalty: 0.5,
      reasoning_effort: 'minimal',
    },
  }, [
    { kind: 'client', items: [{ type: 'message', role: 'user', content: [] }] },
    { kind: 'assistant', items: [{ type: 'reasoning', id: 'r_drop', summary: ['dropped'] }] },
    {
      kind: 'assistant',
      items: [
        { type: 'message', content: [{ type: 'refusal', refusal: 'Cannot comply.' }] },
        { type: 'custom_tool_call', call_id: 'c_patch', name: 'apply_patch', input: 'diff' },
      ],
    },
    { kind: 'client', items: [{ type: 'tool_result', call_id: 'c_patch', output: [] }] },
    {
      kind: 'restored',
      turn: [
        { role: 'model', parts: [] },
        { role: 'model', parts: [{ functionCall: { name: 'idless', args: {} } }] },
      ],
      sourceCallIds: ['synth_1'],
    },
    {
      kind: 'client',
      items: [
        {
          type: 'tool_result',
          call_id: 'synth_1',
          is_error: true,
          output: [{ type: 'image', image: { source_kind: 'url', url: 'https://example.com/err.png' } }],
        },
        { type: 'instruction', content: [{ type: 'text', text: 'Mid-conversation instruction' }] },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'document', document: { title: 'Manual', source: { source_kind: 'media', media: { source_kind: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } } } }],
        },
      ],
    },
    { kind: 'assistant', items: [{ type: 'message', content: [] }] },
  ]);

  expect(conversation.generationConfig).toEqual({
    maxOutputTokens: 512,
    topP: 0.9,
    seed: 42,
    presencePenalty: 0.25,
    frequencyPenalty: 0.5,
    thinkingConfig: { thinkingLevel: 'MINIMAL', includeThoughts: true },
  });
  expect(conversation.contents).toEqual([
    { role: 'user', parts: [{ text: '' }] },
    {
      role: 'model',
      parts: [
        { text: 'Cannot comply.' },
        { functionCall: { id: 'c_patch', name: 'apply_patch', args: { input: 'diff' } }, thoughtSignature: 'skip_thought_signature_validator' },
      ],
    },
    { role: 'user', parts: [{ functionResponse: { id: 'c_patch', name: 'apply_patch', response: { output: '' } } }] },
    { role: 'model', parts: [{ functionCall: { name: 'idless', args: {} } }] },
    {
      role: 'user',
      parts: [
        { functionResponse: { name: 'idless', response: { error: 'Image output is attached in the following user content.' } } },
        { text: 'Image output from tool call idless:' },
        { fileData: { fileUri: 'https://example.com/err.png' } },
        { text: 'Mid-conversation instruction' },
        { text: '<document>\n<title>Manual</title>' },
        { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0=' } },
        { text: '</document>' },
      ],
    },
    { role: 'model', parts: [{ text: '' }] },
  ]);

  // 2. Single-kind file and document lifted tool_result labels + reasoning_budget: 0 and open-string reasoning_effort.
  const singleKindLifts = write({
    settings: { model: 'gemini-2.5-pro', stream: true, reasoning_budget: 0 },
  }, [
    {
      kind: 'assistant',
      items: [
        { type: 'function_call', call_id: 'c_file', name: 'fetch_file', arguments: '{}' },
        { type: 'function_call', call_id: 'c_doc', name: 'fetch_doc', arguments: '{}' },
      ],
    },
    {
      kind: 'client',
      items: [
        { type: 'tool_result', call_id: 'c_file', output: [{ type: 'file', file: { source_kind: 'url', url: 'https://example.com/a.bin' } }] },
        { type: 'tool_result', call_id: 'c_doc', output: [{ type: 'document', document: { source: { source_kind: 'text', media_type: 'text/plain', text: 'Body' } } }] },
      ],
    },
  ]);
  expect(singleKindLifts.generationConfig).toEqual({ thinkingConfig: { thinkingBudget: 0 } });
  expect(singleKindLifts.contents[1]).toEqual({
    role: 'user',
    parts: [
      { functionResponse: { id: 'c_file', name: 'fetch_file', response: { output: 'File output is attached in the following user content.' } } },
      { functionResponse: { id: 'c_doc', name: 'fetch_doc', response: { output: 'Document output is attached in the following user content.' } } },
      { text: 'File output from tool call c_file:' },
      { fileData: { fileUri: 'https://example.com/a.bin' } },
      { text: 'Document output from tool call c_doc:' },
      { text: '<document>' },
      { text: 'Body' },
      { text: '</document>' },
    ],
  });

  const openEffort = write({
    settings: { model: 'gemini-2.5-pro', stream: true, reasoning_effort: 'custom_level' as never },
  }, [{ kind: 'client', items: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }] }]);
  expect(openEffort.generationConfig).toEqual({
    thinkingConfig: { thinkingLevel: 'custom_level', includeThoughts: true },
  });

  expect(() => write({ settings: { model: 'gemini-2.5-pro', stream: false } }, [])).toThrow(
    'A translation target requires a streaming request',
  );

  // 3. Cross-segment empty/reasoning-only model turns next to real restored/IR model turns emit no spurious `{ text: '' }`.
  const crossSegmentBoundaries = write({ settings: { model: 'gemini-2.5-pro', stream: true } }, [
    { kind: 'client', items: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'A' }] }] },
    { kind: 'assistant', items: [{ type: 'reasoning', id: 'r1', summary: ['dropped'] }] },
    { kind: 'restored', turn: [{ role: 'model', parts: [{ text: 'Restored reply' }] }], sourceCallIds: [] },
    { kind: 'client', items: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'B' }] }] },
    { kind: 'restored', turn: [{ role: 'model', parts: [] }], sourceCallIds: [] },
    { kind: 'assistant', items: [{ type: 'message', content: [{ type: 'text', text: 'IR reply' }] }] },
  ]);
  expect(crossSegmentBoundaries.contents).toEqual([
    { role: 'user', parts: [{ text: 'A' }] },
    { role: 'model', parts: [{ text: 'Restored reply' }] },
    { role: 'user', parts: [{ text: 'B' }] },
    { role: 'model', parts: [{ text: 'IR reply' }] },
  ]);

  // 4. Duplicate call_ids paired with an id-less named tool_result keep exact call names and call order.
  const duplicateIdsWithNamedResult = write({ settings: { model: 'gemini-2.5-pro', stream: true } }, [
    {
      kind: 'assistant',
      items: [
        { type: 'function_call', call_id: 'dup', name: 'alpha', arguments: '{}' },
        { type: 'function_call', call_id: 'dup', name: 'beta', arguments: '{}' },
      ],
    },
    {
      kind: 'client',
      items: [
        { type: 'tool_result', name: 'beta', output: '{"b":1}' },
        { type: 'tool_result', call_id: 'dup', output: '{"a":1}' },
      ],
    },
  ]);
  expect(duplicateIdsWithNamedResult.contents[1]).toEqual({
    role: 'user',
    parts: [
      { functionResponse: { id: 'dup', name: 'alpha', response: { a: 1 } } },
      { functionResponse: { id: 'dup', name: 'beta', response: { b: 1 } } },
    ],
  });

  // 5. `output_format: { type: 'json_schema' }` without a schema throws TranslateInputException.
  expect(() => write({
    settings: { model: 'gemini-2.5-pro', stream: true, output_format: { type: 'json_schema' } },
  }, [{ kind: 'client', items: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }] }]))
    .toThrow(new TranslateInputException('Cannot translate json_schema response format without a schema.'));
});

test('carries application/pdf mimeType from Anthropic URL PDF documents onto GenerateContent fileData', async () => {
  const trip = expectTrip(await routeAnthropicMessagesViaGeminiGenerateContent({
    model: 'gemini-2.5-pro',
    max_tokens: 256,
    stream: true,
    messages: [{
      role: 'user',
      content: [{ type: 'document', title: 'Spec', source: { type: 'url', url: 'https://example.com/spec.pdf' } }],
    }],
  }, options()));
  expect(trip.target.contents).toEqual([{
    role: 'user',
    parts: [
      { text: '<document>\n<title>Spec</title>' },
      { fileData: { mimeType: 'application/pdf', fileUri: 'https://example.com/spec.pdf' } },
      { text: '</document>' },
    ],
  }]);
});
