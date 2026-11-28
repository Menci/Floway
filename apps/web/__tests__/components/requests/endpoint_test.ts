import { describe, expect, it } from 'vitest';

import { endpointName } from '../../../src/components/requests/endpoint';

describe('endpointName', () => {
  it('names an endpoint by the route that serves it, with or without the version prefix', () => {
    expect(endpointName('POST', '/v1/chat/completions')).toBe('openAiChat');
    expect(endpointName('POST', '/chat/completions')).toBe('openAiChat');
    expect(endpointName('POST', '/v1/messages')).toBe('anthropicMessages');
    expect(endpointName('POST', '/v1/messages/count_tokens')).toBe('anthropicCount');
    expect(endpointName('POST', '/v1/responses/compact')).toBe('openAiCompact');
  });

  it('tells routes sharing a path apart by method', () => {
    expect(endpointName('POST', '/v1/responses')).toBe('openAiResponses');
    expect(endpointName('GET', '/v1/responses')).toBe('openAiResponsesWs');
    expect(endpointName('GET', '/v1beta/models/gemini-2.5-pro')).toBe('geminiModel');
  });

  it('reads a Gemini endpoint from its action, ignoring the query', () => {
    expect(endpointName('POST', '/v1beta/models/gemini-2.5-pro:generateContent')).toBe('geminiGenerateContentGenerate');
    expect(endpointName('POST', '/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse')).toBe('geminiGenerateContentStream');
    expect(endpointName('POST', '/v1/models/gemini-2.5-pro:countTokens')).toBe('geminiGenerateContentCount');
  });

  it('names a Codex-addressed route after its public twin', () => {
    expect(endpointName('POST', '/azure-api.codex/responses')).toBe('openAiResponses');
    expect(endpointName('GET', '/azure-api.codex/models')).toBe('modelList');
  });

  it('names nothing for a path no public route serves', () => {
    expect(endpointName('POST', '/v1/unknown')).toBeNull();
    expect(endpointName('GET', '/v1/chat/completions')).toBeNull();
    expect(endpointName('POST', '/v1beta/models/gemini-2.5-pro:embedContent')).toBeNull();
  });
});
