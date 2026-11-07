import { afterEach, expect, test, vi } from 'vitest';

import { pairs } from './composition-helpers.ts';
import { buildTargetRequestFor } from '../../src/protocols/composition.ts';
import type { SidecarCodec } from '../../src/types.ts';
import { createTestSidecarCodec } from '../round-trip/sidecar-codec.ts';
import type { OpenAIChatCompletionsAssistantMessageEx } from '@floway-dev/protocols/openai-chat-completions';

const codec = (): SidecarCodec => createTestSidecarCodec();
const loadRemoteImage = () => Promise.resolve(null);
const foreignChatAssistant = (): OpenAIChatCompletionsAssistantMessageEx => ({ role: 'assistant', content: 'answer', reasoning: 'trace' });
const extras = { model: 'model', loadRemoteImage, fallbackMaxOutputTokens: undefined };

/**
 * Every pair, with a request carrying reasoning only the sidecar could restore.
 *
 * A turn bearing an unrecognizable signature is the one case a pair cannot
 * translate faithfully, so the reader drops the reasoning and says so. The
 * warning is the whole behaviour under test, which is why each case states only
 * its request and the pair it walks.
 */
const cases = [
  {
    source: 'openaiChatCompletions', target: 'anthropicMessages',
    translate: (c: SidecarCodec) => buildTargetRequestFor(pairs.chatToMessages[0], pairs.chatToMessages[1], { model: 'model', messages: [foreignChatAssistant()] }, { ...extras, sidecarCodec: c }),
  },
  {
    source: 'openaiChatCompletions', target: 'openaiResponses',
    translate: (c: SidecarCodec) => buildTargetRequestFor(pairs.chatToResponses[0], pairs.chatToResponses[1], { model: 'model', messages: [foreignChatAssistant()] }, { ...extras, sidecarCodec: c }),
  },
  {
    source: 'openaiResponses', target: 'anthropicMessages',
    translate: (c: SidecarCodec) => buildTargetRequestFor(pairs.responsesToMessages[0], pairs.responsesToMessages[1], { model: 'model', input: [{ type: 'reasoning', summary: [], encrypted_content: 'foreign' }] }, { ...extras, sidecarCodec: c }),
  },
  {
    source: 'openaiResponses', target: 'openaiChatCompletions',
    translate: (c: SidecarCodec) => buildTargetRequestFor(pairs.responsesToChat[0], pairs.responsesToChat[1], { model: 'model', input: [{ type: 'reasoning', summary: [], encrypted_content: 'foreign' }] }, { ...extras, sidecarCodec: c }),
  },
  {
    source: 'anthropicMessages', target: 'openaiChatCompletions',
    translate: (c: SidecarCodec) => buildTargetRequestFor(pairs.messagesToChat[0], pairs.messagesToChat[1], { model: 'model', max_tokens: 1, messages: [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'foreign' }] }] }, { ...extras, sidecarCodec: c }),
  },
  {
    source: 'anthropicMessages', target: 'openaiResponses',
    translate: (c: SidecarCodec) => buildTargetRequestFor(pairs.messagesToResponses[0], pairs.messagesToResponses[1], { model: 'model', max_tokens: 1, messages: [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'foreign' }] }] }, { ...extras, sidecarCodec: c }),
  },
  {
    source: 'geminiGenerateContent', target: 'anthropicMessages',
    translate: (c: SidecarCodec) => buildTargetRequestFor(pairs.geminiToMessages[0], pairs.geminiToMessages[1], { contents: [{ role: 'model', parts: [{ thoughtSignature: 'foreign' }] }] }, { ...extras, sidecarCodec: c }),
  },
  {
    source: 'geminiGenerateContent', target: 'openaiChatCompletions',
    translate: (c: SidecarCodec) => buildTargetRequestFor(pairs.geminiToChat[0], pairs.geminiToChat[1], { contents: [{ role: 'model', parts: [{ thoughtSignature: 'foreign' }] }] }, { ...extras, sidecarCodec: c }),
  },
  {
    source: 'geminiGenerateContent', target: 'openaiResponses',
    translate: (c: SidecarCodec) => buildTargetRequestFor(pairs.geminiToResponses[0], pairs.geminiToResponses[1], { contents: [{ role: 'model', parts: [{ thoughtSignature: 'foreign' }] }] }, { ...extras, sidecarCodec: c }),
  },
] as const;

const ordinaryCases = [
  {
    name: 'ChatCompletions content',
    translate: (c: SidecarCodec) => buildTargetRequestFor(pairs.chatToResponses[0], pairs.chatToResponses[1], { model: 'model', messages: [{ role: 'assistant', content: 'answer' }] }, { ...extras, sidecarCodec: c }),
  },
  {
    name: 'Responses readable reasoning',
    translate: (c: SidecarCodec) => buildTargetRequestFor(pairs.responsesToChat[0], pairs.responsesToChat[1], { model: 'model', input: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'trace' }] }] }, { ...extras, sidecarCodec: c }),
  },
  {
    name: 'Messages readable thinking',
    translate: (c: SidecarCodec) => buildTargetRequestFor(pairs.messagesToResponses[0], pairs.messagesToResponses[1], { model: 'model', max_tokens: 1, messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'trace', signature: '' }] }] }, { ...extras, sidecarCodec: c }),
  },
  {
    name: 'GenerateContent unsigned text',
    translate: (c: SidecarCodec) => buildTargetRequestFor(pairs.geminiToChat[0], pairs.geminiToChat[1], { contents: [{ role: 'model', parts: [{ text: 'answer' }] }] }, { ...extras, sidecarCodec: c }),
  },
] as const;

afterEach(() => { vi.restoreAllMocks(); });

test.each(cases)('$source via $target warns when bare translation drops foreign reasoning', async ({ source, target, translate }) => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

  await translate(codec());

  expect(warning).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledWith(
    'Dropping reasoning from an unidentifiable foreign assistant turn',
    { source, target },
  );
});

test.each(ordinaryCases)('$name does not warn during bare translation', async ({ translate }) => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

  await translate(codec());

  expect(warning).not.toHaveBeenCalled();
});
