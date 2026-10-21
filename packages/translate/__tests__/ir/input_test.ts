import { describe, expect, test } from 'vitest';

import type {
  IRInputAssistantItem,
  IRInputAssistantTurn,
  IRInputConversation,
  IRInputToolResultContentPart,
  IRInputToolResultItem,
  IRInputUserContentPart,
  IRInputUserItem,
  IRInputUserTurn,
} from '../../src/ir/input/types.ts';

// The input IR states no runtime behaviour yet; these assertions pin the shape
// so a later reader or writer cannot widen it silently. Every construction is a
// real payload at least one `A via B` pair has to carry.
describe('input IR shape', () => {
  const userParts: IRInputUserContentPart[] = [
    { type: 'text', text: 'hi' },
    { type: 'image', image: { source_kind: 'url', url: 'https://example.com/a.png' }, detail: 'high' },
    { type: 'image', image: { source_kind: 'base64', media_type: 'image/png', data: 'AAAA' } },
    { type: 'file', file: { source_kind: 'file', file_id: 'file_1' }, filename: 'a.pdf' },
    { type: 'file', file: { source_kind: 'base64', data: 'AAAA' } },
    { type: 'audio', audio: { media_type: 'audio/wav', data: 'AAAA' } },
  ];

  test('a conversation carries user and assistant turns in order', () => {
    const userItems: IRInputUserItem[] = [
      { type: 'message', role: 'system', content: [{ type: 'text', text: 'be brief' }] },
      { type: 'message', role: 'developer', content: [{ type: 'text', text: 'tools are strict' }] },
      { type: 'message', role: 'user', content: userParts },
      { type: 'tool_result', call_id: 'call_1', output: 'ok' },
      { type: 'tool_result', call_id: 'call_2', output: [{ type: 'text', text: 'see' }, { type: 'image', image: { source_kind: 'url', url: 'https://example.com/b.png' } }], is_error: true },
    ];
    const assistantItems: IRInputAssistantItem[] = [
      { type: 'reasoning', summary: ['thought'], content: ['detail'] },
      { type: 'message', content: [{ type: 'text', text: 'answer' }, { type: 'refusal', refusal: 'no' }] },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":1}' },
      { type: 'custom_tool_call', call_id: 'call_2', name: 'edit', input: 'raw' },
    ];
    const user: IRInputUserTurn = { role: 'user', items: userItems };
    const assistant: IRInputAssistantTurn = { role: 'assistant', items: assistantItems };
    const conversation: IRInputConversation = { turns: [user, assistant] };

    expect(conversation.turns.map(turn => turn.role)).toEqual(['user', 'assistant']);
    expect(user.items.map(item => item.type)).toEqual(['message', 'message', 'message', 'tool_result', 'tool_result']);
    expect(assistant.items.map(item => item.type)).toEqual(['reasoning', 'message', 'function_call', 'custom_tool_call']);
  });

  test('a malformed tool call keeps its arguments as text rather than a parsed wrapper', () => {
    const call: IRInputAssistantItem = { type: 'function_call', call_id: 'call_1', name: 'f', arguments: 'not json' };
    expect(call.type === 'function_call' && call.arguments).toBe('not json');
  });

  test('a structured tool result keeps its parts instead of stringifying them', () => {
    const parts: IRInputToolResultContentPart[] = [
      { type: 'text', text: 'caption' },
      { type: 'file', file: { source_kind: 'base64', media_type: 'application/pdf', data: 'AAAA' }, filename: 'r.pdf' },
    ];
    const result: IRInputToolResultItem = { type: 'tool_result', call_id: 'call_1', output: parts };
    expect(Array.isArray(result.output) && result.output.map(part => part.type)).toEqual(['text', 'file']);
  });

  test('a file may omit media type, while audio must state one', () => {
    const typedFile: IRInputUserContentPart = { type: 'file', file: { source_kind: 'base64', media_type: 'application/pdf', data: 'AAAA' } };
    const untypedFile: IRInputUserContentPart = { type: 'file', file: { source_kind: 'base64', data: 'AAAA' } };
    const audio: IRInputUserContentPart = { type: 'audio', audio: { media_type: 'audio/mp3', data: 'AAAA' } };
    // @ts-expect-error Chat Completions names a format enum and GenerateContent a
    // MIME type; neither admits an untyped audio payload.
    const untypedAudio: IRInputUserContentPart = { type: 'audio', audio: { data: 'AAAA' } };
    expect([typedFile.type, untypedFile.type, audio.type, untypedAudio.type]).toEqual(['file', 'file', 'audio', 'audio']);
  });
});
