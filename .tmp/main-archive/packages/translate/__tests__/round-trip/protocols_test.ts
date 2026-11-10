import { describe, expect, it } from 'vitest';

import { partitionAnthropicMessagesTurns } from '../../src/protocols/anthropic-messages/as-source/conversation-turns.ts';
import { computeAnthropicMessagesTurnDigest, createAnthropicMessagesSidecarCarrier, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest } from '../../src/protocols/anthropic-messages/as-source/round-trip.ts';
import { partitionGeminiGenerateContentTurns } from '../../src/protocols/gemini-generate-content/as-source/conversation-turns.ts';
import { computeGeminiGenerateContentTurnDigest, createGeminiGenerateContentSidecarCarrier, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest } from '../../src/protocols/gemini-generate-content/as-source/round-trip.ts';
import { partitionOpenAIChatCompletionsTurns } from '../../src/protocols/openai-chat-completions/as-source/conversation-turns.ts';
import { computeOpenAIChatCompletionsTurnDigest, createOpenAIChatCompletionsSidecarCarrier, findOpenAIChatCompletionsSidecarCarriers, verifyOpenAIChatCompletionsTurnDigest } from '../../src/protocols/openai-chat-completions/as-source/round-trip.ts';
import { partitionOpenAIResponsesTurns } from '../../src/protocols/openai-responses/as-source/conversation-turns.ts';
import { computeOpenAIResponsesTurnDigest, createOpenAIResponsesSidecarCarrier, findOpenAIResponsesSidecarCarriers, verifyOpenAIResponsesTurnDigest } from '../../src/protocols/openai-responses/as-source/round-trip.ts';
import { toOpenAIResponsesInputAssistantTurn } from '../../src/protocols/openai-responses/as-target/assistant-turn.ts';
import type { EncodedRoundTripSidecar } from '../../src/round-trip/resolve.ts';
import type { AnyRoundTripSidecar } from '../../src/round-trip/sidecar.ts';
import type { AnthropicMessagesAssistantContentBlock, AnthropicMessagesAssistantMessage, AnthropicMessagesMessage } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentContent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesInputItem, OpenAIResponsesOutputItemEx } from '@floway-dev/protocols/openai-responses';

const chatTurn = (): OpenAIChatCompletionsAssistantMessageEx => ({
  role: 'assistant',
  content: 'answer',
  name: 'assistant-name',
  audio: { id: 'audio-a' },
  annotations: [{ type: 'url_citation', url_citation: { start_index: 0, end_index: 6, title: 'source', url: 'https://example.test' } }],
  reasoning_details: [
    { type: 'reasoning.summary', summary: 'readable summary', format: 'unknown', index: 0 },
    ...createOpenAIChatCompletionsSidecarCarrier('opaque-sidecar'),
  ],
  tool_calls: [
    { id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '{"q":"a"}' }, provider_specific_fields: { trace: 'a' } },
    { id: 'call-b', type: 'custom', custom: { name: 'format', input: 'plain text' }, extra_content: { trace: 'b' } },
  ],
  provider_specific_fields: { dropped: true },
});

const responseTurn = (): OpenAIResponsesOutputItemEx[] => [
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
  {
    role: 'model', parts: [
      { text: 'answer-a' },
      { functionCall: { id: 'call-a', name: 'lookup', args: { q: 'a' } } },
      { text: 'answer-b' },
      { functionCall: { id: 'call-b', name: 'lookup', args: { q: 'b' } } },
    ],
  },
  { role: 'model', parts: [createGeminiGenerateContentSidecarCarrier('opaque-sidecar')] },
];

const fixtureSidecar = <Turn>(candidates: EncodedRoundTripSidecar<Turn>[], data = 'opaque-sidecar') => {
  const candidate = candidates.find(candidate => candidate.data === data);
  if (candidate === undefined) throw new Error(`Missing fixture sidecar: ${data}`);
  return { sidecar: candidate.data, turn: candidate.withoutSidecar() };
};

const verifyChatTurn = (
  turn: Parameters<typeof findOpenAIChatCompletionsSidecarCarriers>[0],
  sourceTurnDigest: Parameters<typeof verifyOpenAIChatCompletionsTurnDigest>[1],
  data = 'opaque-sidecar',
  version = 1,
) => verifyOpenAIChatCompletionsTurnDigest(fixtureSidecar(findOpenAIChatCompletionsSidecarCarriers(turn), data).turn, sourceTurnDigest, version);

const verifyResponsesTurn = (
  turn: Parameters<typeof findOpenAIResponsesSidecarCarriers>[0],
  sourceTurnDigest: Parameters<typeof verifyOpenAIResponsesTurnDigest>[1],
  data = 'opaque-sidecar',
  version = 1,
) => verifyOpenAIResponsesTurnDigest(fixtureSidecar(findOpenAIResponsesSidecarCarriers(turn), data).turn, sourceTurnDigest, version);

const verifyMessagesTurn = (
  turn: Parameters<typeof findAnthropicMessagesSidecarCarriers>[0],
  sourceTurnDigest: Parameters<typeof verifyAnthropicMessagesTurnDigest>[1],
  data = 'opaque-sidecar',
  version = 1,
) => verifyAnthropicMessagesTurnDigest(fixtureSidecar(findAnthropicMessagesSidecarCarriers(turn), data).turn, sourceTurnDigest, version);

