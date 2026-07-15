import { test } from 'vitest';

import { DEFAULT_SEARCH_CONFIG } from '../../data-plane/tools/web-search/search-config.ts';
import { requestApp, setupAppTest } from '../../test-helpers.ts';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

test('/api/search-config GET returns the default disabled config for admin', async () => {
  const { adminSession } = await setupAppTest();

  const response = await requestApp('/api/search-config', {
    headers: { 'x-floway-session': adminSession },
  });

  assertEquals(response.status, 200);
  assertEquals(await response.json(), DEFAULT_SEARCH_CONFIG);
});

test('/api/search-config PUT persists config and POST /test returns preview', async () => {
  const { adminSession } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'api.tavily.com') {
        return jsonResponse({
          results: [
            {
              title: 'React',
              url: 'https://react.dev',
              content: 'Official docs',
            },
            {
              title: 'React Learn',
              url: 'https://react.dev/learn',
              content: 'Learn React',
            },
            {
              title: 'React API',
              url: 'https://react.dev/reference',
              content: 'React API reference',
            },
            {
              title: 'Extra',
              url: 'https://example.com/extra',
              content: 'should be trimmed',
            },
          ],
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const config = {
        provider: 'tavily',
        tavily: { apiKey: 'tvly-test' },
        microsoftGrounding: { apiKey: 'ms-test' },
        jina: { apiKey: 'jina-test' },
        passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
      };

      const putResponse = await requestApp('/api/search-config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
        body: JSON.stringify(config),
      });
      assertEquals(putResponse.status, 200);

      const testResponse = await requestApp('/api/search-config/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
        body: JSON.stringify(config),
      });

      const body = await testResponse.json();
      assertEquals(testResponse.status, 200);
      assertEquals(body.ok, true);
      assertEquals(body.query, 'React documentation');
      assertEquals(body.results.length, 3);
    },
  );
});
