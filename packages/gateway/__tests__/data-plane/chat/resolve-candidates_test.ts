import { expect, test, vi } from 'vitest';

import type { ChatFacts } from '../../../src/data-plane/chat/facts.ts';
import { resolveChatCandidates } from '../../../src/data-plane/chat/resolve-candidates.ts';
import { createCandidateRegistry } from '../../../src/data-plane/pipeline/candidates.ts';
import { enumerateModelCandidates } from '../../../src/data-plane/providers/resolution.ts';
import { mockChatGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { compose, defineStage, move, run } from '@floway-dev/pipeline';
import { stubModelCandidate } from '@floway-dev/test-utils';

vi.mock('../../../src/data-plane/providers/resolution.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/data-plane/providers/resolution.ts')>()),
  enumerateModelCandidates: vi.fn(),
}));

test('resolution publishes pure candidate request projections without provider handles or dispatching an untried candidate', async () => {
  const first = stubModelCandidate();
  const second = stubModelCandidate({ model: { id: 'second' } });
  const unsupported = stubModelCandidate({ model: { id: 'unsupported', endpoints: {} } });
  const payload = { model: 'model', messages: [{ role: 'user' as const, content: 'question' }] };
  const changed = { ...payload, messages: [{ role: 'user' as const, content: 'projected' }] };
  const projectFirst = vi.fn(() => payload);
  const projectSecond = vi.fn(() => changed);
  const evaluated: unknown[] = [];
  vi.mocked(enumerateModelCandidates).mockResolvedValue({ candidates: [first, second, unsupported], sawModel: true, failedUpstreams: [] });
  const resolver = resolveChatCandidates({
    requestKey: 'request.chat.openaiChatCompletions',
    canServe: candidate => candidate !== unsupported,
    affinity: async actual => {
      expect(actual).toBe(payload);
      return {
        requiredTargets: [],
        evaluateCandidate: candidate => {
          evaluated.push(candidate);
          return { kind: 'accepted', degrades: false, preferred: true, materialize: candidate === first ? projectFirst : projectSecond };
        },
      };
    },
    unsupported: model => model,
    refuse: () => ({}),
    refuses: [],
  });
  const dispatch = vi.fn();
  const terminal = defineStage<Record<string, unknown>, Record<string, unknown>>({
    name: 'observeResolution',
    return: { provides: ['response.usage.billable', 'response.http.headers', 'response.http.status', 'response.http.body'] },
    execute: async facts => move({ ...facts, 'response.usage.billable': [], 'response.http.headers': [], 'response.http.status': 200, 'response.http.body': null }),
  });
  const registry = createCandidateRegistry();
  const outcome = await run(compose<{ 'serve.model': string } & Pick<ChatFacts, 'request.chat.openaiChatCompletions'>, Record<string, unknown>>('resolve', [resolver, terminal]), move({
    'serve.model': 'model', 'request.chat.openaiChatCompletions': payload,
  }), { gateway: mockChatGatewayCtx(), ...registry, httpCall: dispatch });
  const values = outcome.facts['request.chat.candidatePayloads'] as Readonly<Record<number, unknown>>;
  expect(values[0]).toBe(payload);
  expect(values[1]).toBe(changed);
  expect(Object.keys(values)).toEqual(['0', '1']);
  expect(Object.isFrozen(values)).toBe(true);
  expect(Object.isFrozen(first.provider.instance)).toBe(false);
  expect(evaluated).toEqual([first, second]);
  expect(projectFirst).toHaveBeenCalledTimes(1);
  expect(projectSecond).toHaveBeenCalledTimes(1);
  expect(dispatch).not.toHaveBeenCalled();
  await outcome.drain();
});
