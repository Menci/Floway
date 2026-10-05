import { createHasher } from 'blake3-jit';
import { expect, test } from 'vitest';

import { encodeBase64 } from '../../src/common/base-encoding.ts';
import type { OpenAIChatCompletionsAssistantMessage } from '../../src/openai-chat-completions/index.ts';
import { OpenAIChatCompletionsAssistantMessagePrivate } from '../../src/openai-chat-completions/private.ts';
import { createOpenAIChatCompletionsReferencedTextHash, openAIChatCompletionsReferencedTextHash, appendOpenAIChatCompletionsTextRange, openAIChatCompletionsTextFromRanges } from '../../src/openai-chat-completions/thin.ts';

const expected = (values: (string | undefined | null)[]) => {
  const fields = values.map(text => text == null ? '' : encodeBase64(createHasher().update(new TextEncoder().encode(text)).finalize(16)));
  return createHasher().update(new TextEncoder().encode(fields.join('\n'))).finalize(16);
};

test('incremental UTF-8 hashing matches whole fields across split surrogate pairs and tool interleaving', () => {
  const hash = createOpenAIChatCompletionsReferencedTextHash();
  hash.update({ content: '\ud83d', [OpenAIChatCompletionsAssistantMessagePrivate]: { reasoningText: 'R\ud83d' } });
  hash.update({ content: '', tool_calls: [{ index: 1, function: { arguments: 'B\ud83d' } }, { index: 0, function: { arguments: 'A' } }] });
  hash.update({ content: '\ude00', [OpenAIChatCompletionsAssistantMessagePrivate]: { reasoningText: '\ude00' }, tool_calls: [{ index: 1, function: { arguments: '\ude00' } }] });
  expect(hash.digest()).toEqual(expected(['R😀', '😀', 'A', 'B😀']));
});

test('missing fields retain their positions while empty strings and lone surrogates retain their UTF-8 hash semantics', () => {
  const message: OpenAIChatCompletionsAssistantMessage = { role: 'assistant', content: null };
  expect(openAIChatCompletionsReferencedTextHash(message)).toEqual(expected([undefined, null]));
  expect(openAIChatCompletionsReferencedTextHash({ ...message, content: '' })).toEqual(expected([undefined, '']));
  const hash = createOpenAIChatCompletionsReferencedTextHash();
  hash.update({ content: '\ud83d' });
  hash.update({ content: 'x\ud83d' });
  expect(hash.digest()).toEqual(expected([undefined, '\ud83dx\ud83d']));
  expect(openAIChatCompletionsReferencedTextHash({ role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toEqual(expected([undefined, 'ab']));
});

test('adjacent ranges merge while interleaved ranges remain separate', () => {
  const ranges: [number, number][] = [];
  appendOpenAIChatCompletionsTextRange(ranges, 0, 2);
  appendOpenAIChatCompletionsTextRange(ranges, 2, 2);
  appendOpenAIChatCompletionsTextRange(ranges, 6, 2);
  expect(ranges).toEqual([[0, 4], [6, 8]]);
});

test('UTF-16 references preserve code units while hashing the UTF-8 aggregate', () => {
  const first: [number, number][] = [];
  const second: [number, number][] = [];
  const reasoning: [number, number][] = [];
  const hash = createOpenAIChatCompletionsReferencedTextHash();
  hash.update({ content: '中\ud83d', [OpenAIChatCompletionsAssistantMessagePrivate]: { reasoningText: '思' } }, { content: first, reasoningText: reasoning });
  hash.update({ content: '\ude00' }, { content: first });
  hash.update({ content: '\ufeffé' }, { content: second });
  hash.update({ content: '文' }, { content: first });
  expect(hash.digest()).toEqual(expected(['思', '中😀\ufeffé文']));
  expect(first).toEqual([[0, 3], [5, 6]]);
  expect(second).toEqual([[3, 5]]);
  expect(reasoning).toEqual([[0, 1]]);
  const text = '中😀\ufeffé文';
  expect(openAIChatCompletionsTextFromRanges(text, first)).toBe('中😀文');
  expect(openAIChatCompletionsTextFromRanges(text, second)).toBe('\ufeffé');
});

test('base64 digest fields retain missing positions and separators in the outer hash', () => {
  expect(openAIChatCompletionsReferencedTextHash({ role: 'assistant', content: 'abc' })).not.toEqual(openAIChatCompletionsReferencedTextHash({ role: 'assistant', content: null, [OpenAIChatCompletionsAssistantMessagePrivate]: { reasoningText: 'abc', sidecar: { upstreamProtocol: 'openaiChatCompletions' } } }));
  const hash = createOpenAIChatCompletionsReferencedTextHash();
  hash.update({ tool_calls: [{ index: 0, id: 'missing-args' }, { index: 1, function: { arguments: '' } }] });
  expect(hash.digest()).toEqual(expected([undefined, undefined, undefined, '']));
});

test('references preserve lone surrogates and rejoin pairs split by another text owner', () => {
  const first: [number, number][] = [];
  const second: [number, number][] = [];
  const lone: [number, number][] = [];
  const hash = createOpenAIChatCompletionsReferencedTextHash();
  hash.update({ content: '\ud83d' }, { content: first });
  hash.update({ content: 'x' }, { content: second });
  hash.update({ content: '\ude00' }, { content: first });
  hash.update({ content: '\ud800' }, { content: lone });
  const text = '\ud83dx\ude00\ud800';
  expect(hash.digest()).toEqual(expected([undefined, text]));
  expect(first).toEqual([[0, 1], [2, 3]]);
  expect(openAIChatCompletionsTextFromRanges(text, first)).toBe('😀');
  expect(openAIChatCompletionsTextFromRanges(text, second)).toBe('x');
  expect(openAIChatCompletionsTextFromRanges(text, lone).charCodeAt(0)).toBe(0xd800);
});
