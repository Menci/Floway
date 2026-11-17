import { describe, expect, it } from 'vitest';

import { CHAT_ENDPOINT_KEYS, ENDPOINT_PATHS, PATH_OVERRIDE_PATHS, endpointOptionsFor } from '../../../src/components/upstream-editor/endpoints';

describe('custom upstream endpoint editor', () => {
  it('offers Gemini generateContent as a chat endpoint', () => {
    expect(CHAT_ENDPOINT_KEYS).toContain('geminiGenerateContent');
    expect(endpointOptionsFor(CHAT_ENDPOINT_KEYS)).toContainEqual(['geminiGenerateContent', '/models/{model}:generateContent']);
  });

  it('edits the Gemini generation path under its versioned model root', () => {
    // Generation and catalog listing are separate surfaces, so only the former
    // takes this override.
    expect(ENDPOINT_PATHS.geminiGenerateContent).toBe('/models/{model}:generateContent');
    expect(PATH_OVERRIDE_PATHS).toContain('/v1beta/models');
    expect(PATH_OVERRIDE_PATHS).not.toContain('/models/{model}:generateContent');
  });
});
