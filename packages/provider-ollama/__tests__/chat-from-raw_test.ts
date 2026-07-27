import { test } from 'vitest';

import { chatFromOllamaRaw } from '../src/chat-from-raw.ts';
import type { OllamaRawModel } from '../src/fetch-models.ts';
import { assertEquals } from '@floway-dev/test-utils';

const rawModel = (id: string, capabilities: string[]): OllamaRawModel => ({
  id,
  capabilities: new Set(capabilities),
});

const EFFORT_PRESET = { supported: ['low', 'medium', 'high'], default: 'medium' };

test('chatFromOllamaRaw thinking-capable model → uniform effort preset', () => {
  const chat = chatFromOllamaRaw(rawModel('gpt-oss:20b', ['completion', 'tools', 'thinking']));
  assertEquals(chat, { reasoning: { effort: EFFORT_PRESET } });
});

test('chatFromOllamaRaw deepseek-r1 thinking → same effort preset', () => {
  const chat = chatFromOllamaRaw(rawModel('deepseek-r1:32b', ['completion', 'thinking']));
  assertEquals(chat, { reasoning: { effort: EFFORT_PRESET } });
});

test('chatFromOllamaRaw qwen3 thinking → same effort preset', () => {
  const chat = chatFromOllamaRaw(rawModel('qwen3:32b', ['thinking']));
  assertEquals(chat, { reasoning: { effort: EFFORT_PRESET } });
});

test('chatFromOllamaRaw vision-only → modalities only, no reasoning', () => {
  const chat = chatFromOllamaRaw(rawModel('llava:13b', ['completion', 'vision']));
  assertEquals(chat, { modalities: { input: ['text', 'image'], output: ['text'] } });
});

test('chatFromOllamaRaw vision + thinking → both modalities and effort reasoning', () => {
  const chat = chatFromOllamaRaw(rawModel('gpt-oss:120b', ['vision', 'thinking']));
  assertEquals(chat, {
    modalities: { input: ['text', 'image'], output: ['text'] },
    reasoning: { effort: EFFORT_PRESET },
  });
});

test('chatFromOllamaRaw neither vision nor thinking → undefined', () => {
  assertEquals(chatFromOllamaRaw(rawModel('mistral:7b', ['completion', 'tools'])), undefined);
});
