import { describe, expect, it } from 'vitest';

import {
  buildAnthropicMessagesThinAssistantTurn,
  buildOpenAIChatCompletionsThinAssistantTurn,
  buildOpenAIResponsesThinAssistantTurn,
  cleanAnthropicMessagesAssistantTurn,
  cleanGeminiGenerateContentAssistantTurn,
  cleanOpenAIChatCompletionsAssistantTurn,
  cleanOpenAIResponsesAssistantTurn,
  createAnthropicMessagesReplayCheck,
  createAnthropicMessagesSidecarCarrier,
  createGeminiGenerateContentReplayCheck,
  createGeminiGenerateContentSidecarCarrier,
  createOpenAIChatCompletionsReplayCheck,
  createOpenAIChatCompletionsSidecarCarrier,
  createOpenAIResponsesReplayCheck,
  createOpenAIResponsesSidecarCarrier,
  inspectAnthropicMessagesAssistantTurn,
  inspectGeminiGenerateContentAssistantTurn,
  inspectOpenAIChatCompletionsAssistantTurn,
  inspectOpenAIResponsesAssistantTurn,
  type IRRoundTripSidecarEnvelope,
  partitionAnthropicMessagesTurns,
  partitionGeminiGenerateContentTurns,
  partitionOpenAIChatCompletionsTurns,
  partitionOpenAIResponsesTurns,
  verifyAnthropicMessagesReplayCheck,
  verifyGeminiGenerateContentReplayCheck,
  verifyOpenAIChatCompletionsReplayCheck,
  verifyOpenAIResponsesReplayCheck,
} from '../../../../src/shared/ir/round-trip/index.ts';
import { IATReference } from '../../../../src/shared/ir/thin-types.ts';
import type { AnthropicMessagesAssistantMessage, AnthropicMessagesMessage, AnthropicMessagesResult } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentContent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsAssistantOutputMessageEx, OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesInputItem, OpenAIResponsesOutputItemEx } from '@floway-dev/protocols/openai-responses';

const chatTurn = (): OpenAIChatCompletionsAssistantMessageEx => ({
  role: 'assistant',
  content: 'answer',
  name: 'assistant-name',
  audio: { id: 'audio-a' },
  annotations: [{ type: 'url_citation', url_citation: { start_index: 0, end_index: 6, title: 'source', url: 'https://example.test' } }],
  reasoning_details: createOpenAIChatCompletionsSidecarCarrier('opaque-sidecar', 'readable summary'),
  tool_calls: [
    { id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '{"q":"a"}' }, provider_specific_fields: { trace: 'a' } },
    { id: 'call-b', type: 'custom', custom: { name: 'format', input: 'plain text' }, extra_content: { trace: 'b' } },
  ],
  provider_specific_fields: { dropped: true },
});

const responseTurn = (): Parameters<typeof buildOpenAIResponsesThinAssistantTurn>[0][number][] => [
  { type: 'message', id: 'msg-a', status: 'completed', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'answer', annotations: [], logprobs: [] }] },
  { type: 'function_call', call_id: 'call-a', name: 'lookup', arguments: '{"q":"a"}', status: 'completed' },
  { type: 'reasoning', id: 'carrier-id', status: 'completed', summary: [], encrypted_content: 'opaque-sidecar' },
];

const messagesTurn = (): AnthropicMessagesAssistantMessage[] => [{
  role: 'assistant',
  content: [
    { type: 'text', text: 'answer', citations: null },
    { type: 'thinking', thinking: 'reasoning', signature: 'native-message-signature' },
    { type: 'tool_use', id: 'call-a', name: 'lookup', input: { q: 'a' } },
    createAnthropicMessagesSidecarCarrier('opaque-sidecar'),
  ],
}];

