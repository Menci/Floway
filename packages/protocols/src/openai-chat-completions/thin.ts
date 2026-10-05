import { createHasher } from 'blake3-jit';

import type { OpenAIChatCompletionsAssistantMessage, OpenAIChatCompletionsAssistantDelta } from './index.ts';
import { OpenAIChatCompletionsAssistantMessagePrivate, type OpenAIChatCompletionsTextRangeReference } from './private.ts';
import { encodeBase64 } from '../common/base-encoding.ts';

const encoder = new TextEncoder();

const textHash = () => {
  const hasher = createHasher();
  let offset = 0;
  let surrogate = '';
  return {
    update(text: string, ranges?: OpenAIChatCompletionsTextRangeReference[]) {
      if (ranges !== undefined) appendOpenAIChatCompletionsTextRange(ranges, offset, text.length);
      offset += text.length;
      if (text.length === 0) return;
      text = surrogate + text;
      surrogate = '';
      const last = text.charCodeAt(text.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        surrogate = text.at(-1)!;
        text = text.slice(0, -1);
      }
      hasher.update(encoder.encode(text));
    },
    digest() {
      if (surrogate) hasher.update(encoder.encode(surrogate));
      return hasher.finalize(16);
    },
  };
};

export const createOpenAIChatCompletionsReferencedTextHash = () => {
  let reasoning: ReturnType<typeof textHash> | undefined;
  let content: ReturnType<typeof textHash> | undefined;
  const tools = new Map<number, ReturnType<typeof textHash> | undefined>();
  return {
    update(delta: OpenAIChatCompletionsAssistantDelta, references: { reasoningText?: OpenAIChatCompletionsTextRangeReference[]; content?: OpenAIChatCompletionsTextRangeReference[] } = {}) {
      const text = delta[OpenAIChatCompletionsAssistantMessagePrivate]?.reasoningText;
      if (text != null) (reasoning ??= textHash()).update(text, references.reasoningText);
      if (delta.content != null) (content ??= textHash()).update(delta.content, references.content);
      for (const tool of delta.tool_calls ?? []) {
        if (!tools.has(tool.index)) tools.set(tool.index, undefined);
        const args = tool.function?.arguments;
        if (args == null) continue;
        let hash = tools.get(tool.index);
        if (hash === undefined) { hash = textHash(); tools.set(tool.index, hash); }
        hash.update(args);
      }
    },
    digest() {
      const hash = createHasher();
      const fields = [reasoning, content, ...[...tools].toSorted(([a], [b]) => a - b).map(([, value]) => value)];
      hash.update(encoder.encode(fields.map(field => field === undefined ? '' : encodeBase64(field.digest())).join('\n')));
      return hash.finalize(16);
    },
  };
};

export const openAIChatCompletionsReferencedTextHash = (message: OpenAIChatCompletionsAssistantMessage): Uint8Array => {
  const hash = createOpenAIChatCompletionsReferencedTextHash();
  const reasoningText = message[OpenAIChatCompletionsAssistantMessagePrivate]?.reasoningText;
  if (reasoningText != null) hash.update({ [OpenAIChatCompletionsAssistantMessagePrivate]: { reasoningText } });
  hash.update({ content: Array.isArray(message.content) ? message.content.filter(part => part.type === 'text').map(part => part.text).join('') : message.content });
  for (const [index, tool] of (message.tool_calls ?? []).entries()) {
    if (tool.type === 'function') hash.update({ tool_calls: [{ index, function: { arguments: tool.function.arguments } }] });
  }
  return hash.digest();
};

export const matchesOpenAIChatCompletionsReferencedTextHash = (message: OpenAIChatCompletionsAssistantMessage, expected: Uint8Array): boolean => {
  const actual = openAIChatCompletionsReferencedTextHash(message);
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
};

export const appendOpenAIChatCompletionsTextRange = (ranges: OpenAIChatCompletionsTextRangeReference[], start: number, length: number): void => {
  const previous = ranges.at(-1);
  if (previous?.[1] === start) previous[1] += length;
  else ranges.push([start, start + length]);
};

export const openAIChatCompletionsTextFromRanges = (text: string, ranges: OpenAIChatCompletionsTextRangeReference[]): string => ranges.map(([start, end]) => text.slice(start, end)).join('');
