import { test } from 'vitest';

import type { ResponsesInvocation } from './types.ts';
import { withCodexUltraEffortRedirected } from './codex-ultra-redirect.ts';
import { mockChatGatewayCtx } from '../../../../test-helpers/gateway-ctx.ts';
import { doneFrame } from '@floway-dev/protocols/common';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const proactive = '<multi_agent_mode>Proactive multi-agent delegation is active. Use sub-agents when useful.</multi_agent_mode>';

const invocation = (action: 'generate' | 'compact' = 'generate'): ResponsesInvocation => ({
  payload: {
    model: 'model-a',
    input: [{ type: 'message', role: 'developer', content: proactive }],
    reasoning: { effort: 'max', summary: 'detailed' },
  },
  candidate: stubModelCandidate(),
  targetApi: 'responses',
  headers: new Headers(),
  action,
});

const run = () => Promise.resolve(eventResult((async function* () { yield doneFrame(); })(), testTelemetryModelIdentity));

test('Codex source context redirects Ultra while preserving reasoning siblings', async () => {
  const input = invocation();
  await withCodexUltraEffortRedirected(input, mockChatGatewayCtx({ codexUltraRedirectEffort: 'low' }), run);
  assertEquals(input.payload.reasoning, { effort: 'low', summary: 'detailed' });
});

test('ordinary Responses source context leaves max untouched', async () => {
  const input = invocation();
  await withCodexUltraEffortRedirected(input, mockChatGatewayCtx(), run);
  assertEquals(input.payload.reasoning, { effort: 'max', summary: 'detailed' });
});

test('native compact action never applies the Ultra redirect', async () => {
  const input = invocation('compact');
  await withCodexUltraEffortRedirected(input, mockChatGatewayCtx({ codexUltraRedirectEffort: 'low' }), run);
  assertEquals(input.payload.reasoning, { effort: 'max', summary: 'detailed' });
});
