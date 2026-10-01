import { test } from 'vitest';

import { CLAUDE_AGENT_USER_AGENT, clearInProcessCopilotTokenCache } from '../../../src/auth.ts';
import { createCopilotProvider } from '../../../src/provider.ts';
import { emptyCopilotUpstreamState } from '../../../src/state.ts';
import { initProviderRepo, type UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, collectChatProviderPipeline, noopAnthropicMessagesUpstreamCallOptions, sseResponse, stubProviderModel, withMockedFetch } from '@floway-dev/test-utils';

const compactText = 'Your task is to create a detailed summary of the conversation so far.\n\nCRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\nPending Tasks:\n- finish refactor\n\nCurrent Work:\n- reviewing diff';

test('Claude Code compact intent, identity and interaction metadata reach the final Copilot wire in stage order', async () => {
  clearInProcessCopilotTokenCache();
  const record: UpstreamRecord = { id: 'up_header_stages', kind: 'copilot', name: 'Test', enabled: true, sortOrder: 0, createdAt: '', updatedAt: '', config: { githubHost: 'github.com', githubToken: 'test-token', user: { id: 1, login: 'test', name: null, avatar_url: '' } }, state: { ...emptyCopilotUpstreamState(), copilotToken: { token: 'access-token', expiresAt: 4102444800, baseUrl: 'https://copilot.example' } }, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], modelPrefix: null, modelsCache: null, hue: 210 };
  initProviderRepo(() => ({ upstreams: { getById: async () => record, saveState: async () => {} } }));
  const provider = createCopilotProvider(record);
  const model = stubProviderModel({ id: 'claude-test', providerData: { rawModels: [{ id: 'claude-test', supported_endpoints: ['/v1/messages'] }] } });
  let observed: Headers | undefined;
  await withMockedFetch(request => {
    observed = request.headers;
    return sseResponse('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  }, async () => {
    await collectChatProviderPipeline(provider, 'anthropicMessages', model, { max_tokens: 10, metadata: { user_id: JSON.stringify({ device_id: 'dev-1', session_id: 'sess-1' }) }, messages: [{ role: 'user', content: compactText }] }, undefined, noopAnthropicMessagesUpstreamCallOptions());
  });
  if (observed === undefined) throw new Error('Expected model endpoint dispatch');
  assertEquals(observed.get('x-initiator'), 'user');
  assertEquals(observed.get('x-interaction-type'), 'messages-proxy');
  assertEquals(observed.get('openai-intent'), 'messages-proxy');
  assertEquals(observed.get('user-agent'), CLAUDE_AGENT_USER_AGENT);
  assertEquals(observed.get('copilot-integration-id'), null);
  assertEquals(observed.get('x-interaction-id'), 'abe633f3-a47a-4758-974e-abe9160daf36');
});
