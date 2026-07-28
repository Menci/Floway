import { describe, expect, it } from 'vitest';

import { apiDocsEndpoints, apiDocsGroups, authCurlExample } from '../../../src/components/api-docs/api-docs-data';
import { PUBLIC_DATA_PLANE_ROUTES } from '@floway-dev/protocols/common';

describe('API Docs catalog', () => {
  it('keeps every endpoint row unique and every group visible', () => {
    const identities = apiDocsEndpoints.map(endpoint => `${endpoint.method} ${endpoint.path}`);
    expect(new Set(identities).size).toBe(identities.length);
    expect(apiDocsGroups).toEqual(['models', 'generation', 'media', 'rerank', 'search', 'codex']);
  });

  it('covers every registered public route', () => {
    expect([...new Set(apiDocsEndpoints.map(endpoint => endpoint.route))].toSorted())
      .toEqual(Object.keys(PUBLIC_DATA_PLANE_ROUTES).toSorted());

    for (const [route, manifest] of Object.entries(PUBLIC_DATA_PLANE_ROUTES)) {
      const documented = apiDocsEndpoints.filter(endpoint => endpoint.route === route);
      expect(documented.every(endpoint => endpoint.method === manifest.method)).toBe(true);
      expect(documented).toHaveLength(route === 'geminiAction' ? 3 : manifest.paths.length);
    }
  });

  it('renders a paste-ready authentication command', () => {
    expect(authCurlExample('https://floway.example')).toBe(
      'curl "https://floway.example/v1/models" \\\n  -H "Authorization: Bearer $FLOWAY_API_KEY"',
    );
  });
});
