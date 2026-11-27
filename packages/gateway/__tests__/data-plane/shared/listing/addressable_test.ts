import { describe, expect, test } from 'vitest';

import { loadAddressableSurfaces } from '../../../../src/data-plane/shared/listing/addressable.ts';
import { saveUpstreamForTest } from '../../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, setupAppTest, testAdminUser, warmModelsForTest } from '../../../test-utils/app.ts';
import { jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const enumerateAddressableModelIds = async (
  upstreamFilter: readonly string[] | null,
) => (await loadAddressableSurfaces(testAdminUser, upstreamFilter)).callerAddressable;

describe('enumerateAddressableModelIds', () => {
  test('emits the addressable-only prefix form whenever modelPrefix.addressable ⊋ modelPrefix.listed', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
      id: 'up_custom_prefixed',
      // Listed only as `cust/gpt-5.4`, but the bare `gpt-5.4` form remains
      // addressable for clients that still talk to the upstream by its raw
      // public id.
      modelPrefix: { prefix: 'cust/', addressable: ['unprefixed', 'prefixed'], listed: ['prefixed'] },
    }));

    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({ object: 'list', data: [{ id: 'gpt-5.4', supported_endpoints: ['/chat/completions'] }] });
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        await warmModelsForTest();
        const surface = await enumerateAddressableModelIds(null);
        const byId = new Map(surface.map(e => [e.id, e]));
        expect(byId.get('cust/gpt-5.4')?.unlisted).toBeUndefined();
        expect(byId.get('gpt-5.4')?.unlisted).toBe(true);
        // Both forms share the same merged capability metadata while each
        // carries its own addressable id.
        const bare = byId.get('gpt-5.4')?.model;
        const prefixed = byId.get('cust/gpt-5.4')?.model;
        expect(bare?.id).toBe('gpt-5.4');
        expect(prefixed?.id).toBe('cust/gpt-5.4');
        expect({ ...bare, id: 'cust/gpt-5.4', display_name: prefixed?.display_name }).toStrictEqual(prefixed);
      },
    );
  });

  test('keeps an entirely unlisted model addressable from its cached metadata', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
      modelPrefix: { prefix: 'private/', addressable: ['unprefixed', 'prefixed'], listed: [] },
    }));

    await withMockedFetch(
      () => jsonResponse({ object: 'list', data: [{ id: 'hidden-model', supported_endpoints: ['/chat/completions'] }] }),
      async () => {
        await warmModelsForTest();
        const surface = await enumerateAddressableModelIds(null);
        expect(surface.map(entry => ({ id: entry.id, unlisted: entry.unlisted }))).toEqual([
          { id: 'hidden-model', unlisted: true },
          { id: 'private/hidden-model', unlisted: true },
        ]);
        expect(surface[0]?.contributions.map(c => c.upstream.id)).toEqual(['up_custom']);
      },
    );
  });

  test('merges unlisted addressable contributions from upstreams sharing an id', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    const first = buildCustomUpstreamRecord({
      id: 'up_first',
      modelPrefix: { prefix: 'private/', addressable: ['unprefixed', 'prefixed'], listed: [] },
    });
    const second = buildCustomUpstreamRecord({
      id: 'up_second',
      modelPrefix: { prefix: 'private/', addressable: ['unprefixed', 'prefixed'], listed: [] },
      config: { ...first.config as object, baseUrl: 'https://second.example.com', endpoints: { openaiEmbeddings: {} } },
    });
    await saveUpstreamForTest(repo.upstreams, first);
    await saveUpstreamForTest(repo.upstreams, second);

    await withMockedFetch(
      request => jsonResponse({
        object: 'list',
        data: [{ id: 'shared', kind: new URL(request.url).hostname === 'second.example.com' ? 'embedding' : 'chat' }],
      }),
      async () => {
        await warmModelsForTest();
        const surface = await enumerateAddressableModelIds(null);
        expect(surface.map(entry => entry.id)).toEqual(['shared', 'private/shared']);
        for (const entry of surface) {
          expect(entry.unlisted).toBe(true);
          expect(entry.upstreams.map(upstream => upstream.id)).toEqual(['up_first', 'up_second']);
          expect(entry.contributions.map(c => c.upstream.id)).toEqual(['up_first', 'up_second']);
          expect(entry.model.endpoints).toMatchObject({ openaiChatCompletions: {}, openaiEmbeddings: {} });
          expect(entry.model.kind).toBe('embedding');
        }
      },
    );
  });
});
