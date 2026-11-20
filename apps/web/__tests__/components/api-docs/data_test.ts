import { describe, expect, it } from 'vitest';

import { apiDocsEndpoints } from '../../../src/components/api-docs/data';
import { PUBLIC_DATA_PLANE_ROUTES } from '@floway-dev/protocols/browser';

describe('API Docs catalog', () => {
  it('covers every reference route and groups compatibility aliases', () => {
    const referenceRoutes = Object.keys(PUBLIC_DATA_PLANE_ROUTES).filter(route => !route.startsWith('codex'));
    expect([...new Set(apiDocsEndpoints.map(endpoint => endpoint.route))].toSorted())
      .toEqual(referenceRoutes.toSorted());

    // The docs table replaces route parameters with the brace form callers
    // read, and spells the fan-out Gemini action as `{model}:<action>`. Mapping
    // a manifest path through the same substitution is what lets the coverage
    // check compare the two spellings without restating the table.
    const displayPath = (path: string): string => path
      .replace(':modelAction{.+}', '{model}:generateContent')
      .replace(':modelId{.+}', '{model}');

    for (const [route, manifest] of Object.entries(PUBLIC_DATA_PLANE_ROUTES)) {
      const documented = apiDocsEndpoints.filter(endpoint => endpoint.route === route);
      if (route.startsWith('codex')) {
        expect(documented).toHaveLength(0);
        continue;
      }
      expect(documented.every(endpoint => endpoint.method === manifest.method)).toBe(true);
      expect(documented).toHaveLength(route === 'geminiGenerateContentAction' ? 3 : 1);
      if (manifest.paths.length > 1) expect(documented[0].path).toBe(manifest.paths.map(displayPath).join(', '));
    }
  });
});
