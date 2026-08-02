import { describe, expect, it } from 'vitest';

import { apiDocsEndpoints, apiDocsGroups, authCurlExample } from '../../../src/components/api-docs/data';
import { PUBLIC_DATA_PLANE_ROUTES } from '@floway-dev/protocols/common';

describe('API Docs catalog', () => {
  it('keeps every endpoint row unique and every group visible', () => {
    const identities = apiDocsEndpoints.map(endpoint => `${endpoint.method} ${endpoint.path}`);
    expect(new Set(identities).size).toBe(identities.length);
    expect(apiDocsGroups).toEqual(['models', 'generation', 'media', 'rerank', 'search']);
  });

  it('covers every reference route and groups compatibility aliases', () => {
    const referenceRoutes = Object.keys(PUBLIC_DATA_PLANE_ROUTES).filter(route => !route.startsWith('codex'));
    expect([...new Set(apiDocsEndpoints.map(endpoint => endpoint.route))].toSorted())
      .toEqual(referenceRoutes.toSorted());

    for (const [route, manifest] of Object.entries(PUBLIC_DATA_PLANE_ROUTES)) {
      const documented = apiDocsEndpoints.filter(endpoint => endpoint.route === route);
      if (route.startsWith('codex')) {
        expect(documented).toHaveLength(0);
        continue;
      }
      expect(documented.every(endpoint => endpoint.method === manifest.method)).toBe(true);
      expect(documented).toHaveLength(route === 'geminiAction' ? 3 : 1);
      if (manifest.paths.length > 1) expect(documented[0].path).toBe(manifest.paths.join(', '));
    }
  });

  it('renders a paste-ready authentication command', () => {
    // One line: a continuation is a thing to get wrong when the command is
    // pasted somewhere that does not honour it.
    expect(authCurlExample('https://floway.example')).toBe(
      'curl "https://floway.example/v1/models" -H "Authorization: Bearer $FLOWAY_API_KEY"',
    );
  });
});