const verifyGeminiTurn = (
  turn: Parameters<typeof findGeminiGenerateContentSidecarCarriers>[0],
  sourceTurnDigest: Parameters<typeof verifyGeminiGenerateContentTurnDigest>[1],
  data = 'opaque-sidecar',
  version = 1,
) => verifyGeminiGenerateContentTurnDigest(fixtureSidecar(findGeminiGenerateContentSidecarCarriers(turn), data).turn, sourceTurnDigest, version);

describe('assistant-turn sidecar protocols', () => {
  it('extracts Chat encrypted details without changing ordinary reasoning details or the input', async () => {
    const details = [{ type: 'reasoning.summary', summary: 'summary' }, { type: 'reasoning.text', text: 'native thought' }];
    const ordinary: OpenAIChatCompletionsAssistantMessageEx = {
      role: 'assistant', content: 'answer', reasoning_content: 'thought',
      reasoning_details: details,
    };
    const turn = { ...ordinary, reasoning_details: [...details, ...createOpenAIChatCompletionsSidecarCarrier('opaque')] };
    const before = structuredClone(turn);
    const inspection = fixtureSidecar(findOpenAIChatCompletionsSidecarCarriers(turn), 'opaque');
    expect(inspection).toEqual({ sidecar: 'opaque', turn: ordinary });
    expect(turn).toEqual(before);
    const check = await computeOpenAIChatCompletionsTurnDigest(ordinary);
    expect(await verifyOpenAIChatCompletionsTurnDigest(inspection.turn, check, 1)).toBe(true);
    const changedCarrier = { ...turn, reasoning_details: [...details, ...createOpenAIChatCompletionsSidecarCarrier('different')] };
    expect(await verifyChatTurn(changedCarrier, check, 'different')).toBe(true);
    expect(await verifyChatTurn({ ...turn, reasoning_content: 'edited thought' }, check, 'opaque')).toBe(false);
  });

  it('extracts Messages redacted blocks while preserving ordinary thinking and the input', async () => {
    const blocks: AnthropicMessagesAssistantContentBlock[] = [{ type: 'text', text: 'answer', citations: null }, { type: 'thinking', thinking: 'thought', signature: 'native' }];
    const ordinary: AnthropicMessagesAssistantMessage[] = [{ role: 'assistant', content: blocks }];
    const turn: AnthropicMessagesAssistantMessage[] = [{ ...ordinary[0], content: [...blocks, createAnthropicMessagesSidecarCarrier('opaque')] }];
    const before = structuredClone(turn);
    const inspection = fixtureSidecar(findAnthropicMessagesSidecarCarriers(turn), 'opaque');
    expect(inspection).toEqual({ sidecar: 'opaque', turn: ordinary });
    expect(turn).toEqual(before);
    const check = await computeAnthropicMessagesTurnDigest(ordinary);
    expect(await verifyAnthropicMessagesTurnDigest(inspection.turn, check, 1)).toBe(true);
    expect(await verifyMessagesTurn([{ ...ordinary[0], content: [...blocks, createAnthropicMessagesSidecarCarrier('different')] }], check, 'different')).toBe(true);
    expect(await verifyMessagesTurn([{ role: 'assistant', content: [{ type: 'text', text: 'edited answer', citations: null }, ...blocks.slice(1), createAnthropicMessagesSidecarCarrier('opaque')] }], check, 'opaque')).toBe(false);
  });

  it('extracts Responses encrypted items without retaining carrier metadata or changing ordinary reasoning', async () => {
    const reasoning: Extract<OpenAIResponsesOutputItemEx, { type: 'reasoning' }> = { type: 'reasoning', id: 'native', summary: [{ type: 'summary_text', text: 'summary' }], content: [{ type: 'reasoning_text', text: 'thought' }], status: 'completed' };
    const ordinary: OpenAIResponsesOutputItemEx[] = [
      { type: 'message', id: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'answer', annotations: [] }] },
      reasoning,
    ];
    const carrier = { ...createOpenAIResponsesSidecarCarrier('carrier', 'opaque'), status: 'incomplete' };
    const turn = [...ordinary, carrier];
    const before = structuredClone(turn);
    const inspection = fixtureSidecar(findOpenAIResponsesSidecarCarriers(turn), 'opaque');
    expect(inspection).toEqual({ sidecar: 'opaque', turn: ordinary });
    expect(turn).toEqual(before);
    const check = await computeOpenAIResponsesTurnDigest(ordinary);
    expect(await verifyOpenAIResponsesTurnDigest(inspection.turn, check, 1)).toBe(true);
    expect(await verifyResponsesTurn([...ordinary, { ...carrier, id: 'other', encrypted_content: 'different', summary: [], status: 'completed' }], check, 'different')).toBe(true);
    expect(await verifyResponsesTurn([ordinary[0], { ...reasoning, status: 'incomplete' }, carrier], check, 'opaque')).toBe(false);
    expect(await verifyResponsesTurn([ordinary[0], { ...reasoning, summary: [{ type: 'summary_text', text: 'edited summary' }] }, carrier], check, 'opaque')).toBe(false);
  });

  it('preserves readable Responses reasoning carrying an attached encrypted sidecar', async () => {
    const reasoning: Extract<OpenAIResponsesOutputItemEx, { type: 'reasoning' }> = {
      type: 'reasoning', id: 'native', status: 'completed', summary: [{ type: 'summary_text', text: 'summary' }], content: [{ type: 'reasoning_text', text: 'thought' }],
    };
    const attached = { ...reasoning, encrypted_content: 'opaque' };
    const turn = [attached];
    const before = structuredClone(turn);
    const inspection = fixtureSidecar(findOpenAIResponsesSidecarCarriers(turn), 'opaque');
    expect(inspection).toEqual({ sidecar: 'opaque', turn: [reasoning] });
    expect(turn).toEqual(before);
    const check = await computeOpenAIResponsesTurnDigest([reasoning]);
    expect(await verifyOpenAIResponsesTurnDigest(inspection.turn, check, 1)).toBe(true);
    expect(await verifyResponsesTurn([{ ...attached, encrypted_content: 'different' }], check, 'different')).toBe(true);
    expect(await verifyResponsesTurn([{ ...attached, status: 'incomplete' }], check, 'opaque')).toBe(false);
    expect(await verifyResponsesTurn([{ ...attached, summary: [{ type: 'summary_text', text: 'edited summary' }] }], check, 'opaque')).toBe(false);
    expect(await verifyResponsesTurn([{ ...attached, content: [{ type: 'reasoning_text', text: 'edited thought' }] }], check, 'opaque')).toBe(false);
  });

  it('extracts Gemini signatures from attached bodies and removes standalone carriers without mutating input', async () => {
    const functionCall = { id: 'call', name: 'lookup', args: { q: 'a' } };
    const ordinary: GeminiGenerateContentContent[] = [{ role: 'model', parts: [{ text: 'answer', thoughtSignature: 'on-text' }, { functionCall, thoughtSignature: 'on-call' }, { text: 'native thought', thought: true }, createGeminiGenerateContentSidecarCarrier('standalone-part')] }];
    const turn: GeminiGenerateContentContent[] = [
      { role: 'model', parts: [{ text: 'answer', thoughtSignature: 'on-text' }, { functionCall, thoughtSignature: 'on-call' }, { text: 'native thought', thought: true }, createGeminiGenerateContentSidecarCarrier('standalone-part')] },
      { role: 'model', parts: [createGeminiGenerateContentSidecarCarrier('standalone-content')] },
    ];
    const before = structuredClone(turn);
    const inspection = fixtureSidecar(findGeminiGenerateContentSidecarCarriers(turn), 'standalone-content');
    expect(inspection).toEqual({ sidecar: 'standalone-content', turn: ordinary });
    expect(turn).toEqual(before);
    const check = await computeGeminiGenerateContentTurnDigest(ordinary);
    expect(await verifyGeminiGenerateContentTurnDigest(inspection.turn, check, 1)).toBe(true);
    expect(await verifyGeminiTurn([{ role: 'model', parts: [{ text: 'answer', thoughtSignature: 'different' }, { functionCall }] }], check, 'different')).toBe(true);
    expect(await verifyGeminiTurn([{ role: 'model', parts: [{ text: 'edited answer', thoughtSignature: 'on-text' }, { functionCall }] }], check, 'on-text')).toBe(false);
    expect(await verifyGeminiTurn([{ role: 'model', parts: [{ text: 'answer' }, { functionCall: { ...functionCall, name: 'edited' }, thoughtSignature: 'on-call' }] }], check, 'on-call')).toBe(false);
  });

  it('types the unified envelope by source protocol, target protocol, assistant turn, and replay check', () => {
    const sidecar: AnyRoundTripSidecar = {
      v: 1,
      source: 'openaiChatCompletions',
      target: 'anthropicMessages',
      targetTurn: { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'original-target-value' }] },
      sourceTurnDigest: new Uint8Array(8),
    };
    expect([sidecar.source, sidecar.target, sidecar.targetTurn.content[0].type]).toEqual([
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
    expect(turns.map(({ items }) => items).flat()).toEqual(messages);
  });

  it('checks complete Chat body, readable summary, and ordered tool identities and arguments', async () => {
    const turn = chatTurn();
    const inspection = fixtureSidecar(findOpenAIChatCompletionsSidecarCarriers(turn));
    expect(inspection.sidecar).toBe('opaque-sidecar');
    const check = await computeOpenAIChatCompletionsTurnDigest(inspection.turn);
    expect(await verifyChatTurn(turn, check)).toBe(true);
    expect(await verifyChatTurn({ ...turn, audio: { id: 'edited-audio' } }, check)).toBe(true);
    const firstFunctionCall = turn.tool_calls![0] as Extract<NonNullable<typeof turn.tool_calls>[number], { type: 'function' }>;
    for (const changed of [
      { ...turn, content: 'edited answer' },
      { ...turn, reasoning_details: [{ type: 'reasoning.summary', summary: 'edited summary' }, ...createOpenAIChatCompletionsSidecarCarrier('opaque-sidecar')] },
      { ...turn, tool_calls: [...turn.tool_calls!].reverse() },
      { ...turn, tool_calls: [{ ...turn.tool_calls![0], id: 'edited-call' }, turn.tool_calls![1]] },
      { ...turn, tool_calls: [{ ...firstFunctionCall, function: { ...firstFunctionCall.function, name: 'edited-name' } }, turn.tool_calls![1]] },
      { ...turn, tool_calls: [{ ...firstFunctionCall, function: { ...firstFunctionCall.function, arguments: '{"q":"changed"}' } }, turn.tool_calls![1]] },
      { ...turn, tool_calls: turn.tool_calls!.slice(0, 1) },
      { ...turn, tool_calls: [...turn.tool_calls!, turn.tool_calls![0]] },
    ]) expect(await verifyChatTurn(changed, check)).toBe(false);
    const reasoningDetails = [
      { type: 'reasoning.summary', summary: 'readable summary', format: 'unknown', index: 0 },
      ...createOpenAIChatCompletionsSidecarCarrier('opaque-sidecar'),
    ];
    expect(await verifyChatTurn({
      ...turn,
      reasoning_details: [
        { ...reasoningDetails[0], index: 4, format: 'edited' },
        { ...reasoningDetails[1], data: 'different opaque payload', index: 5 },
      ],
    }, check, 'different opaque payload')).toBe(true);
    expect(await verifyChatTurn({
      ...turn,
      name: 'edited-assistant-name',
      reasoning_details: [reasoningDetails[0], { ...reasoningDetails[1], format: 'edited' }],
    }, check)).toBe(true);
    expect(await verifyChatTurn(turn, check, 'opaque-sidecar', 99)).toBe(false);
    expect(createOpenAIChatCompletionsSidecarCarrier('opaque')).toEqual([
      { type: 'reasoning.encrypted', data: 'opaque', format: 'unknown', index: 1 },
    ]);
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

  it('checks Responses bodies and statuses in order within each item type independently of other metadata', async () => {
    const turn = responseTurn();
    const check = await computeOpenAIResponsesTurnDigest(fixtureSidecar(findOpenAIResponsesSidecarCarriers(turn)).turn);
    expect(await verifyResponsesTurn(turn, check)).toBe(true);
    for (const changed of [
      [{ ...turn[0] as Extract<OpenAIResponsesOutputItemEx, { type: 'message' }>, content: [{ type: 'output_text' as const, text: 'edited answer', annotations: [], logprobs: [] }] }, ...turn.slice(1)],
      [turn[0], { ...turn[1] as Extract<OpenAIResponsesOutputItemEx, { type: 'function_call' }>, call_id: 'edited-call' }, turn[2]],
      [turn[0], { ...turn[1] as Extract<OpenAIResponsesOutputItemEx, { type: 'function_call' }>, name: 'edited-name' }, turn[2]],
      [turn[0], { ...turn[1] as Extract<OpenAIResponsesOutputItemEx, { type: 'function_call' }>, namespace: 'different-tool-namespace' }, turn[2]],
      [turn[0], { ...turn[1] as Extract<OpenAIResponsesOutputItemEx, { type: 'function_call' }>, arguments: '{"q":"changed"}' }, turn[2]],
      [{ ...turn[0] as Extract<OpenAIResponsesOutputItemEx, { type: 'message' }>, status: 'incomplete' }, ...turn.slice(1)],
      [turn[0], { ...turn[1] as Extract<OpenAIResponsesOutputItemEx, { type: 'function_call' }>, status: 'incomplete' }, turn[2]],
      [...turn, turn[1]],
    ]) expect(await verifyResponsesTurn(changed, check)).toBe(false);
    expect(await verifyResponsesTurn([turn[1], turn[0], turn[2]], check)).toBe(true);
    for (const message of [
      { ...turn[0] as Extract<OpenAIResponsesOutputItemEx, { type: 'message' }>, id: 'edited-message', phase: 'commentary' as const },
    ]) expect(await verifyResponsesTurn([message, ...turn.slice(1)], check)).toBe(true);
    const call = turn[1] as Extract<OpenAIResponsesOutputItemEx, { type: 'function_call' }>;
    expect(await verifyResponsesTurn([turn[0], { ...call, id: 'different-record' }, turn[2]], check)).toBe(true);
    const outputMessage = turn[0] as Extract<OpenAIResponsesOutputItemEx, { type: 'message' }>;
    const changedOutputCitation: OpenAIResponsesOutputItemEx[] = [
      {
        ...outputMessage,
        content: [{ type: 'output_text', text: 'answer', annotations: [{ type: 'url_citation', url: 'https://edited.test', title: 'edited', start_index: 0, end_index: 1 }], logprobs: [] }],
      },
      ...turn.slice(1),
    ];
    expect(await verifyResponsesTurn(changedOutputCitation, check)).toBe(true);
    expect(await verifyResponsesTurn([turn[1], turn[0], turn[2]], check)).toBe(true);
    expect(await verifyResponsesTurn(turn, check, 'opaque-sidecar', 99)).toBe(false);

    const secondCall = { ...turn[1] as Extract<OpenAIResponsesOutputItemEx, { type: 'function_call' }>, call_id: 'call-b', name: 'other', arguments: '{"q":"b"}' };
    const twoCalls = [turn[0], turn[1], secondCall, turn[2]];
    const twoCallsCheck = await computeOpenAIResponsesTurnDigest(fixtureSidecar(findOpenAIResponsesSidecarCarriers(twoCalls)).turn);
    expect(await verifyResponsesTurn([turn[0], secondCall, turn[1], turn[2]], twoCallsCheck)).toBe(false);
    expect(await verifyResponsesTurn([turn[1], secondCall, turn[0], turn[2]], twoCallsCheck)).toBe(true);

    const mixedContentMessage = {
      type: 'message' as const,
      role: 'assistant' as const,
      content: [
        { type: 'output_text' as const, text: 'first', annotations: [], logprobs: [] },
        { type: 'refusal' as const, refusal: 'refused' },
        { type: 'output_text' as const, text: 'second', annotations: [], logprobs: [] },
      ],
    };
    const mixedContentCheck = await computeOpenAIResponsesTurnDigest([mixedContentMessage]);
    expect(await verifyResponsesTurn([{ ...mixedContentMessage, content: [mixedContentMessage.content[1], mixedContentMessage.content[0], mixedContentMessage.content[2]] }, turn[2]], mixedContentCheck)).toBe(true);
    expect(await verifyResponsesTurn([{ ...mixedContentMessage, content: [mixedContentMessage.content[2], mixedContentMessage.content[1], mixedContentMessage.content[0]] }, turn[2]], mixedContentCheck)).toBe(false);

    const inputTextMessage = { type: 'message' as const, role: 'assistant' as const, content: [{ type: 'input_text' as const, text: 'input body' }] };
    const inputTextCheck = await computeOpenAIResponsesTurnDigest([inputTextMessage]);
    expect(await verifyResponsesTurn([{ ...inputTextMessage, content: [{ type: 'input_text', text: 'edited input body' }] }, turn[2]], inputTextCheck)).toBe(false);

  });

  it('checks reasoning content and summary and custom tool input without hashing unrelated metadata', async () => {
    const reasoning: Extract<OpenAIResponsesOutputItemEx, { type: 'reasoning' }> = {
      type: 'reasoning', id: 'rs-readable', summary: [{ type: 'summary_text', text: 'summary' }], content: [{ type: 'reasoning_text', text: 'thought' }],
    };
    const custom: Extract<OpenAIResponsesOutputItemEx, { type: 'custom_tool_call' }> = {
      type: 'custom_tool_call', id: 'custom-record', call_id: 'call-custom', name: 'format', input: 'plain input',
    };
    const carrier = createOpenAIResponsesSidecarCarrier('rs-sidecar', 'opaque-sidecar');
    const check = await computeOpenAIResponsesTurnDigest([reasoning, custom]);
    expect(await verifyResponsesTurn([{ ...reasoning, id: 'different' }, { ...custom, id: 'different' }, carrier], check)).toBe(true);
    for (const changed of [
      [{ ...reasoning, summary: [{ type: 'summary_text' as const, text: 'edited' }] }, custom, carrier],
      [{ ...reasoning, content: [{ type: 'reasoning_text' as const, text: 'edited' }] }, custom, carrier],
      [reasoning, { ...custom, call_id: 'edited' }, carrier],
      [reasoning, { ...custom, name: 'edited' }, carrier],
      [reasoning, { ...custom, namespace: 'different-tool-namespace' }, carrier],
      [reasoning, { ...custom, input: 'edited' }, carrier],
      [reasoning, custom, { type: 'message' as const, role: 'assistant' as const, content: [{ type: 'output_text' as const, text: '', annotations: [] }] }, carrier],
    ]) expect(await verifyResponsesTurn(changed, check)).toBe(false);
  });

  it('checks status on every status-bearing Responses replay material variant', async () => {
    const cases: Array<{
      original: Parameters<typeof computeOpenAIResponsesTurnDigest>[0];
      changed: Parameters<typeof verifyOpenAIResponsesTurnDigest>[0];
    }> = [
      {
        original: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'answer', annotations: [] }] }],
        changed: [{ type: 'message', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: 'answer', annotations: [] }] }],
      },
      {
        original: [{ type: 'reasoning', id: 'reasoning', status: 'completed', summary: [] }],
        changed: [{ type: 'reasoning', id: 'reasoning', status: 'incomplete', summary: [] }],
      },
      {
        original: [{ type: 'function_call', call_id: 'function', name: 'lookup', arguments: '{}', status: 'completed' }],
        changed: [{ type: 'function_call', call_id: 'function', name: 'lookup', arguments: '{}', status: 'incomplete' }],
      },
      {
        original: [{ type: 'custom_tool_call', call_id: 'custom', name: 'format', input: 'value', status: 'completed' }],
        changed: [{ type: 'custom_tool_call', call_id: 'custom', name: 'format', input: 'value', status: 'incomplete' }],
      },
      {
        original: [{ type: 'image_generation_call', id: 'image', result: 'image', status: 'completed' }],
        changed: [{ type: 'image_generation_call', id: 'image', result: 'image', status: 'failed' }],
      },
      {
        original: [{ type: 'web_search_call', id: 'search', status: 'completed' }],
        changed: [{ type: 'web_search_call', id: 'search', status: 'failed' }],
      },
    ];

    for (const { original, changed } of cases) {
      const originalCheck = await computeOpenAIResponsesTurnDigest(original);
      const changedCheck = await computeOpenAIResponsesTurnDigest(changed);
      expect(await verifyOpenAIResponsesTurnDigest(changed, originalCheck, 1)).toBe(false);
      expect(await verifyOpenAIResponsesTurnDigest(original, changedCheck, 1)).toBe(false);
    }

    const statusless = [{ type: 'function_call' as const, call_id: 'function', name: 'lookup', arguments: '{}' }];
    const statuslessCheck = await computeOpenAIResponsesTurnDigest(statusless);
    expect(await verifyOpenAIResponsesTurnDigest(statusless, statuslessCheck, 1)).toBe(true);
    expect(await verifyOpenAIResponsesTurnDigest(cases[2].original, statuslessCheck, 1)).toBe(false);
  });

  it('builds canonical Responses history items', async () => {
    expect(createOpenAIResponsesSidecarCarrier('rs_sidecar', 'opaque-sidecar')).toEqual({
      type: 'reasoning', id: 'rs_sidecar', summary: [], encrypted_content: 'opaque-sidecar',
    });
    const imageCall: Extract<OpenAIResponsesOutputItemEx, { type: 'image_generation_call' }> = {
      type: 'image_generation_call', id: 'ig-data', result: 'image-base64', status: 'completed', action: 'generate', output_format: 'png',
    };
    const messageWithSDKFields = {
      type: 'message', id: 'message-a', role: 'assistant', status: 'completed', phase: 'final_answer', created_by: 'sdk',
      content: [{ type: 'output_text', text: 'answer', annotations: [{ type: 'url_citation', url: 'https://example.test', title: 'source', start_index: 0, end_index: 6 }], logprobs: [], parsed: { answer: true } }],
    } satisfies Extract<OpenAIResponsesOutputItemEx, { type: 'message' }> & { created_by: string; content: (Extract<Extract<OpenAIResponsesOutputItemEx, { type: 'message' }>['content'][number], { type: 'output_text' }> & { parsed: { answer: boolean } })[] };
    const functionCallWithSDKFields = {
      type: 'function_call', id: 'function-a', call_id: 'call-a', name: 'lookup', arguments: '{"q":"a"}', parsed_arguments: { q: 'a' }, status: 'completed', created_by: 'sdk',
    } satisfies Extract<OpenAIResponsesOutputItemEx, { type: 'function_call' }> & { parsed_arguments: { q: string }; created_by: string };
    const outputHistory: OpenAIResponsesOutputItemEx[] = [
      messageWithSDKFields,
      functionCallWithSDKFields,
      { type: 'shell_call_output', id: 'shell-output', call_id: 'shell-call', output: [{ stdout: 'ok', stderr: '', outcome: { type: 'exit', exit_code: 0 }, created_by: 'sdk' }], status: 'completed', created_by: 'sdk' },
      { type: 'computer_call_output', call_id: 'computer-call', output: { type: 'computer_screenshot', file_id: 'screenshot' }, status: 'failed', created_by: 'sdk' },
      { type: 'custom_tool_call_output', call_id: 'custom-incomplete', output: 'incomplete', status: 'incomplete' },
      { type: 'custom_tool_call_output', id: 'custom-completed', call_id: 'custom-completed-call', output: 'complete', status: 'completed' },
      { type: 'additional_tools', id: 'additional-tools-developer', role: 'developer', tools: [] },
      { type: 'image_generation_call', id: 'ig-null', result: null, status: 'completed' },
      imageCall,
    ];
    expect(toOpenAIResponsesInputAssistantTurn(outputHistory)).toEqual([
      { type: 'message', id: 'message-a', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'answer', annotations: [{ type: 'url_citation', url: 'https://example.test', title: 'source', start_index: 0, end_index: 6 }], logprobs: [] }] },
      { type: 'function_call', id: 'function-a', call_id: 'call-a', name: 'lookup', arguments: '{"q":"a"}', status: 'completed' },
      { type: 'shell_call_output', id: 'shell-output', call_id: 'shell-call', output: [{ stdout: 'ok', stderr: '', outcome: { type: 'exit', exit_code: 0 } }], status: 'completed' },
      { type: 'custom_tool_call_output', id: 'custom-completed', call_id: 'custom-completed-call', output: 'complete' },
      { type: 'additional_tools', id: 'additional-tools-developer', role: 'developer', tools: [] },
      { type: 'image_generation_call', id: 'ig-null', result: null, status: 'completed' },
      imageCall,
    ]);
    const imageTurn: OpenAIResponsesOutputItemEx[] = [
      imageCall,
      { type: 'reasoning', id: 'rs-image', summary: [], encrypted_content: 'opaque-sidecar' },
    ];
    const imageCheck = await computeOpenAIResponsesTurnDigest([imageCall]);
    expect(await verifyResponsesTurn(imageTurn, imageCheck)).toBe(true);
    expect(await verifyResponsesTurn([
      { ...imageCall, action: 'edit' as const, id: 'ig-other', status: 'completed' as const, output_format: 'jpeg' as const },
      imageTurn[1],
    ], imageCheck)).toBe(true);
    expect(await verifyResponsesTurn([{ ...imageCall, result: 'changed-image' }, imageTurn[1]], imageCheck)).toBe(false);
  });

  it('merges adjacent Messages roles and checks each block type in order', async () => {
    type Block = Exclude<AnthropicMessagesAssistantMessage['content'], string>[number];
    const message = messagesTurn()[0];
    if (typeof message.content === 'string') throw new Error('Expected block content');
    const [text, thinking, call, carrier] = message.content;
    if (text.type !== 'text' || thinking.type !== 'thinking' || call.type !== 'tool_use' || carrier.type !== 'redacted_thinking') throw new Error('Unexpected Messages fixture');
    const first = { ...message, content: [text, thinking, call] };
    const continued: Extract<Block, { type: 'text' }> = { type: 'text', text: 'continued', citations: null };
    const second: AnthropicMessagesAssistantMessage = { role: 'assistant', content: [continued, carrier] };
    const user: AnthropicMessagesMessage = { role: 'user', content: 'question' };
    const turns = partitionAnthropicMessagesTurns([first, second, user]);
    expect(turns.map(({ role, items }) => [role, items.length])).toEqual([['assistant', 2], ['user', 1]]);
    expect(turns.map(({ items }) => items).flat()).toEqual([first, second, user]);
    const targetTurn = [first, second];
    const inspection = fixtureSidecar(findAnthropicMessagesSidecarCarriers(targetTurn));
    expect(inspection.sidecar).toBe('opaque-sidecar');
    const check = await computeAnthropicMessagesTurnDigest(inspection.turn);
    expect(await verifyMessagesTurn(targetTurn, check)).toBe(true);
    const changed = (blocks: Block[]): AnthropicMessagesAssistantMessage[] =>
      [{ role: 'assistant', content: [...blocks, carrier] }];
    for (const changedTurn of [
      changed([{ ...text, text: 'edited' }, thinking, call, continued]),
      changed([text, thinking, { ...call, id: 'edited-call' }, continued]),
      changed([text, thinking, { ...call, name: 'edited-name' }, continued]),
      changed([text, thinking, { ...call, input: { q: 'changed' } }, continued]),
      changed([text, thinking, call, { ...continued, text: 'edited continued' }]),
    ]) expect(await verifyMessagesTurn(changedTurn, check)).toBe(false);
    expect(await verifyMessagesTurn(changed([text, call, thinking, continued]), check)).toBe(false);
    expect(await verifyMessagesTurn(changed([call, text, thinking, continued]), check)).toBe(false);
    expect(await verifyMessagesTurn(changed([continued, text, thinking, call]), check)).toBe(false);
    const secondTool = { ...call, id: 'tool-b', name: 'other', input: { q: 'b' } };
    const twoTools = changed([text, thinking, call, secondTool, continued]);
    const twoToolsCheck = await computeAnthropicMessagesTurnDigest(fixtureSidecar(findAnthropicMessagesSidecarCarriers(twoTools)).turn);
    expect(await verifyMessagesTurn(changed([text, thinking, secondTool, call, continued]), twoToolsCheck)).toBe(false);
    expect(await verifyMessagesTurn(changed([text, call, secondTool, thinking, continued]), twoToolsCheck)).toBe(true);
    const settingsTurn: AnthropicMessagesAssistantMessage[] = [{ ...first, clear_at: 'never', output_config: null }, second];
    const settingsCheck = await computeAnthropicMessagesTurnDigest(fixtureSidecar(findAnthropicMessagesSidecarCarriers(settingsTurn)).turn);
    expect(await verifyMessagesTurn(settingsTurn, settingsCheck)).toBe(true);
    expect(await verifyMessagesTurn([{ ...settingsTurn[0], clear_at: 'next_user_message' }, second], settingsCheck)).toBe(true);
    const stringContentCheck = await computeAnthropicMessagesTurnDigest([{ role: 'assistant', content: 'plain text' }]);
    expect(await verifyAnthropicMessagesTurnDigest([{ role: 'assistant', content: [{ type: 'text', text: 'plain text', citations: null }] }], stringContentCheck, 1)).toBe(true);
    expect(await verifyMessagesTurn([
      { role: 'assistant', content: [{ ...text, cache_control: { type: 'ephemeral' } }, { ...thinking, signature: 'different-signature' }, call] },
      second,
    ], check)).toBe(true);
  });

  it('checks Messages text, citations, thinking, and JSON tool input', async () => {
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
      { type: 'thinking', thinking: 'reasoning', signature: 'native-message-signature' },
      { type: 'tool_use', id: 'call-a', name: 'lookup', input: { q: 'a' } },
      createAnthropicMessagesSidecarCarrier('opaque-sidecar'),
    ] satisfies AnthropicMessagesAssistantContentBlock[];
    const citedTurn: AnthropicMessagesAssistantMessage[] = [{ role: 'assistant', content: responseContent }];
    const citedCheck = await computeAnthropicMessagesTurnDigest(fixtureSidecar(findAnthropicMessagesSidecarCarriers(citedTurn)).turn);
    const responseText = responseContent[0] as Extract<typeof responseContent[number], { type: 'text' }>;
    expect(await verifyMessagesTurn([{
      role: 'assistant',
      content: [{ ...responseText, citations: [{ ...textCitation, cited_text: 'edited citation' }] }, ...responseContent.slice(1)],
    }], citedCheck)).toBe(false);
  });

  it('groups Gemini model contents and permits ordinary cross-kind movement', async () => {
    const turn = geminiTurn();
    const turns = partitionGeminiGenerateContentTurns([
      ...turn,
      { role: 'user', parts: [{ text: 'question' }] },
      { role: 'model', parts: [{ text: 'next turn' }] },
    ]);
    expect(turns.map(({ role, items }) => [role, items.length])).toEqual([['assistant', 2], ['bare', 1], ['assistant', 1]]);
    const check = await computeGeminiGenerateContentTurnDigest(fixtureSidecar(findGeminiGenerateContentSidecarCarriers(turn)).turn);
    expect(await verifyGeminiTurn([{ ...turn[0], parts: [turn[0].parts![1], turn[0].parts![0], turn[0].parts![3], turn[0].parts![2]] }, turn[1]], check)).toBe(true);
    const moved = [
      {
        role: 'model', parts: [
          { text: 'answer-a' },
          turn[0].parts![2],
          turn[0].parts![1],
          turn[0].parts![3],
        ],
      },
      { role: 'model', parts: [createGeminiGenerateContentSidecarCarrier('opaque-sidecar')] },
    ];
    expect(await verifyGeminiTurn(moved, check)).toBe(true);
    expect(await verifyGeminiTurn([
      { ...moved[0], parts: [{ text: 'edited answer' }, ...moved[0].parts.slice(1)] },
      moved[1],
    ], check)).toBe(false);
    const functionCall = turn[0].parts![1].functionCall!;
    const replacePart = (index: number, part: NonNullable<GeminiGenerateContentContent['parts']>[number]): GeminiGenerateContentContent[] => [{
      ...turn[0], parts: turn[0].parts!.map((value, partIndex) => partIndex === index ? part : value),
    }, turn[1]];
    const changedTurns: GeminiGenerateContentContent[][] = [
      replacePart(0, { text: 'edited' }),
      [{ ...turn[0], parts: [turn[0].parts![2], turn[0].parts![1], turn[0].parts![0], turn[0].parts![3]] }, turn[1]],
      [{ ...turn[0], parts: [turn[0].parts![0], turn[0].parts![3], turn[0].parts![2], turn[0].parts![1]] }, turn[1]],
      [{ ...turn[0], parts: turn[0].parts!.slice(1) }, turn[1]],
      [{ ...turn[0], parts: [...turn[0].parts!, { text: 'added' }] }, turn[1]],
      replacePart(1, { functionCall: { ...functionCall, id: 'edited-call' } }),
      replacePart(1, { functionCall: { ...functionCall, name: 'edited-name' } }),
      replacePart(1, { functionCall: { ...functionCall, args: { q: 'changed' } } }),
    ];
    for (const changed of changedTurns) expect(await verifyGeminiTurn(changed, check)).toBe(false);
    expect(await verifyGeminiTurn(turn, check, 'opaque-sidecar', 99)).toBe(false);
  });

  it('checks emitted Gemini media and transcript while excluding part metadata', async () => {
    const part = { inlineData: { mimeType: 'audio/wav', data: 'audio-a' }, audioTranscription: { text: 'transcript-a' } };
    const secondPart = { inlineData: { mimeType: 'image/png', data: 'image-b' } };
    const carrier = createGeminiGenerateContentSidecarCarrier('opaque-sidecar');
    const turn = [{ role: 'model' as const, parts: [part, secondPart, carrier] }];
    const check = await computeGeminiGenerateContentTurnDigest(fixtureSidecar(findGeminiGenerateContentSidecarCarriers(turn)).turn);
    expect(await verifyGeminiTurn([{
      ...turn[0], parts: [{
        ...part, inlineData: { ...part.inlineData, displayName: 'label' }, audioTranscription: { ...part.audioTranscription, speakerLabel: 'speaker' },
        partMetadata: { trace: 'changed' }, mediaResolution: { level: 'high' },
      }, secondPart, carrier],
    }], check)).toBe(true);
    for (const changed of [
      { ...part, inlineData: { ...part.inlineData, data: 'edited' } },
      { ...part, inlineData: { ...part.inlineData, mimeType: 'audio/mp3' } },
      { ...part, audioTranscription: { text: 'edited' } },
    ]) expect(await verifyGeminiTurn([{ ...turn[0], parts: [changed, secondPart, carrier] }], check)).toBe(false);
    expect(await verifyGeminiTurn([{ ...turn[0], parts: [secondPart, part, carrier] }], check)).toBe(false);
  });

  it('does not require Gemini thought text while checking the tool call and answer', async () => {
    const functionCall = { id: 'call', name: 'lookup', args: { q: 'a' } };
    const turn: GeminiGenerateContentContent[] = [{
      role: 'model', parts: [
        { text: 'thinking', thought: true },
        { functionCall },
        { text: 'answer', thoughtSignature: 'opaque-sidecar' },
      ],
    }];
    const check = await computeGeminiGenerateContentTurnDigest(fixtureSidecar(findGeminiGenerateContentSidecarCarriers(turn)).turn);
    const replay = [{
      role: 'model' as const, parts: [
        { functionCall },
        { text: 'answer', thoughtSignature: 'opaque-sidecar' },
      ],
    }];
    expect(await verifyGeminiTurn(replay, check)).toBe(true);
    replay[0].parts[0].functionCall = { id: 'call', name: 'edited', args: { q: 'a' } };
    expect(await verifyGeminiTurn(replay, check)).toBe(false);
  });
});
