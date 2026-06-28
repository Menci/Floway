import { test } from 'vitest';

import { planChatCompletionsRouting } from './routing.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { createStoredResponsesItemId } from '../responses/items/format.ts';
import { createNonResponsesSourceStore } from '../responses/items/store.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ProviderCandidate } from '@floway-dev/provider';
import { directFetcher } from '@floway-dev/provider';
import { stubProvider, stubUpstreamModel, assertEquals } from '@floway-dev/test-utils';

const API_KEY_ID = 'key_chat_completions_routing_test';

const candidateFor = (upstream: string): ProviderCandidate => {
  const upstreamModel = stubUpstreamModel();
  const modelProvider = stubProvider({
    getProvidedModels: () => Promise.resolve([upstreamModel]),
  });
  return {
    provider: {
      upstream, providerKind: 'custom', name: upstream,
      disabledPublicModelIds: [], modelPrefix: null, provider: modelProvider,
      supportsResponsesItemReference: true,
    },
    model: upstreamModel,
    fetcher: directFetcher,
  };
};

const installRepo = (): void => {
  const repo = new InMemoryRepo();
  initRepo(repo);
};

const payload = (messages: ChatCompletionsPayload['messages']): ChatCompletionsPayload => ({
  model: 'stub-model',
  messages,
});

test('chat-completions payload with no reasoning carriers passes candidates through unchanged', async () => {
  installRepo();
  const candidates = [candidateFor('up_a'), candidateFor('up_b')];

  const decision = await planChatCompletionsRouting({
    payload: payload([{ role: 'user', content: 'hello' }]),
    candidates,
    store: createNonResponsesSourceStore(API_KEY_ID),
  });

  assertEquals(decision.kind, 'success');
  if (decision.kind === 'success') {
    assertEquals(decision.candidates.length, candidates.length);
    assertEquals(decision.candidates.map(c => c.provider.upstream), ['up_a', 'up_b']);
  }
});

test('an assistant reasoning_items carrier naming an unknown stored id fails routing as item-not-found', async () => {
  installRepo();
  const reasoningId = createStoredResponsesItemId('reasoning');

  const decision = await planChatCompletionsRouting({
    payload: payload([
      {
        role: 'assistant',
        content: null,
        reasoning_items: [{ type: 'reasoning', id: reasoningId, summary: [{ type: 'summary_text', text: 't' }] }],
      },
    ]),
    candidates: [candidateFor('up_a')],
    store: createNonResponsesSourceStore(API_KEY_ID),
  });

  assertEquals(decision.kind, 'failure');
  if (decision.kind === 'failure') {
    assertEquals(decision.failure.kind, 'item-not-found');
  }
});
