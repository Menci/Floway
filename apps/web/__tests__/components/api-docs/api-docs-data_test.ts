import { describe, expect, it } from 'vitest';

import { apiDocsEndpoints, apiDocsGroups, authCurlExample } from '../../../src/components/api-docs/api-docs-data';

describe('API Docs catalog', () => {
  it('keeps every endpoint row unique and every group visible', () => {
    const identities = apiDocsEndpoints.map(endpoint => `${endpoint.method} ${endpoint.path}`);
    expect(new Set(identities).size).toBe(identities.length);
    expect(apiDocsGroups).toEqual(['models', 'generation', 'media', 'rerank', 'search', 'codex']);
  });

  it('covers the complete public data-plane surface', () => {
    const identities = apiDocsEndpoints.map(endpoint => `${endpoint.method} ${endpoint.path}`).toSorted();
    expect(identities).toEqual([
      'GET /azure-api.codex/models',
      'GET /azure-api.codex/responses',
      'GET /models',
      'GET /responses',
      'GET /v1/models',
      'GET /v1/responses',
      'GET /v1beta/models',
      'GET /v1beta/models/{model}',
      'POST /alpha/search',
      'POST /azure-api.codex/alpha/search',
      'POST /azure-api.codex/images/edits',
      'POST /azure-api.codex/images/generations',
      'POST /azure-api.codex/responses',
      'POST /azure-api.codex/responses/compact',
      'POST /chat/completions',
      'POST /completions',
      'POST /embeddings',
      'POST /images/edits',
      'POST /images/generations',
      'POST /jina/v1/rerank',
      'POST /messages',
      'POST /messages/count_tokens',
      'POST /responses',
      'POST /responses/compact',
      'POST /v1/alpha/search',
      'POST /v1/audio/transcriptions',
      'POST /v1/chat/completions',
      'POST /v1/completions',
      'POST /v1/embeddings',
      'POST /v1/images/edits',
      'POST /v1/images/generations',
      'POST /v1/messages',
      'POST /v1/messages/count_tokens',
      'POST /v1/rerank',
      'POST /v1/responses',
      'POST /v1/responses/compact',
      'POST /v1beta/models/{model}:countTokens',
      'POST /v1beta/models/{model}:generateContent',
      'POST /v1beta/models/{model}:streamGenerateContent',
      'POST /v2/rerank',
      'POST /voyage/v1/rerank',
    ].toSorted());
  });

  it('renders a paste-ready authentication command', () => {
    expect(authCurlExample('https://floway.example')).toBe(
      'curl "https://floway.example/v1/models" \\\n  -H "Authorization: Bearer $FLOWAY_API_KEY"',
    );
  });
});
