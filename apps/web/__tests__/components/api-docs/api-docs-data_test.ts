import { describe, expect, it } from 'vitest';

import { apiDocsEndpoints, apiDocsGroups, authCurlExample } from '../../../src/components/api-docs/api-docs-data';

describe('API Docs catalog', () => {
  it('keeps every endpoint row unique and every group visible', () => {
    const identities = apiDocsEndpoints.map(endpoint => `${endpoint.method} ${endpoint.path}`);
    expect(new Set(identities).size).toBe(identities.length);
    expect(apiDocsGroups).toEqual(['models', 'generation', 'media', 'rerank', 'search', 'codex']);
  });

  it('ships the canonical endpoints that were absent from the old index', () => {
    const paths = new Set(apiDocsEndpoints.map(endpoint => endpoint.path));
    for (const path of [
      '/v1/completions',
      '/v1/audio/transcriptions',
      '/v1beta/models',
      '/v2/rerank',
      '/jina/v1/rerank',
      '/voyage/v1/rerank',
      '/alpha/search',
      '/azure-api.codex/responses',
    ] as const) expect(paths.has(path)).toBe(true);
  });

  it('renders a paste-ready authentication command', () => {
    expect(authCurlExample('https://floway.example')).toBe(
      'curl "https://floway.example/v1/models" \\\n  -H "Authorization: Bearer $FLOWAY_API_KEY"',
    );
  });
});
