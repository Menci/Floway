import { afterEach, expect, test, vi } from 'vitest';

import { buildTargetRequest as messagesViaChat } from '../../src/protocols/anthropic-messages/via-openai-chat-completions/request.ts';
import { buildTargetRequest as messagesViaResponses } from '../../src/protocols/anthropic-messages/via-openai-responses/request.ts';
import { buildTargetRequest as geminiViaMessages } from '../../src/protocols/gemini-generate-content/via-anthropic-messages/request.ts';
import { buildTargetRequest as geminiViaChat } from '../../src/protocols/gemini-generate-content/via-openai-chat-completions/request.ts';
import { buildTargetRequest as geminiViaResponses } from '../../src/protocols/gemini-generate-content/via-openai-responses/request.ts';
import { buildTargetRequest as chatViaMessages } from '../../src/protocols/openai-chat-completions/via-anthropic-messages/request.ts';
import { buildTargetRequest as chatViaResponses } from '../../src/protocols/openai-chat-completions/via-openai-responses/request.ts';
import { buildTargetRequest as responsesViaMessages } from '../../src/protocols/openai-responses/via-anthropic-messages/request.ts';
import { buildTargetRequest as responsesViaChat } from '../../src/protocols/openai-responses/via-openai-chat-completions/request.ts';
import { createTestSidecarCodec } from '../round-trip/sidecar-codec.ts';
import type { OpenAIChatCompletionsAssistantMessageEx } from '@floway-dev/protocols/openai-chat-completions';

const codec = () => createTestSidecarCodec();
const loadRemoteImage = () => Promise.resolve(null);
const foreignChatAssistant = (): OpenAIChatCompletionsAssistantMessageEx => ({ role: 'assistant', content: 'answer', reasoning: 'trace' });
const chatViaMessagesOptions: Parameters<typeof chatViaMessages>[2] = { loadRemoteImage, fallbackMaxOutputTokens: undefined };
const responsesViaMessagesOptions: Parameters<typeof responsesViaMessages>[2] = { loadRemoteImage, fallbackMaxOutputTokens: undefined };
const geminiViaMessagesOptions: Parameters<typeof geminiViaMessages>[3] = { fallbackMaxOutputTokens: undefined };

const cases: { source: string; target: string; translate: () => Promise<unknown> }[] = [
  {
    source: 'openaiChatCompletions',
    target: 'anthropicMessages',
    translate: () => chatViaMessages({ model: 'model', messages: [foreignChatAssistant()] }, codec(), chatViaMessagesOptions),
  },
  {
    source: 'openaiChatCompletions',
    target: 'openaiResponses',
    translate: () => chatViaResponses({ model: 'model', messages: [foreignChatAssistant()] }, codec()),
  },
  {
    source: 'openaiResponses',
    target: 'anthropicMessages',
    translate: () => responsesViaMessages({ model: 'model', input: [{ type: 'reasoning', summary: [], encrypted_content: 'foreign' }] }, codec(), responsesViaMessagesOptions),
  },
  {
    source: 'openaiResponses',
    target: 'openaiChatCompletions',
    translate: () => responsesViaChat({ model: 'model', input: [{ type: 'reasoning', summary: [], encrypted_content: 'foreign' }] }, codec()),
  },
  {
    source: 'anthropicMessages',
    target: 'openaiChatCompletions',
    translate: () => messagesViaChat({ model: 'model', max_tokens: 1, messages: [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'foreign' }] }] }, codec()),
  },
  {
    source: 'anthropicMessages',
    target: 'openaiResponses',
    translate: () => messagesViaResponses({ model: 'model', max_tokens: 1, messages: [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'foreign' }] }] }, codec()),
  },
  {
    source: 'geminiGenerateContent',
    target: 'anthropicMessages',
    translate: () => geminiViaMessages({ contents: [{ role: 'model', parts: [{ thoughtSignature: 'foreign' }] }] }, 'model', codec(), geminiViaMessagesOptions),
  },
  {
    source: 'geminiGenerateContent',
    target: 'openaiChatCompletions',
    translate: () => geminiViaChat({ contents: [{ role: 'model', parts: [{ thoughtSignature: 'foreign' }] }] }, 'model', codec()),
  },
  {
    source: 'geminiGenerateContent',
    target: 'openaiResponses',
    translate: () => geminiViaResponses({ contents: [{ role: 'model', parts: [{ thoughtSignature: 'foreign' }] }] }, 'model', codec()),
  },
];

const ordinaryCases: { name: string; translate: () => Promise<unknown> }[] = [
  {
    name: 'ChatCompletions content',
    translate: () => chatViaResponses({ model: 'model', messages: [{ role: 'assistant', content: 'answer' }] }, codec()),
  },
  {
    name: 'Responses readable reasoning',
    translate: () => responsesViaChat({ model: 'model', input: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'trace' }] }] }, codec()),
  },
  {
    name: 'Messages readable thinking',
    translate: () => messagesViaResponses({ model: 'model', max_tokens: 1, messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'trace', signature: '' }] }] }, codec()),
  },
  {
    name: 'GenerateContent unsigned text',
    translate: () => geminiViaChat({ contents: [{ role: 'model', parts: [{ text: 'answer' }] }] }, 'model', codec()),
  },
];

afterEach(() => { vi.restoreAllMocks(); });

test.each(cases)('$source via $target warns when bare translation drops foreign reasoning', async ({ source, target, translate }) => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

  await translate();

  expect(warning).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledWith(
    'Dropping reasoning from an unidentifiable foreign assistant turn',
    { source, target },
  );
});

test.each(ordinaryCases)('$name does not warn during bare translation', async ({ translate }) => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

  await translate();

  expect(warning).not.toHaveBeenCalled();
});