const geminiTurn = (): GeminiGenerateContentContent[] => [
  { role: 'model', parts: [{ text: 'answer', thought: true }, { functionCall: { id: 'call-a', name: 'lookup', args: { q: 'a' } } }] },
  { role: 'model', parts: [createGeminiGenerateContentSidecarCarrier('opaque-sidecar')] },
];

describe('assistant-turn sidecar protocols', () => {
  it('types the unified envelope by source protocol, target protocol, thin turn, referenced hashes, and replay check', () => {
    const sidecar: IRRoundTripSidecarEnvelope = {
      source: 'openaiChatCompletions',
      target: 'anthropicMessages',
      thinAssistantTurn: { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'original-target-value' }] },
      referencedContents: [new Uint8Array(32)],
      replayCheck: { version: 1, digest: new Uint8Array(32) },
    };
    expect([sidecar.source, sidecar.target, sidecar.thinAssistantTurn.content[0].type]).toEqual([
      'openaiChatCompletions', 'anthropicMessages', 'redacted_thinking',
    ]);
  });

  it('partitions Chat messages one assistant message at a time and leaves every other role bare', () => {
    const messages: OpenAIChatCompletionsMessage[] = [
      { role: 'user', content: 'question' },
      chatTurn(),
      { role: 'tool', tool_call_id: 'call-a', content: 'result' },
      { role: 'assistant', content: 'follow-up' },
    ];
    const turns = partitionOpenAIChatCompletionsTurns(messages);
    expect(turns.map(({ role, items }) => [role, items.length])).toEqual([
      ['bare', 1], ['assistant', 1], ['bare', 1], ['assistant', 1],
    ]);
    expect(turns.flatMap(({ items }) => items)).toEqual(messages);
  });

  it('checks complete Chat body, readable summary, and ordered tool identities and arguments', async () => {
    const turn = chatTurn();
    const inspection = inspectOpenAIChatCompletionsAssistantTurn(turn);
    expect(inspection.sidecars).toEqual(['opaque-sidecar']);
    expect(inspection.candidates).toContain('{"q":"a"}');
    expect(inspection.candidates).toContain('readable summary');
    const check = await createOpenAIChatCompletionsReplayCheck(turn);
    expect(check).toBeDefined();
    expect(await verifyOpenAIChatCompletionsReplayCheck(turn, check!)).toBe(true);
    const firstFunctionCall = turn.tool_calls![0] as Extract<NonNullable<typeof turn.tool_calls>[number], { type: 'function' }>;
    for (const changed of [
      { ...turn, content: 'edited answer' },
      { ...turn, name: 'edited-assistant-name' },
      { ...turn, audio: { id: 'edited-audio' } },
      { ...turn, reasoning_details: createOpenAIChatCompletionsSidecarCarrier('opaque-sidecar', 'edited summary') },
      { ...turn, tool_calls: [...turn.tool_calls!].reverse() },
      { ...turn, tool_calls: [{ ...turn.tool_calls![0], id: 'edited-call' }, turn.tool_calls![1]] },
      { ...turn, tool_calls: [{ ...firstFunctionCall, function: { ...firstFunctionCall.function, name: 'edited-name' } }, turn.tool_calls![1]] },
      { ...turn, tool_calls: [{ ...firstFunctionCall, function: { ...firstFunctionCall.function, arguments: '{"q":"changed"}' } }, turn.tool_calls![1]] },
      { ...turn, tool_calls: turn.tool_calls!.slice(0, 1) },
      { ...turn, tool_calls: [...turn.tool_calls!, turn.tool_calls![0]] },
    ]) expect(await verifyOpenAIChatCompletionsReplayCheck(changed, check!)).toBe(false);
    const reasoningDetails = turn.reasoning_details as unknown as Record<string, unknown>[];
    expect(await verifyOpenAIChatCompletionsReplayCheck({
      ...turn,
      reasoning_details: [
        { ...reasoningDetails[0], index: 4 },
        { ...reasoningDetails[1], data: 'different opaque payload', index: 5 },
      ],
    }, check!)).toBe(true);
    expect(await verifyOpenAIChatCompletionsReplayCheck({
      ...turn,
      reasoning_details: [reasoningDetails[0], { ...reasoningDetails[1], format: 'edited' }],
    }, check!)).toBe(false);
    expect(await verifyOpenAIChatCompletionsReplayCheck(turn, { ...check!, version: 99 })).toBe(false);
    const multiple = { ...turn, reasoning_details: [...turn.reasoning_details as unknown[], ...createOpenAIChatCompletionsSidecarCarrier('second')] };
    expect(await createOpenAIChatCompletionsReplayCheck(multiple)).toBeUndefined();
    expect(await verifyOpenAIChatCompletionsReplayCheck(multiple, check!)).toBe(false);
    expect(await createOpenAIChatCompletionsReplayCheck({ ...turn, reasoning_details: [] })).toBeUndefined();
    expect(createOpenAIChatCompletionsSidecarCarrier('opaque')).toEqual([
      { type: 'reasoning.encrypted', data: 'opaque', format: 'unknown', index: 1 },
    ]);
  });

  it('cleans every Chat assistant extension, including nested tool-call extensions, for bare translation', () => {
    const clean = cleanOpenAIChatCompletionsAssistantTurn(chatTurn());
    expect(clean).toEqual({
      role: 'assistant',
      content: 'answer',
      name: 'assistant-name',
      audio: { id: 'audio-a' },
      tool_calls: [
        { id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '{"q":"a"}' } },
        { id: 'call-b', type: 'custom', custom: { name: 'format', input: 'plain text' } },
      ],
    });
    expect('reasoning_details' in clean).toBe(false);
    expect('provider_specific_fields' in clean).toBe(false);
  });

  it('builds Chat thin turns only at the protocol fields that preserve referenced content', () => {
    const turn = chatTurn();
    const outputTurn: OpenAIChatCompletionsAssistantOutputMessageEx = {
      role: 'assistant',
      content: 'answer',
      refusal: null,
      audio: { id: 'audio-a', data: 'audio-data', expires_at: 12, transcript: 'answer' },
      annotations: [{ type: 'url_citation', url_citation: { start_index: 0, end_index: 6, title: 'source', url: 'https://example.test' } }],
      reasoning_opaque: 'native-chat-signature',
      tool_calls: turn.tool_calls,
    };
    const reference = new IATReference('content');
    const thin = buildOpenAIChatCompletionsThinAssistantTurn(outputTurn, new Map([
      [JSON.stringify(['content']), reference],
      [JSON.stringify(['tool_calls', 0, 'function', 'arguments']), reference],
      [JSON.stringify(['provider_specific_fields', 'trace']), new IATReference('opaque')],
    ]));
    expect(thin.content).toBe(reference);
    expect(thin.audio).toEqual({ id: 'audio-a' });
    expect('annotations' in thin).toBe(false);
    expect(thin.reasoning_opaque).toBe('native-chat-signature');
    expect(thin.tool_calls?.[0].type === 'function' && thin.tool_calls[0].function.arguments).toBe(reference);
    expect(thin.provider_specific_fields).toBeUndefined();
  });

  it('partitions Responses input on native assistant/user/tool-output boundaries without using the sidecar as a delimiter', () => {
    const input: CanonicalOpenAIResponsesInputItem[] = [
      { type: 'reasoning', summary: [], encrypted_content: 'opaque-sidecar' },
      { type: 'function_call', call_id: 'call-a', name: 'lookup', arguments: '{"q":"a"}' },
      { type: 'function_call_output', call_id: 'call-a', output: 'result' },
      { type: 'message', role: 'assistant', content: 'answer' },
      { type: 'message', role: 'user', content: 'next question' },
    ];
    const turns = partitionOpenAIResponsesTurns(input);
    expect(turns.map(({ role, items }) => [role, items.length])).toEqual([
      ['assistant', 2], ['bare', 1], ['assistant', 1], ['bare', 1],
    ]);
    expect(turns.flatMap(({ items }) => items)).toEqual(input);
  });

  it('checks Responses body and call fields while excluding only the encrypted payload and incidental carrier fields', async () => {
    const turn = responseTurn();
    const check = await createOpenAIResponsesReplayCheck(turn);
    expect(check).toBeDefined();
    expect(inspectOpenAIResponsesAssistantTurn(turn).candidates).toEqual(['answer', '{"q":"a"}']);
    expect(await verifyOpenAIResponsesReplayCheck(turn, check!)).toBe(true);
    for (const changed of [
      [{ ...turn[0] as Extract<OpenAIResponsesOutputItemEx, { type: 'message' }>, content: [{ type: 'output_text' as const, text: 'edited answer', annotations: [], logprobs: [] }] }, ...turn.slice(1)],
      [{ ...turn[0] as Extract<OpenAIResponsesOutputItemEx, { type: 'message' }>, id: 'edited-message' }, ...turn.slice(1)],
      [{ ...turn[0] as Extract<OpenAIResponsesOutputItemEx, { type: 'message' }>, status: 'incomplete' }, ...turn.slice(1)],
      [{ ...turn[0] as Extract<OpenAIResponsesOutputItemEx, { type: 'message' }>, phase: 'commentary' }, ...turn.slice(1)],
      [turn[0], { ...turn[1] as Extract<OpenAIResponsesOutputItemEx, { type: 'function_call' }>, call_id: 'edited-call' }, turn[2]],
      [turn[0], { ...turn[1] as Extract<OpenAIResponsesOutputItemEx, { type: 'function_call' }>, name: 'edited-name' }, turn[2]],
      [turn[0], { ...turn[1] as Extract<OpenAIResponsesOutputItemEx, { type: 'function_call' }>, arguments: '{"q":"changed"}' }, turn[2]],
      [turn[1], turn[0], turn[2]],
      [...turn, turn[1]],
    ]) expect(await verifyOpenAIResponsesReplayCheck(changed, check!)).toBe(false);
    const outputMessage = turn[0] as Extract<OpenAIResponsesOutputItemEx, { type: 'message' }>;
    const changedOutputCitation: OpenAIResponsesOutputItemEx[] = [
      {
        ...outputMessage,
        content: [{ type: 'output_text', text: 'answer', annotations: [{ type: 'url_citation', url: 'https://edited.test', title: 'edited', start_index: 0, end_index: 1 }], logprobs: [] }],
      },
      ...turn.slice(1),
    ];
    expect(await verifyOpenAIResponsesReplayCheck(changedOutputCitation, check!)).toBe(true);
    const bodyInCarrier = [{ ...turn[0] }, turn[1], { ...turn[2] as Extract<OpenAIResponsesOutputItemEx, { type: 'reasoning' }>, summary: [{ type: 'summary_text' as const, text: 'visible carrier text' }] }];
    const bodyCheck = await createOpenAIResponsesReplayCheck(bodyInCarrier);
    expect(await verifyOpenAIResponsesReplayCheck(bodyInCarrier, bodyCheck!)).toBe(true);
    expect(await verifyOpenAIResponsesReplayCheck([{ ...bodyInCarrier[0] }, bodyInCarrier[1], { ...bodyInCarrier[2] as Extract<OpenAIResponsesOutputItemEx, { type: 'reasoning' }>, summary: [{ type: 'summary_text', text: 'edited visible carrier text' }] }], bodyCheck!)).toBe(false);
    expect(await verifyOpenAIResponsesReplayCheck([turn[2], ...turn.slice(0, 2)], check!)).toBe(true);
    const multiple = [...turn, { type: 'reasoning', id: 'second-carrier', summary: [], encrypted_content: 'second-sidecar' } as Extract<OpenAIResponsesOutputItemEx, { type: 'reasoning' }>];
    expect(await createOpenAIResponsesReplayCheck(multiple)).toBeUndefined();
    expect(await verifyOpenAIResponsesReplayCheck(multiple, check!)).toBe(false);
    expect(await verifyOpenAIResponsesReplayCheck(turn.filter(item => item.type !== 'reasoning'), check!)).toBe(false);
    expect(await verifyOpenAIResponsesReplayCheck(turn, { ...check!, version: 99 })).toBe(false);

    const inputImage = { type: 'input_image' as const, image_url: 'https://example.test/image.png', detail: 'high' as const };
    const inputFile = { type: 'input_file' as const, file_id: 'file-a', filename: 'notes.txt' };
    const imageAndFileMessage: Extract<CanonicalOpenAIResponsesInputItem, { type: 'message' }> = {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      internal_chat_message_metadata_passthrough: { trace: 'visible' },
      content: [inputImage, inputFile],
    };
    const imageAndFileTurn: CanonicalOpenAIResponsesInputItem[] = [
      imageAndFileMessage,
      { type: 'reasoning', summary: [], encrypted_content: 'opaque-sidecar' },
    ];
    const imageAndFileCheck = await createOpenAIResponsesReplayCheck(imageAndFileTurn);
    expect(await verifyOpenAIResponsesReplayCheck(imageAndFileTurn, imageAndFileCheck!)).toBe(true);
    expect(await verifyOpenAIResponsesReplayCheck([
      { ...imageAndFileMessage, content: [{ ...inputImage, image_url: 'https://example.test/edited.png' }, inputFile] },
      imageAndFileTurn[1],
    ], imageAndFileCheck!)).toBe(false);
    expect(await verifyOpenAIResponsesReplayCheck([
      { ...imageAndFileMessage, content: [inputImage, { ...inputFile, file_id: 'file-edited' }] },
      imageAndFileTurn[1],
    ], imageAndFileCheck!)).toBe(false);
    expect(await verifyOpenAIResponsesReplayCheck([
      { ...imageAndFileMessage, phase: 'commentary' },
      imageAndFileTurn[1],
    ], imageAndFileCheck!)).toBe(false);
    expect(await verifyOpenAIResponsesReplayCheck([
      { ...imageAndFileMessage, internal_chat_message_metadata_passthrough: { trace: 'edited' } },
      imageAndFileTurn[1],
    ], imageAndFileCheck!)).toBe(false);
  });

  it('drops the whole Responses carrier reasoning item on bare fallback and builds canonical history items', async () => {
    const turn = responseTurn();
    expect(cleanOpenAIResponsesAssistantTurn(turn)).toEqual(turn.slice(0, 2));
    expect(createOpenAIResponsesSidecarCarrier('rs_sidecar', 'opaque-sidecar')).toEqual({
      type: 'reasoning', id: 'rs_sidecar', summary: [], encrypted_content: 'opaque-sidecar',
    });
    const reference = new IATReference('arguments');
    const thin = buildOpenAIResponsesThinAssistantTurn(turn, new Map([
      [JSON.stringify([1, 'arguments']), reference],
      [JSON.stringify([0, 'content', 0, 'text']), new IATReference('message')],
      [JSON.stringify([2, 'encrypted_content']), new IATReference('encrypted')],
    ]));
    expect(thin[1].type === 'function_call' && thin[1].arguments).toBe(reference);
    expect(thin[0].type === 'message' && Array.isArray(thin[0].content) && thin[0].content[0].type === 'output_text' && thin[0].content[0].text).toBeInstanceOf(Object);
    expect(thin[2].type === 'reasoning' && thin[2].encrypted_content).toBe('opaque-sidecar');

    const imageCall: Extract<OpenAIResponsesOutputItemEx, { type: 'image_generation_call' }> = {
      type: 'image_generation_call', id: 'ig-data', result: 'image-base64', status: 'completed', action: 'generate', output_format: 'png',
    };
    const outputHistory: Parameters<typeof buildOpenAIResponsesThinAssistantTurn>[0][number][] = [
      {
        type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer',
        content: [{ type: 'output_text', text: 'answer', annotations: [{ type: 'url_citation', url: 'https://example.test', title: 'source', start_index: 0, end_index: 6 }], logprobs: [] }],
      },
      { type: 'web_search_call', id: 'web-a', status: 'completed', action: { type: 'search', queries: ['q'] }, results: [{ type: 'text_result', url: 'https://example.test', title: 'source', snippet: 'snippet' }] },
      { type: 'file_search_call', id: 'file-a', queries: ['q'], status: 'completed', results: [{ file_id: 'file-a', text: 'result' }] },
      { type: 'image_generation_call', id: 'ig-null', result: null, status: 'completed' },
      imageCall,
    ];
    const imageReference = new IATReference('image');
    expect(buildOpenAIResponsesThinAssistantTurn(outputHistory, new Map([
      [JSON.stringify([4, 'result']), imageReference],
    ]))).toEqual([
      { type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'answer' }] },
      { type: 'web_search_call', id: 'web-a', status: 'completed', action: { type: 'search', queries: ['q'] }, results: [{ type: 'text_result', url: 'https://example.test', title: 'source', snippet: 'snippet' }] },
      { type: 'file_search_call', id: 'file-a', queries: ['q'], status: 'completed', results: [{ file_id: 'file-a', text: 'result' }] },
      { type: 'image_generation_call', id: 'ig-null', result: null, status: 'completed' },
      { type: 'image_generation_call', id: 'ig-data', result: imageReference, status: 'completed', action: 'generate', output_format: 'png' },
    ]);
    const imageTurn: OpenAIResponsesOutputItemEx[] = [
      imageCall,
      { type: 'reasoning', id: 'rs-image', summary: [], encrypted_content: 'opaque-sidecar' },
    ];
    const imageCheck = await createOpenAIResponsesReplayCheck(imageTurn);
    expect(await verifyOpenAIResponsesReplayCheck(imageTurn, imageCheck!)).toBe(true);
    expect(await verifyOpenAIResponsesReplayCheck([
      { ...imageCall, action: 'edit' },
      imageTurn[1],
    ], imageCheck!)).toBe(false);
  });

  it('merges adjacent Messages roles into runs and checks ordered body, thinking, and tool-use data', async () => {
    const first = messagesTurn()[0];
    const second: AnthropicMessagesAssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'continued', citations: null }] };
    const user: AnthropicMessagesMessage = { role: 'user', content: 'question' };
    const turns = partitionAnthropicMessagesTurns([first, second, user]);
    expect(turns.map(({ role, items }) => [role, items.length])).toEqual([['assistant', 2], ['user', 1]]);
    expect(turns.flatMap(({ items }) => items)).toEqual([first, second, user]);
    const assistantTurn = [first, second];
    const inspection = inspectAnthropicMessagesAssistantTurn(assistantTurn);
    expect(inspection.sidecars).toEqual(['opaque-sidecar']);
    expect(inspection.candidates).toContain('answer');
    expect(inspection.candidates).toContain('continued');
    expect(inspection.candidates).toContainEqual({ q: 'a' });
    const check = await createAnthropicMessagesReplayCheck(assistantTurn);
    expect(check).toBeDefined();
    expect(await verifyAnthropicMessagesReplayCheck(assistantTurn, check!)).toBe(true);
    const changed = (blocks: AnthropicMessagesAssistantMessage['content']): AnthropicMessagesAssistantMessage[] => [{ role: 'assistant', content: blocks }];
    const blocks = first.content as Exclude<AnthropicMessagesAssistantMessage['content'], string>;
    for (const changedTurn of [
      changed([{ ...blocks[0] as Extract<typeof blocks[number], { type: 'text' }>, text: 'edited' }, ...blocks.slice(1)]),
      changed([blocks[0], blocks[2], blocks[1], blocks[3]]),
      changed([blocks[0], blocks[1], { ...blocks[2] as Extract<typeof blocks[number], { type: 'tool_use' }>, id: 'edited-call' }, blocks[3]]),
      changed([blocks[0], blocks[1], { ...blocks[2] as Extract<typeof blocks[number], { type: 'tool_use' }>, name: 'edited-name' }, blocks[3]]),
      changed([blocks[0], blocks[1], { ...blocks[2] as Extract<typeof blocks[number], { type: 'tool_use' }>, input: { q: 'changed' } }, blocks[3]]),
      [first, { ...second, content: [{ type: 'text' as const, text: 'edited continued', citations: null }] }],
      [...messagesTurn(), messagesTurn()[0]],
    ]) expect(await verifyAnthropicMessagesReplayCheck(changedTurn, check!)).toBe(false);
    const settingsTurn: AnthropicMessagesAssistantMessage[] = [
      { ...first, clear_at: 'never', output_config: null },
      second,
    ];
    const settingsCheck = await createAnthropicMessagesReplayCheck(settingsTurn);
    expect(await verifyAnthropicMessagesReplayCheck(settingsTurn, settingsCheck!)).toBe(true);
    expect(await verifyAnthropicMessagesReplayCheck([{ ...settingsTurn[0], clear_at: 'next_user_message' }, second], settingsCheck!)).toBe(false);
    const multiple = [{ ...first, content: [...blocks, createAnthropicMessagesSidecarCarrier('second')] }];
    expect(await createAnthropicMessagesReplayCheck(multiple)).toBeUndefined();
    expect(await verifyAnthropicMessagesReplayCheck(multiple, check!)).toBe(false);
    expect(await createAnthropicMessagesReplayCheck([first, { role: 'assistant', content: [createAnthropicMessagesSidecarCarrier('second')] }])).toBeUndefined();
  });

  it('cleans Messages redacted blocks and references text, citations, thinking, and JSON tool input only', () => {
    const turn = messagesTurn()[0];
    const followingTurn: AnthropicMessagesAssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'continued', citations: null }] };
    const clean = cleanAnthropicMessagesAssistantTurn([turn, followingTurn]);
    expect(clean[0].content).toEqual((turn.content as Exclude<AnthropicMessagesAssistantMessage['content'], string>).slice(0, 3));
    expect(clean[1]).toEqual(followingTurn);
    const textCitation = {
      type: 'char_location' as const,
      document_index: 0,
      document_title: 'source document',
      file_id: 'file-a',
      cited_text: 'answer',
      start_char_index: 0,
      end_char_index: 6,
    };
    const responseContent = [
      { type: 'text', text: 'answer', citations: [textCitation] },
      ...(turn.content as Exclude<AnthropicMessagesAssistantMessage['content'], string>).slice(1),
    ];
    const response = { role: 'assistant', content: responseContent, id: 'msg-a', type: 'message', model: 'claude-test', stop_reason: 'end_turn', stop_sequence: null, stop_details: null, container: null, usage: {} } as unknown as AnthropicMessagesResult;
    const reference = new IATReference('input');
    const citationReference = new IATReference('citation');
    const thin = buildAnthropicMessagesThinAssistantTurn(response, new Map([
      [JSON.stringify(['content', 0, 'text']), new IATReference('text')],
      [JSON.stringify(['content', 0, 'citations', 0, 'cited_text']), citationReference],
      [JSON.stringify(['content', 2, 'input']), reference],
      [JSON.stringify(['content', 3, 'data']), new IATReference('opaque')],
    ]));
    expect(thin.content[0].type === 'text' && thin.content[0].text).toBeInstanceOf(Object);
    expect(thin.content[0].type === 'text' && thin.content[0].citations?.[0].cited_text).toBe(citationReference);
    expect(thin.content[0].type === 'text' && 'file_id' in thin.content[0].citations![0]).toBe(false);
    expect(thin.content[1].type === 'thinking' && thin.content[1].signature).toBe('native-message-signature');
    expect(thin.content[2].type === 'tool_use' && thin.content[2].input).toBe(reference);
    expect(thin.content[3].type === 'redacted_thinking' && thin.content[3].data).toBe('opaque-sidecar');
    expect(Object.keys(thin)).toEqual(['role', 'content']);
  });

  it('groups Gemini model contents, permits a carrier signature to move onto meaningful content, and checks body order', async () => {
    const turn = geminiTurn();
    const turns = partitionGeminiGenerateContentTurns([
      ...turn,
      { role: 'user', parts: [{ text: 'question' }] },
      { role: 'model', parts: [{ text: 'next turn' }] },
    ]);
    expect(turns.map(({ role, items }) => [role, items.length])).toEqual([['assistant', 2], ['bare', 1], ['assistant', 1]]);
    const check = await createGeminiGenerateContentReplayCheck(turn);
    expect(check).toBeDefined();
    expect(inspectGeminiGenerateContentAssistantTurn(turn).candidates).toContainEqual({ q: 'a' });
    const moved = [
      { role: 'model', parts: [{ text: 'answer', thought: true, thoughtSignature: 'opaque-sidecar' }, turn[0].parts![1]] },
      { role: 'model', parts: [] },
    ];
    expect(await verifyGeminiGenerateContentReplayCheck(moved, check!)).toBe(true);
    expect(await verifyGeminiGenerateContentReplayCheck([
      { role: 'model', parts: [{ text: 'edited answer', thought: true, thoughtSignature: 'opaque-sidecar' }, turn[0].parts![1]] },
      { role: 'model', parts: [] },
    ], check!)).toBe(false);
    const functionCall = turn[0].parts![1].functionCall!;
    const changedTurns: GeminiGenerateContentContent[][] = [
      [{ ...turn[0], parts: [{ text: 'edited', thought: true }, ...turn[0].parts!.slice(1)] }, turn[1]],
      [{ ...turn[0], parts: [...turn[0].parts!].reverse() }, turn[1]],
      [{ ...turn[0], parts: [turn[0].parts![0], { functionCall: { ...functionCall, id: 'edited-call' } }] }, turn[1]],
      [{ ...turn[0], parts: [turn[0].parts![0], { functionCall: { ...functionCall, name: 'edited-name' } }] }, turn[1]],
      [{ ...turn[0], parts: [turn[0].parts![0], { functionCall: { ...functionCall, args: { q: 'changed' } } }] }, turn[1]],
      [...turn, { role: 'model', parts: [createGeminiGenerateContentSidecarCarrier('second')] }],
    ];
    for (const changed of changedTurns) expect(await verifyGeminiGenerateContentReplayCheck(changed, check!)).toBe(false);
    expect(await createGeminiGenerateContentReplayCheck([...turn, { role: 'model', parts: [createGeminiGenerateContentSidecarCarrier('second')] }])).toBeUndefined();
    expect(await verifyGeminiGenerateContentReplayCheck(turn, { ...check!, version: 99 })).toBe(false);
  });

  it('removes Gemini signatures and signature-only parts on bare fallback', () => {
    const turn = geminiTurn();
    const clean = cleanGeminiGenerateContentAssistantTurn(turn);
    expect(clean).toEqual([
      { role: 'model', parts: turn[0].parts },
      { role: 'model', parts: [] },
    ]);
    const emptyPartTurn = [{ role: 'model' as const, parts: [{}] }];
    expect(cleanGeminiGenerateContentAssistantTurn(emptyPartTurn)).toEqual(emptyPartTurn);
  });
});
