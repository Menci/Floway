import { describe, expect, test } from 'vitest';

import { enumerateAddressableModelIds } from '../../../../src/data-plane/shared/listing/addressable.ts';
import { buildCustomUpstreamRecord, setupAppTest } from '../../../test-utils/app.ts';
import { directFetcher } from '@floway-dev/provider';
import { jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const noBackground = (promise: Promise<unknown>): void => {
  promise.catch(err => console.error('[background]', err));
};

describe('enumerateAddressableModelIds', () => {
  test('returns the listed catalog as listed entries when no provider contributes addressable-only forms', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(buildCustomUpstreamRecord());
    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({ object: 'list', data: [{ id: 'shared-model', supported_endpoints: ['/chat/completions'] }] });
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        const surface = await enumerateAddressableModelIds(null, () => directFetcher, noBackground);
        expect(surface.map(e => ({ id: e.id, unlisted: e.unlisted }))).toEqual([
          { id: 'shared-model', unlisted: undefined },
        ]);
      },
    );
  });

  test('emits the addressable-only prefix form whenever modelPrefix.addressable ⊋ modelPrefix.listed', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(buildCustomUpstreamRecord({
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
        const surface = await enumerateAddressableModelIds(null, () => directFetcher, noBackground);
        const byId = new Map(surface.map(e => [e.id, e]));
        expect(byId.get('cust/gpt-5.4')?.unlisted).toBeUndefined();
        expect(byId.get('gpt-5.4')?.unlisted).toBe(true);
        // The addressable-only entry still resolves to the same `InternalModel`
        // as the canonical listed id, so consumers find one consistent row.
        expect(byId.get('gpt-5.4')?.model).toBe(byId.get('cust/gpt-5.4')?.model);
      },
    );
  });

  test('merges every upstream that converges on the same addressable-only id', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_messages',
      name: 'Messages',
      sortOrder: 1,
      config: {
        baseUrl: 'https://messages.example.com',
        authStyle: 'bearer',
        apiKey: 'sk-messages',
        endpoints: { messages: {} },
        ingressHeadersRules: [],
      },
      modelPrefix: { prefix: 'messages/', addressable: ['unprefixed', 'prefixed'], listed: ['prefixed'] },
    }));
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_responses',
      name: 'Responses',
      sortOrder: 2,
      config: {
        baseUrl: 'https://responses.example.com',
        authStyle: 'bearer',
        apiKey: 'sk-responses',
        endpoints: { responses: {} },
        ingressHeadersRules: [],
      },
      modelPrefix: { prefix: 'responses/', addressable: ['unprefixed', 'prefixed'], listed: ['prefixed'] },
    }));
    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if ((url.hostname === 'messages.example.com' || url.hostname === 'responses.example.com') && url.pathname === '/v1/models') {
          return jsonResponse({ object: 'list', data: [{ id: 'shared-model' }] });
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        const surface = await enumerateAddressableModelIds(null, () => directFetcher, noBackground);
        const shared = surface.find(entry => entry.id === 'shared-model');
        expect(shared?.unlisted).toBe(true);
        expect(shared?.upstreams.map(upstream => upstream.upstreamId)).toEqual(['up_messages', 'up_responses']);
        expect(shared?.model.endpoints).toEqual({ messages: {}, responses: {} });
        expect(Object.keys(shared?.model.providerModels ?? {})).toEqual(['up_messages', 'up_responses']);
      },
    );
  });

  test('throws "no upstream configured" when the upstream cap is empty — surfacing the same hint /v1/models has always raised', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await expect(enumerateAddressableModelIds(null, () => directFetcher, noBackground))
      .rejects.toThrow('No upstream provider configured');
  });
});
