import { describe, expect, it } from 'vitest';

import { CHAT_ENDPOINT_KEYS, ENDPOINT_PATHS, PATH_OVERRIDE_OPTIONS, endpointOptionsFor } from '../../../src/components/upstream-editor/endpoints';

describe('custom upstream endpoint editor', () => {
  it('offers Gemini GenerateContent as a chat endpoint, named rather than spelled as a path', () => {
    expect(CHAT_ENDPOINT_KEYS).toContain('geminiGenerateContent');
    expect(endpointOptionsFor(CHAT_ENDPOINT_KEYS)).toContainEqual({
      key: 'geminiGenerateContent',
      label: 'Gemini GenerateContent',
    });
  });

  it('has no path override for Gemini', () => {
    // The generation root is fixed under the model-collection path, so `baseUrl`
    // places it and the catalog listing keeps its own field.
    expect(ENDPOINT_PATHS.geminiGenerateContent).toBe('/models/{model}:generateContent');
    expect(PATH_OVERRIDE_OPTIONS.map(option => option.path)).not.toContain('/v1beta/models');
    expect(PATH_OVERRIDE_OPTIONS.map(option => option.key)).not.toContain('geminiGenerateContent');
  });

  it('names every overridable path', () => {
    expect(PATH_OVERRIDE_OPTIONS).toContainEqual({ key: 'anthropicMessages', label: 'Anthropic Messages', path: '/messages' });
  });
});
