import { describe, expect, it } from 'vitest';

import { CHAT_ENDPOINT_KEYS, PATH_OVERRIDE_OPTIONS, endpointOptionsFor } from '../../../src/components/upstream-editor/endpoints';

describe('custom upstream endpoint editor', () => {
  it('offers Gemini GenerateContent as a chat endpoint', () => {
    expect(CHAT_ENDPOINT_KEYS).toContain('geminiGenerateContent');
    expect(endpointOptionsFor(CHAT_ENDPOINT_KEYS)).toContainEqual({
      key: 'geminiGenerateContent',
      label: 'Gemini GenerateContent',
    });
  });

  it('overrides the Gemini model root that generation paths hang off', () => {
    // The row moves `{root}/{model}:generateContent` and `:countTokens`. The
    // catalog listing is a separate field, so the label names the root rather
    // than one of the actions that use it.
    expect(PATH_OVERRIDE_OPTIONS).toContainEqual({
      path: '/v1beta/models',
      label: 'Gemini Models',
      defaultPath: '/v1beta/models',
    });
  });

  it('names chat endpoints after the protocol', () => {
    expect(endpointOptionsFor(CHAT_ENDPOINT_KEYS)).toContainEqual({
      key: 'openaiChatCompletions',
      label: 'OpenAI Chat Completions',
    });
  });

  it('lists OpenAI Search rather than borrowing its path for rerank', () => {
    // `/alpha/search` is the search passthrough. Rerank picks its path per model
    // through the row's target, so it has no endpoint-level override.
    expect(PATH_OVERRIDE_OPTIONS).toContainEqual({
      path: '/alpha/search',
      label: 'OpenAI Search',
      defaultPath: '/v1/alpha/search',
    });
    expect(PATH_OVERRIDE_OPTIONS.map(option => option.label)).not.toContain('Rerank');
  });

  it('seeds each override with the path it actually resolves to', () => {
    expect(PATH_OVERRIDE_OPTIONS.find(option => option.path === '/messages')).toEqual({
      path: '/messages',
      label: 'Anthropic Messages',
      defaultPath: '/v1/messages',
    });
  });
});
